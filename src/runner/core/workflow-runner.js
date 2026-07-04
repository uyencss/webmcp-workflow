/**
 * @module core/workflow-runner
 * @description Orchestrates workflow execution: validates, iterates steps,
 * delegates to strategies, manages retries/guards/routing, and emits events.
 *
 * The runner is an EventEmitter that progresses through a normalized workflow's
 * steps sequentially (with optional branching via onSuccess/onFailure routes).
 * Each step is delegated to one of three execution paths:
 *
 * 1. **ai-vision strategy** — keyword-scores interactive elements and clicks
 *    the best match by coordinate.
 * 2. **aria-ref strategy** — captures an ARIA snapshot, scores entries, and
 *    dispatches the appropriate `*ByRef` command.
 * 3. **Generic passthrough** — forwards any WebMCP command + params to the
 *    gateway as-is (covers page, cdp, input, control, observability, etc.).
 *
 * Entry points:
 * - `new WorkflowRunner(workflow, options).run()` — full control.
 * - `runWorkflow(workflow, vars, options)` — convenience wrapper.
 */

const { EventEmitter } = require('events');
const { sendCommand: defaultSendCommand } = require('./transport');
const { WorkflowContext } = require('../pipeline/workflow-context');
const { normalizeWorkflow } = require('../pipeline/workflow-normalizer');
const { validateWorkflow } = require('../pipeline/workflow-validator');
const { createEventFactory } = require('./runner-events');
const { RunnerError, normalizeError, errorToJSON } = require('../shared/errors');

/* ── Strategy helpers (extracted to strategies/) ───────── */
const { keywordTokens, scoreInteractiveElement } = require('../strategies/ai-vision');
const { ARIA_ACTION_COMMANDS, parseAriaSnapshot, scoreAriaEntry } = require('../strategies/aria-ref');

/* ═══════════════════════════════════════════════════════════
 *  Constants
 * ═══════════════════════════════════════════════════════════ */

/**
 * Commands that do not require an active tab id to be injected.
 * These are either tab-management commands or runner-internal pseudo commands.
 *
 * @type {Set<string>}
 */
const COMMANDS_WITHOUT_ACTIVE_TAB = new Set([
  'listTabs',
  'newTab',
  'getActiveTab',
  'listWindows',
  'createWindow',
  'ping',
  'wait',
  'delay',
]);

/* ═══════════════════════════════════════════════════════════
 *  Run ID & builtins
 * ═══════════════════════════════════════════════════════════ */

/**
 * Generate a unique run id from the workflow id and a timestamp+random suffix.
 *
 * @param {string} [workflowId] - The workflow's id (sanitized to alphanumeric).
 * @returns {string} A run id like `"my-workflow-lx3k4f-ab12cd"`.
 */
function generateRunId(workflowId) {
  const safeWorkflowId = String(workflowId || 'workflow').replace(/[^a-zA-Z0-9_.-]/g, '-');
  return `${safeWorkflowId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build the initial set of builtin variables injected into every run's context.
 *
 * @param {Object}       workflow - The normalized workflow.
 * @param {string}       runId    - The generated run id.
 * @param {string|null}  tabId    - The initial active tab id, if any.
 * @returns {Object} Builtin variable map.
 */
function makeBuiltins(workflow, runId, tabId) {
  return {
    __TIMESTAMP__: Date.now().toString(),
    __DATE__: new Date().toISOString().slice(0, 10),
    __WORKFLOW_ID__: workflow.id || 'unknown',
    __RUN_ID__: runId,
    __ACTIVE_TAB_ID__: tabId ?? '',
  };
}

/* ═══════════════════════════════════════════════════════════
 *  Timing & retry
 * ═══════════════════════════════════════════════════════════ */

/**
 * Promise-based sleep that respects an AbortSignal.
 *
 * @param {number}      ms     - Milliseconds to wait.
 * @param {AbortSignal} [signal] - If aborted, the sleep rejects immediately.
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(normalizeError(signal.reason || new RunnerError('Workflow aborted', { code: 'ABORTED' })));
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(normalizeError(signal.reason || new RunnerError('Workflow aborted', { code: 'ABORTED' })));
    };

    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Calculate exponential backoff delay for a given failed attempt.
 *
 * @param {Object} retryPolicy   - The step or workflow retry policy.
 * @param {number} failedAttempt - 1-based attempt number that just failed.
 * @returns {number} Delay in ms, capped at `retryPolicy.maxBackoffMs`.
 */
function calculateBackoff(retryPolicy, failedAttempt) {
  const base = retryPolicy.backoffMs || 0;
  const cap = retryPolicy.maxBackoffMs ?? base;
  const delay = base * (2 ** Math.max(0, failedAttempt - 1));
  return Math.min(delay, cap);
}

/**
 * Decide whether a failed step should be retried.
 *
 * @param {RunnerError} error       - The error from the failed attempt.
 * @param {Object}      retryPolicy - The applicable retry policy.
 * @param {number}      attempt     - The attempt number that just failed.
 * @returns {boolean} `true` if another attempt should be made.
 */
function shouldRetry(error, retryPolicy, attempt) {
  if (attempt >= retryPolicy.maxAttempts) return false;
  if (Array.isArray(retryPolicy.retryOn) && retryPolicy.retryOn.length > 0) {
    return retryPolicy.retryOn.includes(error.code);
  }
  return true;
}

/* ═══════════════════════════════════════════════════════════
 *  Result extraction
 * ═══════════════════════════════════════════════════════════ */

/**
 * Extract the meaningful value from a command result for `captureAs`.
 *
 * Tries WebMCP content-array parsing first, then falls back to `result.result`,
 * then returns the raw result.
 *
 * @param {*} result - The raw result from `sendGatewayCommand`.
 * @returns {*} The extracted capture value.
 */
function extractCaptureValue(result) {
  const parsedWebMcpPayload = parseWebMcpPayload(result);
  if (parsedWebMcpPayload !== undefined) return parsedWebMcpPayload;

  if (
    result &&
    typeof result === 'object' &&
    Object.prototype.hasOwnProperty.call(result, 'result')
  ) {
    return result.result;
  }
  return result;
}

/**
 * Try to parse a WebMCP-style content payload (array of `{ type, text }` items).
 *
 * @param {*} result - Command result that may contain a `content` array.
 * @returns {*} Parsed JSON or raw text from the first text content item, or `undefined`.
 */
function parseWebMcpPayload(result) {
  const content = result?.result?.content || result?.content;
  const text = Array.isArray(content) ? content.find((item) => item?.type === 'text')?.text : undefined;
  if (typeof text !== 'string') return undefined;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Routing
 * ═══════════════════════════════════════════════════════════ */

/**
 * Find the index of a step by its id, for onSuccess/onFailure routing.
 *
 * @param {Object[]} steps        - The workflow's steps array.
 * @param {string}   targetStepId - The step id to find.
 * @returns {number|null} Zero-based index, or `null` if not found.
 */
function pickRouteIndex(steps, targetStepId) {
  if (!targetStepId) return null;
  const index = steps.findIndex((step) => step.id === targetStepId);
  return index === -1 ? null : index;
}

/* ═══════════════════════════════════════════════════════════
 *  Guard evaluation helpers
 * ═══════════════════════════════════════════════════════════ */

/**
 * Build a JavaScript expression that checks for the presence of a target
 * element using a specified selector mode (css, id, aria-label, text, xpath).
 *
 * Used by `element-exists` and `element-absent` guards when `target` is
 * specified instead of a raw CSS `selector`.
 *
 * @param {{ mode: string, value: string }} target - The target descriptor.
 * @returns {string|null} A JS expression that evaluates to the element, or `null`.
 */
function targetPresenceExpression(target) {
  if (!target || !target.mode || target.value === undefined) return null;
  const value = JSON.stringify(target.value);

  switch (target.mode) {
    case 'css':
      return `document.querySelector(${value})`;
    case 'id':
      return `document.getElementById(${value})`;
    case 'aria-label':
      return `Array.from(document.querySelectorAll('[aria-label]')).find((el) => el.getAttribute('aria-label') === ${value})`;
    case 'text':
      return `Array.from(document.querySelectorAll('body *')).find((el) => ((el.innerText || el.textContent || '').trim()).includes(${value}))`;
    case 'xpath':
      return `document.evaluate(${value}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue`;
    default:
      return null;
  }
}

/* ═══════════════════════════════════════════════════════════
 *  WorkflowRunner class
 * ═══════════════════════════════════════════════════════════ */

/**
 * The main workflow execution engine.
 *
 * Extends EventEmitter and emits:
 * - `'start'`    — when the run begins (after validation).
 * - `'step'`     — on step started / completed / failed / skipped / retrying.
 * - `'progress'` — when a `captureAs` value is stored.
 * - `'recovery'` — when an onFailure route is taken.
 * - `'end'`      — when the run finishes (success, failure, or abort).
 * - `'event'`    — catch-all for every event above.
 *
 * @extends EventEmitter
 */
class WorkflowRunner extends EventEmitter {

  /* ── Constructor ─────────────────────────────────────── */

  /**
   * @param {Object} workflow    - Raw or normalized workflow definition.
   * @param {Object} [options={}]
   * @param {string} [options.runId]               - Custom run id (auto-generated if omitted).
   * @param {Object} [options.variables={}]         - Runtime variable overrides.
   * @param {boolean}[options.strictValidation]     - Strict template validation.
   * @param {boolean}[options.allowUnknownCommand]  - Allow passthrough commands.
   * @param {Function} [options.transport]          - Custom transport function (default: HTTP).
   * @param {string} [options.gatewayUrl]           - Gateway endpoint override.
   * @param {string} [options.profileId]            - Gateway profile id for multi-profile routing.
   * @param {number} [options.timeoutMs]            - Default command timeout override.
   * @param {string|null} [options.tabId]           - Initial active tab id.
   * @param {AbortSignal}  [options.signal]         - External abort signal.
   */
  constructor(workflow, options = {}) {
    super();

    const runId = options.runId || generateRunId(workflow?.id);
    this.workflow = normalizeWorkflow(workflow, {
      defaultTimeout: options.timeoutMs,
    });
    this.options = {
      ...options,
      runId,
      variables: options.variables || {},
      strictValidation: Boolean(options.strictValidation),
      allowUnknownCommand: Boolean(options.allowUnknownCommand),
    };
    this.transport = options.transport || defaultSendCommand;
    this.runId = runId;
    this.activeTabId = options.tabId ?? null;
    this.abortController = new AbortController();
    this.validation = null;
    this.state = {
      runId,
      workflowId: this.workflow.id,
      status: 'created',
      currentStepId: null,
      startedAt: null,
      endedAt: null,
      results: [],
    };

    this.context = new WorkflowContext(
      this.workflow.variables,
      this.options.variables,
      makeBuiltins(this.workflow, runId, this.activeTabId),
    );

    this.makeEvent = createEventFactory({
      runId,
      workflowId: this.workflow.id,
      getTabId: () => this.activeTabId ?? undefined,
    });

    if (options.signal?.aborted) {
      this.abort(options.signal.reason || 'External signal already aborted');
    } else if (options.signal) {
      options.signal.addEventListener('abort', () => {
        this.abort(options.signal.reason || 'External abort signal received');
      }, { once: true });
    }
  }

  /* ── Validation ──────────────────────────────────────── */

  /**
   * Run static validation on the workflow.
   * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
   */
  validate() {
    this.validation = validateWorkflow(this.workflow, {
      strict: this.options.strictValidation,
      allowUnknownCommand: this.options.allowUnknownCommand,
      runtimeVariables: this.options.variables,
    });
    return this.validation;
  }

  /* ── Abort ───────────────────────────────────────────── */

  /**
   * Abort the running workflow.  Idempotent — subsequent calls are no-ops.
   * @param {string|Error} [reason='Workflow aborted']
   */
  abort(reason = 'Workflow aborted') {
    if (this.abortController.signal.aborted) return;
    const error = reason instanceof Error
      ? normalizeError(reason)
      : new RunnerError(String(reason), { code: 'ABORTED' });
    this.abortController.abort(error);
  }

  /* ── State introspection ─────────────────────────────── */

  /**
   * Return a snapshot of the current run state.
   * @returns {Object}
   */
  getState() {
    return {
      ...this.state,
      activeTabId: this.activeTabId,
      validation: this.validation,
      context: this.context.serialize(),
    };
  }

  /* ── Event emission ──────────────────────────────────── */

  /**
   * Emit a typed runner event with a versioned envelope.
   *
   * @param {string} type       - Event type (e.g. 'step', 'start', 'end').
   * @param {Object} [payload]  - Event-specific data.
   * @returns {Object} The emitted event envelope.
   */
  emitRunnerEvent(type, payload = {}) {
    const event = this.makeEvent(type, payload);
    this.emit(type, event);
    this.emit('event', event);
    return event;
  }

  /* ── Main run loop ───────────────────────────────────── */

  /**
   * Execute the workflow from start to finish.
   *
   * Validates first, then iterates steps sequentially (with optional
   * branching).  Returns a run summary with status, results, and context.
   *
   * @returns {Promise<Object>} Run summary.
   */
  async run() {
    const startedAt = Date.now();
    this.state.status = 'running';
    this.state.startedAt = new Date(startedAt).toISOString();

    const validation = this.validate();
    this.emitRunnerEvent('start', {
      workflow: {
        id: this.workflow.id,
        name: this.workflow.name,
        version: this.workflow.version || '1.0',
      },
      totalSteps: Array.isArray(this.workflow.steps) ? this.workflow.steps.length : 0,
      settings: this.workflow.settings,
      warnings: validation.warnings,
    });

    if (!validation.valid) {
      const error = new RunnerError('Workflow validation failed', {
        code: 'VALIDATION_ERROR',
        details: validation.errors,
      });
      return this.finishRun(startedAt, 'failed', error);
    }

    const steps = this.workflow.steps;
    const maxTransitions = Math.max(steps.length * 20, 100);
    let currentIndex = 0;
    let transitions = 0;
    let fatalError = null;

    try {
      while (currentIndex !== null && currentIndex < steps.length) {
        this.checkAborted();
        transitions += 1;
        if (transitions > maxTransitions) {
          throw new RunnerError(`Workflow exceeded ${maxTransitions} route transitions`, {
            code: 'ROUTE_LOOP',
          });
        }

        const step = steps[currentIndex];
        this.state.currentStepId = step.id;
        const record = step.type === 'forEach'
          ? await this.executeForEachStep(step, currentIndex, steps.length)
          : await this.executeStep(step, currentIndex, steps.length);
        this.state.results.push(record);

        if (record.status === 'success') {
          currentIndex = this.resolveSuccessRoute(step, currentIndex);
          continue;
        }

        if (record.status === 'skipped') {
          currentIndex += 1;
          continue;
        }

        const failureRouteIndex = this.resolveFailureRoute(step, record.error);
        if (failureRouteIndex !== null) {
          this.emitRunnerEvent('recovery', {
            stepId: step.id,
            error: record.error,
            nextStepId: steps[failureRouteIndex].id,
          });
          currentIndex = failureRouteIndex;
          continue;
        }

        const canContinue = !step.critical && this.workflow.settings.continueOnNonCriticalFailure;
        if (canContinue) {
          currentIndex += 1;
          continue;
        }

        fatalError = record.error;
        break;
      }
    } catch (error) {
      fatalError = errorToJSON(error);
    }

    if (fatalError) {
      const code = fatalError.code || 'COMMAND_FAILED';
      const status = code === 'TIMEOUT' ? 'timed_out' : (code === 'ABORTED' ? 'aborted' : 'failed');
      return this.finishRun(startedAt, status, fatalError);
    }

    const failedSteps = this.state.results.filter((result) => result.status === 'failed');
    const status = failedSteps.length > 0 ? 'completed_with_errors' : 'completed';
    return this.finishRun(startedAt, status);
  }

  /* ── Run finalization ────────────────────────────────── */

  /**
   * Build the final run summary and emit the 'end' event.
   *
   * @param {number}      startedAt - Timestamp when the run began.
   * @param {string}      status    - Final status code.
   * @param {Object|Error} [error]  - The fatal error, if any.
   * @returns {Object} The run summary.
   */
  finishRun(startedAt, status, error) {
    const endedAt = Date.now();
    const results = this.state.results;
    const summary = {
      runId: this.runId,
      workflowId: this.workflow.id,
      workflowName: this.workflow.name,
      workflowVersion: this.workflow.version || '1.0',
      status,
      duration: endedAt - startedAt,
      stepsCompleted: results.filter((result) => result.status === 'success').length,
      stepsFailed: results.filter((result) => result.status === 'failed').length,
      stepsSkipped: results.filter((result) => result.status === 'skipped').length,
      stepsTotal: Array.isArray(this.workflow.steps) ? this.workflow.steps.length : 0,
      results,
      context: this.context.serialize(),
      warnings: this.validation?.warnings || [],
      ...(error ? { error: error.code ? error : errorToJSON(error) } : {}),
    };

    this.state.status = status;
    this.state.currentStepId = null;
    this.state.endedAt = new Date(endedAt).toISOString();
    this.emitRunnerEvent('end', summary);
    return summary;
  }

  /* ── Abort checking ──────────────────────────────────── */

  /**
   * Throw if the workflow has been aborted.
   * @throws {RunnerError} With code 'ABORTED'.
   */
  checkAborted() {
    if (!this.abortController.signal.aborted) return;
    throw normalizeError(this.abortController.signal.reason || new RunnerError('Workflow aborted', { code: 'ABORTED' }));
  }

  /* ── forEach step execution (body-1-step) ────────────── */

  /**
   * Execute a `type: "forEach"` step.  The loop body is the step's own
   * command/strategy, run once per item in `forEach.items` via the normal
   * {@link executeStep} path (so guard/retry/wait/capture apply per iteration).
   *
   * The current item is bound to `forEach.as` and the 0-based index to
   * `forEach.indexAs` (default `__INDEX__`) for the duration of each iteration.
   * When `collectAs` is set (and the step has `captureAs`), each iteration's
   * captured value is appended into an array published under `collectAs`.
   *
   * @param {Object} step       - The normalized forEach step.
   * @param {number} stepIndex  - Zero-based position.
   * @param {number} totalSteps - Total number of top-level steps.
   * @returns {Promise<Object>} Summary record (or the failing iteration record).
   */
  async executeForEachStep(step, stepIndex, totalSteps) {
    const startedAt = Date.now();
    const basePayload = { stepId: step.id, stepIndex, totalSteps, command: step.command, strategy: step.strategy };
    const config = this.context.interpolate(step.forEach || {});

    let items = config.items;
    if (typeof items === 'string') items = this.context.get(items);
    if (!Array.isArray(items)) {
      const error = new RunnerError('forEach.items must resolve to an array', { code: 'VALIDATION_ERROR' });
      return this.makeFailedStepRecord(step, basePayload, startedAt, 0, error);
    }

    const asName = config.as;
    const indexName = config.indexAs || '__INDEX__';

    this.emitRunnerEvent('step', {
      type: 'started',
      ...basePayload,
      forEach: { totalIterations: items.length, as: asName },
    });

    const body = { ...step, type: 'command' };
    delete body.forEach;

    const collected = [];
    const iterationResults = [];

    for (let i = 0; i < items.length; i++) {
      this.checkAborted();
      this.context.pushScope({ [asName]: items[i], [indexName]: i });

      let iterationRecord;
      try {
        const iterStep = { ...body, id: `${step.id}[${i}]` };
        iterationRecord = await this.executeStep(iterStep, stepIndex, totalSteps);
        iterationResults.push(iterationRecord);
        if (config.collectAs && step.captureAs && iterationRecord.status === 'success') {
          collected.push(this.context.get(step.captureAs));
        }
      } finally {
        this.context.popScope();
      }

      if (iterationRecord.status === 'failed' && step.critical !== false) {
        if (config.collectAs) this.context.setCaptured(config.collectAs, collected);
        const duration = Date.now() - startedAt;
        const record = {
          status: 'failed',
          ...basePayload,
          duration,
          iterations: i + 1,
          iterationResults,
          error: iterationRecord.error,
        };
        this.context.setStepResult(step.id, record);
        this.emitRunnerEvent('step', {
          type: 'failed',
          ...basePayload,
          duration,
          error: iterationRecord.error,
        });
        return record;
      }
    }

    if (config.collectAs) {
      this.context.setCaptured(config.collectAs, collected);
      this.emitRunnerEvent('progress', { stepId: step.id, captureAs: config.collectAs });
    }

    const duration = Date.now() - startedAt;
    const record = {
      status: 'success',
      ...basePayload,
      duration,
      iterations: items.length,
      iterationResults,
      ...(config.collectAs ? { collectAs: config.collectAs } : {}),
    };
    this.context.setStepResult(step.id, record);
    this.emitRunnerEvent('step', {
      type: 'completed',
      ...basePayload,
      duration,
      forEach: { iterations: items.length, collectAs: config.collectAs },
    });
    return record;
  }

  /* ── Step execution (with retry loop) ────────────────── */

  /**
   * Execute a single step with guard evaluation, retry loop, capture, and
   * post-wait handling.
   *
   * @param {Object} step       - The normalized step definition.
   * @param {number} stepIndex  - Zero-based position.
   * @param {number} totalSteps - Total number of steps in the workflow.
   * @returns {Promise<Object>} Step result record.
   */
  async executeStep(step, stepIndex, totalSteps) {
    const startedAt = Date.now();
    const basePayload = {
      stepId: step.id,
      stepIndex,
      totalSteps,
      command: step.command,
      strategy: step.strategy,
    };

    this.emitRunnerEvent('step', {
      type: 'started',
      ...basePayload,
    });

    const guardResult = await this.evaluateGuard(step);
    if (!guardResult.ok) {
      const duration = Date.now() - startedAt;
      if (!step.critical) {
        const record = {
          status: 'skipped',
          ...basePayload,
          duration,
          reason: guardResult.reason,
          guard: guardResult.result,
        };
        this.context.setStepResult(step.id, record);
        this.emitRunnerEvent('step', {
          type: 'skipped',
          ...basePayload,
          duration,
          reason: guardResult.reason,
        });
        return record;
      }

      const error = new RunnerError(guardResult.reason, {
        code: 'GUARD_FAILED',
        details: guardResult.result,
      });
      return this.makeFailedStepRecord(step, basePayload, startedAt, 0, error);
    }

    const retryPolicy = step.retryPolicy || this.workflow.settings.defaultRetryPolicy;
    let attempt = 0;
    let lastError = null;

    while (attempt < retryPolicy.maxAttempts) {
      attempt += 1;
      this.checkAborted();

      try {
        const result = await this.executeStepAttempt(step);

        if (step.wait) {
          await this.applyPostWait(step);
        }

        if (step.captureAs) {
          this.context.setCaptured(step.captureAs, extractCaptureValue(result));
          this.emitRunnerEvent('progress', {
            stepId: step.id,
            captureAs: step.captureAs,
          });
        }

        this.updateActiveTab(result);

        const duration = Date.now() - startedAt;
        const record = {
          status: 'success',
          ...basePayload,
          attempts: attempt,
          duration,
          result,
        };
        this.context.setStepResult(step.id, record);
        this.emitRunnerEvent('step', {
          type: 'completed',
          ...basePayload,
          attempt,
          duration,
          result,
        });
        return record;
      } catch (error) {
        const normalized = normalizeError(error);
        lastError = normalized;

        if (this.abortController.signal.aborted && normalized.code === 'ABORTED') {
          throw normalized;
        }

        if (shouldRetry(normalized, retryPolicy, attempt)) {
          const delayMs = calculateBackoff(retryPolicy, attempt);
          this.emitRunnerEvent('step', {
            type: 'retrying',
            ...basePayload,
            attempt,
            nextAttempt: attempt + 1,
            delayMs,
            error: errorToJSON(normalized),
          });
          await sleep(delayMs, this.abortController.signal);
          continue;
        }

        return this.makeFailedStepRecord(step, basePayload, startedAt, attempt, lastError);
      }
    }

    return this.makeFailedStepRecord(step, basePayload, startedAt, attempt, lastError);
  }

  /**
   * Build a failed step result record and emit the 'step:failed' event.
   *
   * @param {Object} step        - The step that failed.
   * @param {Object} basePayload - Common event payload fields.
   * @param {number} startedAt   - When step execution began.
   * @param {number} attempts    - How many attempts were made.
   * @param {Error}  error       - The final error.
   * @returns {Object} The failed step record.
   */
  makeFailedStepRecord(step, basePayload, startedAt, attempts, error) {
    const duration = Date.now() - startedAt;
    const serializedError = errorToJSON(error);
    const record = {
      status: 'failed',
      ...basePayload,
      attempts,
      duration,
      error: serializedError,
    };
    this.context.setStepResult(step.id, record);
    this.emitRunnerEvent('step', {
      type: 'failed',
      ...basePayload,
      attempt: attempts,
      duration,
      error: serializedError,
    });
    return record;
  }

  /* ── Step attempt dispatch ───────────────────────────── */

  /**
   * Execute a single attempt for a step (no retry logic — that's in executeStep).
   *
   * Dispatches to the appropriate execution path:
   * - `ai-vision` strategy → {@link executeAiVisionStep}
   * - `aria-ref` strategy  → {@link executeAriaRefStep}
   * - `wait`/`delay` pseudo commands → sleep
   * - Everything else → generic gateway passthrough
   *
   * @param {Object} step - The normalized step.
   * @returns {Promise<*>} The command result.
   * @throws {RunnerError}
   */
  async executeStepAttempt(step) {
    if (step.strategy === 'ai-vision') {
      return this.executeAiVisionStep(step);
    }

    if (step.strategy === 'aria-ref') {
      return this.executeAriaRefStep(step);
    }

    if (step.command === 'wait' || step.command === 'delay') {
      const params = this.context.interpolate(step.params || {});
      const ms = Number(params.ms ?? params.timeout ?? 1000);
      await sleep(ms, this.abortController.signal);
      return { waited: ms };
    }

    if (!step.command) {
      throw new RunnerError(`Step "${step.id}" has no command or strategy`, {
        code: 'INVALID_STEP',
      });
    }

    const params = this.context.interpolate(step.params || {});
    return this.sendGatewayCommand(step.command, params, step.timeoutMs);
  }

  /* ── AI Vision strategy ──────────────────────────────── */

  /**
   * Execute a step using the ai-vision strategy.
   *
   * 1. Calls `getInteractiveElements` to enumerate clickable elements.
   * 2. Tokenizes the instruction and scores each element.
   * 3. Dispatches a `dispatchClick` at the best match's center coordinates.
   * 4. Falls back to `step.fallback.command` if no match is found.
   *
   * @param {Object} step - The step with `strategy: 'ai-vision'`.
   * @returns {Promise<*>}
   * @throws {RunnerError} With code 'NO_TARGET' if no element matches.
   */
  async executeAiVisionStep(step) {
    const instruction = this.context.interpolate(step.instruction || '');
    const observation = await this.sendGatewayCommand('getInteractiveElements', {}, step.timeoutMs);
    const elements = Array.isArray(observation?.elements) ? observation.elements : [];

    if (elements.length === 0) {
      throw new RunnerError('AI vision found no interactive elements on the page', {
        code: 'NO_TARGET',
      });
    }

    const tokens = keywordTokens(instruction);
    let bestMatch = null;
    let bestScore = 0;

    for (const element of elements) {
      const score = scoreInteractiveElement(element, instruction, tokens);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = element;
      }
    }

    if (!bestMatch || bestScore === 0 || !bestMatch.bounds) {
      if (step.fallback?.command) {
        const fallbackParams = this.context.interpolate(step.fallback.params || {});
        return this.sendGatewayCommand(step.fallback.command, fallbackParams, step.timeoutMs);
      }

      throw new RunnerError(`AI vision could not find a target for "${instruction}"`, {
        code: 'NO_TARGET',
      });
    }

    return this.sendGatewayCommand('dispatchClick', {
      x: bestMatch.bounds.centerX,
      y: bestMatch.bounds.centerY,
    }, step.timeoutMs);
  }

  /* ── ARIA Ref strategy ───────────────────────────────── */

  /**
   * Execute a step using the aria-ref strategy.
   *
   * 1. If `params.ref` is provided, directly dispatch the action command.
   * 2. Otherwise, capture an ARIA snapshot, score entries against the
   *    instruction/target, and dispatch the best-matching ref.
   * 3. Falls back to `step.fallback.command` if no match is found.
   *
   * @param {Object} step - The step with `strategy: 'aria-ref'`.
   * @returns {Promise<Object>} Result with `matchedRef` and `matchedElement` metadata.
   * @throws {RunnerError} With code 'NO_TARGET' if no ref matches.
   */
  async executeAriaRefStep(step) {
    const params = this.context.interpolate(step.params || {});
    const action = String(params.action || step.action || 'click').toLowerCase();
    const command = ARIA_ACTION_COMMANDS[action];

    if (!command) {
      throw new RunnerError(`Unsupported aria-ref action "${action}"`, {
        code: 'VALIDATION_ERROR',
        details: { allowedActions: Object.keys(ARIA_ACTION_COMMANDS) },
      });
    }

    const providedRef = params.ref || step.ref;
    if (providedRef) {
      const actionParams = this.buildAriaActionParams(command, {
        ...params,
        ref: providedRef,
      });
      return this.sendGatewayCommand(command, actionParams, step.timeoutMs);
    }

    const instruction = this.context.interpolate(params.target || step.target || step.instruction || '');
    if (!instruction) {
      throw new RunnerError('aria-ref strategy requires params.ref, target, or instruction', {
        code: 'VALIDATION_ERROR',
      });
    }

    const snapshotParams = this.context.interpolate({
      maxDepth: 15,
      ...(step.snapshot || {}),
      ...(params.snapshot || {}),
    });
    const snapshotResult = await this.sendGatewayCommand('getAriaSnapshot', snapshotParams, step.timeoutMs);
    const entries = parseAriaSnapshot(snapshotResult?.snapshot);

    if (entries.length === 0) {
      throw new RunnerError('ARIA snapshot returned no ref-addressable elements', {
        code: 'NO_TARGET',
        details: { snapshot: snapshotResult },
      });
    }

    const tokens = keywordTokens(instruction);
    let bestMatch = null;
    let bestScore = 0;

    for (const entry of entries) {
      const score = scoreAriaEntry(entry, instruction, tokens);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entry;
      }
    }

    if (!bestMatch || bestScore === 0) {
      if (step.fallback?.command) {
        const fallbackParams = this.context.interpolate(step.fallback.params || {});
        return this.sendGatewayCommand(step.fallback.command, fallbackParams, step.timeoutMs);
      }

      throw new RunnerError(`ARIA snapshot could not find a ref for "${instruction}"`, {
        code: 'NO_TARGET',
        details: {
          candidates: entries.slice(0, 20),
        },
      });
    }

    const actionParams = this.buildAriaActionParams(command, {
      ...params,
      ref: bestMatch.ref,
      element: params.element || instruction,
    });
    const result = await this.sendGatewayCommand(command, actionParams, step.timeoutMs);
    return {
      ...result,
      matchedRef: bestMatch.ref,
      matchedElement: bestMatch.text,
      snapshot: {
        source: snapshotResult?.source,
        mode: snapshotResult?.mode,
        frameId: snapshotResult?.frameId,
      },
    };
  }

  /**
   * Build the params object for an ARIA `*ByRef` command, stripping
   * strategy-internal fields (`action`, `target`, `snapshot`) and
   * enforcing required fields per action type.
   *
   * @param {string} command - The resolved command name (e.g. 'clickByRef').
   * @param {Object} params  - The merged params.
   * @returns {Object} Cleaned params ready for the gateway.
   * @throws {RunnerError} If required fields are missing (text for type, values for select).
   */
  buildAriaActionParams(command, params) {
    const output = {
      ...params,
    };
    delete output.action;
    delete output.target;
    delete output.snapshot;

    if (command === 'clickByRef' || command === 'hoverByRef') {
      delete output.text;
      delete output.values;
      delete output.submit;
    }

    if (command === 'typeByRef' && output.text === undefined) {
      throw new RunnerError('aria-ref type action requires params.text', {
        code: 'VALIDATION_ERROR',
      });
    }

    if (command === 'selectByRef' && output.values === undefined) {
      throw new RunnerError('aria-ref select action requires params.values', {
        code: 'VALIDATION_ERROR',
      });
    }

    return output;
  }

  /* ── Gateway communication ───────────────────────────── */

  /**
   * Send a command to the WebMCP gateway, auto-injecting the active tab id
   * for commands that require it.
   *
   * @param {string} command   - The WebMCP command name.
   * @param {Object} params    - Command parameters.
   * @param {number} timeoutMs - Per-command timeout.
   * @returns {Promise<*>} Gateway result.
   */
  async sendGatewayCommand(command, params, timeoutMs) {
    this.checkAborted();
    const resolvedParams = {
      ...(params || {}),
    };

    if (
      this.activeTabId !== null &&
      this.activeTabId !== undefined &&
      resolvedParams.tabId === undefined &&
      !COMMANDS_WITHOUT_ACTIVE_TAB.has(command)
    ) {
      resolvedParams.tabId = this.activeTabId;
    }

    const result = await this.transport(command, resolvedParams, {
      gatewayUrl: this.options.gatewayUrl,
      profileId: this.options.profileId,
      timeoutMs,
      signal: this.abortController.signal,
    });
    this.updateActiveTab(result);
    return result;
  }

  /* ── Active tab tracking ─────────────────────────────── */

  /**
   * Update the tracked active tab id from a command result, if present.
   * @param {*} result - Command result that may contain `tabId`.
   */
  updateActiveTab(result) {
    if (!result || typeof result !== 'object') return;
    let tabId = result.tabId;
    // Batch envelope carries no top-level tabId; adopt the last tab any
    // sub-action resolved so later steps target the right tab.
    if ((tabId === undefined || tabId === null) && Array.isArray(result.results)) {
      for (let i = result.results.length - 1; i >= 0; i--) {
        const subTabId = result.results[i]?.result?.tabId;
        if (typeof subTabId === 'number') {
          tabId = subTabId;
          break;
        }
      }
    }
    if (tabId === undefined || tabId === null) return;
    this.activeTabId = tabId;
    this.context.setBuiltin('__ACTIVE_TAB_ID__', tabId);
  }

  /* ── Post-step wait ──────────────────────────────────── */

  /**
   * Apply a post-step wait (currently only supports `type: 'delay'`).
   *
   * @param {Object} step - The step with a `wait` config.
   * @throws {RunnerError} If the wait type is unsupported.
   */
  async applyPostWait(step) {
    if (!step.wait) return;
    if (step.wait.type !== 'delay') {
      throw new RunnerError(`Unsupported wait type "${step.wait.type}"`, {
        code: 'INVALID_WAIT',
      });
    }
    await sleep(step.wait.ms, this.abortController.signal);
  }

  /* ── Guard evaluation ────────────────────────────────── */

  /**
   * Evaluate a step's guard condition.  Returns `{ ok: true }` if the step
   * should execute, or `{ ok: false, reason, result }` to skip/fail.
   *
   * Supported guard types:
   * - `element-exists` — check for CSS selector or target presence.
   * - `element-absent` — check that a selector/target is NOT present.
   * - `url-matches`    — regex test against the current page URL.
   * - `expression`     — evaluate arbitrary JS in the page.
   *
   * @param {Object} step - The step whose guard to evaluate.
   * @returns {Promise<{ ok: boolean, result?: *, reason?: string }>}
   * @throws {RunnerError} If the guard type is unsupported.
   */
  async evaluateGuard(step) {
    if (!step.guard) return { ok: true };

    const guard = this.context.interpolate(step.guard);
    const timeoutMs = guard.timeout || step.timeoutMs;

    if (guard.type === 'element-exists') {
      if (guard.selector) {
        const result = await this.sendGatewayCommand('waitForSelector', {
          selector: guard.selector,
          timeout: timeoutMs,
        }, timeoutMs);
        return {
          ok: result?.found !== false,
          result,
          reason: `Guard failed: selector not found (${guard.selector})`,
        };
      }
      return this.evaluateTargetPresenceGuard(guard.target, true, timeoutMs);
    }

    if (guard.type === 'element-absent') {
      if (guard.selector) {
        const result = await this.sendGatewayCommand('evaluateJS', {
          code: `return !document.querySelector(${JSON.stringify(guard.selector)});`,
        }, timeoutMs);
        const ok = Boolean(result?.result);
        return {
          ok,
          result,
          reason: `Guard failed: selector exists (${guard.selector})`,
        };
      }
      return this.evaluateTargetPresenceGuard(guard.target, false, timeoutMs);
    }

    if (guard.type === 'url-matches') {
      const result = await this.sendGatewayCommand('getActiveTab', {}, timeoutMs);
      let ok = false;
      try {
        ok = new RegExp(guard.urlPattern).test(result?.url || '');
      } catch (error) {
        throw new RunnerError(`Invalid guard urlPattern: ${guard.urlPattern}`, {
          code: 'VALIDATION_ERROR',
          cause: error,
        });
      }
      return {
        ok,
        result,
        reason: `Guard failed: URL did not match ${guard.urlPattern}`,
      };
    }

    if (guard.type === 'expression') {
      const expression = String(guard.expression || '').trim();
      const code = expression.startsWith('return ') ? expression : `return Boolean(${expression});`;
      const result = await this.sendGatewayCommand('evaluateJS', { code }, timeoutMs);
      return {
        ok: Boolean(result?.result),
        result,
        reason: 'Guard failed: expression evaluated to false',
      };
    }

    throw new RunnerError(`Unsupported guard type "${guard.type}"`, {
      code: 'VALIDATION_ERROR',
    });
  }

  /**
   * Evaluate a target-based presence guard (css, id, aria-label, text, xpath).
   *
   * @param {{ mode: string, value: string }} target - Target descriptor.
   * @param {boolean} expectedPresent - Whether the element should be present.
   * @param {number}  timeoutMs       - Command timeout.
   * @returns {Promise<{ ok: boolean, result: *, reason: string }>}
   */
  async evaluateTargetPresenceGuard(target, expectedPresent, timeoutMs) {
    const expression = targetPresenceExpression(target);
    if (!expression) {
      throw new RunnerError('Guard target is missing or unsupported', {
        code: 'VALIDATION_ERROR',
        details: { target },
      });
    }

    const result = await this.sendGatewayCommand('evaluateJS', {
      code: `return Boolean(${expression});`,
    }, timeoutMs);
    const present = Boolean(result?.result);
    const ok = expectedPresent ? present : !present;
    return {
      ok,
      result,
      reason: expectedPresent
        ? 'Guard failed: target was not present'
        : 'Guard failed: target was present',
    };
  }

  /* ── Routing ─────────────────────────────────────────── */

  /**
   * Resolve the next step index after a successful step.
   *
   * @param {Object} step         - The completed step.
   * @param {number} currentIndex - The step's index.
   * @returns {number} Next step index (or currentIndex + 1 for sequential).
   * @throws {RunnerError} If the onSuccess target is not found.
   */
  resolveSuccessRoute(step, currentIndex) {
    if (!step.onSuccess) return currentIndex + 1;
    const routeIndex = pickRouteIndex(this.workflow.steps, step.onSuccess);
    if (routeIndex === null) {
      throw new RunnerError(`onSuccess target not found: ${step.onSuccess}`, {
        code: 'VALIDATION_ERROR',
      });
    }
    return routeIndex;
  }

  /**
   * Resolve the next step index after a failed step, using the step's
   * onFailure config (string target or code-keyed object).
   *
   * @param {Object} step  - The failed step.
   * @param {Object} error - The serialized error from the failure.
   * @returns {number|null} Next step index, or `null` if no recovery route.
   */
  resolveFailureRoute(step, error) {
    if (!step.onFailure) return null;

    if (typeof step.onFailure === 'string') {
      return pickRouteIndex(this.workflow.steps, step.onFailure);
    }

    if (typeof step.onFailure === 'object') {
      const target = step.onFailure[error?.code] || step.onFailure.default;
      return pickRouteIndex(this.workflow.steps, target);
    }

    return null;
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Convenience exports
 * ═══════════════════════════════════════════════════════════ */

/**
 * One-shot convenience function: creates a runner and executes the workflow.
 *
 * @param {Object} workflow       - Raw workflow definition.
 * @param {Object} [runtimeVars={}] - Runtime variable overrides.
 * @param {Object} [options={}]   - Runner options.
 * @returns {Promise<Object>} Run summary.
 */
async function runWorkflow(workflow, runtimeVars = {}, options = {}) {
  const runner = new WorkflowRunner(workflow, {
    ...options,
    variables: runtimeVars,
  });
  return runner.run();
}

/**
 * Standalone interpolation helper — resolves `{{ }}` templates using a
 * one-off WorkflowContext.
 *
 * @param {*}      value     - Value tree to interpolate.
 * @param {Object} [variables={}] - Variable namespace.
 * @returns {*} Interpolated value.
 */
function interpolate(value, variables = {}) {
  return new WorkflowContext(variables).interpolate(value);
}

module.exports = {
  WorkflowRunner,
  runWorkflow,
  sendCommand: defaultSendCommand,
  interpolate,
};

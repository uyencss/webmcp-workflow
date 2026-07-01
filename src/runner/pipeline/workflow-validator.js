/**
 * @module pipeline/workflow-validator
 * @description Static validation pass that checks a normalized workflow for
 * structural and semantic errors before execution.
 *
 * Checks performed:
 * - Required top-level fields (`id`, `name`, `steps`).
 * - Per-step: command existence, required params, strategy config, fallbacks.
 * - Route targets (onSuccess / onFailure) point to valid step ids.
 * - Cycle detection on onSuccess chains.
 * - Template `{{ expression }}` references resolve to known variables/steps.
 * - Retry policies, wait configs, and guard configs are well-formed.
 *
 * Returns `{ valid, errors, warnings }`.  Errors block execution; warnings
 * are advisory.
 */

const {
  getCommand,
  hasCommand,
  isUnsupportedCommand,
  getUnsupportedReason,
  validateCommandParams,
} = require('../catalog/command-catalog');
const { extractTemplatePaths } = require('./workflow-context');

/* ═══════════════════════════════════════════════════════════
 *  Constants
 * ═══════════════════════════════════════════════════════════ */

/** @type {Set<string>} Strategy names recognized by the runner. */
const SUPPORTED_STRATEGIES = new Set(['ai-vision', 'aria-ref']);

/** @type {Set<string>} Valid action verbs for the `aria-ref` strategy. */
const ARIA_REF_ACTIONS = new Set(['click', 'type', 'hover', 'select']);

/** @type {Set<string>} Guard types handled by the runner's evaluateGuard. */
const SUPPORTED_GUARDS = new Set(['element-exists', 'element-absent', 'url-matches', 'expression']);

/**
 * Variables injected automatically by the runner at the start of every run.
 * Template references to these names are always considered valid.
 * @type {Set<string>}
 */
const BUILTIN_VARIABLES = new Set([
  '__TIMESTAMP__',
  '__DATE__',
  '__WORKFLOW_ID__',
  '__RUN_ID__',
  '__ACTIVE_TAB_ID__',
]);

/* ═══════════════════════════════════════════════════════════
 *  Internal helpers
 * ═══════════════════════════════════════════════════════════ */

/**
 * Check whether a value is a plain (non-array) object.
 * @param {*} value
 * @returns {boolean}
 */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Check whether a string contains at least one `{{ template }}` expression.
 * @param {*} value
 * @returns {boolean}
 */
function hasTemplate(value) {
  return typeof value === 'string' && extractTemplatePaths(value).size > 0;
}

/**
 * Collect all route targets (onSuccess, onFailure) from a step for validation.
 *
 * @param {Object} step
 * @returns {Array<{ label: string, target: string }>}
 */
function routeTargets(step) {
  const targets = [];
  if (typeof step.onSuccess === 'string') targets.push({ label: 'onSuccess', target: step.onSuccess });

  if (typeof step.onFailure === 'string') {
    targets.push({ label: 'onFailure', target: step.onFailure });
  } else if (isObject(step.onFailure)) {
    for (const [code, target] of Object.entries(step.onFailure)) {
      targets.push({ label: `onFailure.${code}`, target });
    }
  }

  return targets;
}

/* ═══════════════════════════════════════════════════════════
 *  Sub-validators: command usage
 * ═══════════════════════════════════════════════════════════ */

/**
 * Validate that a command name is known, supported, and receives valid params.
 *
 * @param {string}   commandName - The command name to check.
 * @param {Object}   params      - Provided params (may be undefined).
 * @param {string}   label       - Human-readable step label for error messages.
 * @param {string[]} errors      - Accumulator for errors.
 * @param {string[]} warnings    - Accumulator for warnings.
 * @param {Object}   options
 * @param {boolean}  options.allowUnknownCommand - When true, unknown commands
 *   produce a warning instead of an error.
 */
function validateCommandUsage(commandName, params, label, errors, warnings, options) {
  if (!commandName) return;

  if (isUnsupportedCommand(commandName)) {
    errors.push(`${label}: command "${commandName}" is currently unsupported. ${getUnsupportedReason(commandName)}`);
    return;
  }

  if (!hasCommand(commandName)) {
    const message = `${label}: command "${commandName}" is not in the WebMCP command catalog`;
    if (options.allowUnknownCommand) warnings.push(`${message}; passthrough is enabled`);
    else errors.push(message);
    return;
  }

  if (params !== undefined && !isObject(params)) {
    errors.push(`${label}: params must be an object`);
    return;
  }

  errors.push(...validateCommandParams(commandName, params || {}).map((message) => `${label}: ${message}`));

  const command = getCommand(commandName);
  if (command?.group === 'runner' && params && Object.keys(params).length === 0 && commandName !== 'wait' && commandName !== 'delay') {
    warnings.push(`${label}: runner command "${commandName}" has no parameters`);
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Sub-validators: retry policy
 * ═══════════════════════════════════════════════════════════ */

/**
 * Validate a retry policy object for well-formed fields.
 *
 * @param {Object}   policy - The retry policy to check.
 * @param {string}   label  - Human-readable context for error messages.
 * @param {string[]} errors - Accumulator.
 */
function validateRetryPolicy(policy, label, errors) {
  if (!policy) return;
  if (!isObject(policy)) {
    errors.push(`${label}: retryPolicy must be an object`);
    return;
  }

  if (policy.maxAttempts !== undefined && (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1)) {
    errors.push(`${label}: retryPolicy.maxAttempts must be an integer >= 1`);
  }

  for (const key of ['backoffMs', 'maxBackoffMs']) {
    if (policy[key] !== undefined && (!Number.isFinite(policy[key]) || policy[key] < 0)) {
      errors.push(`${label}: retryPolicy.${key} must be a number >= 0`);
    }
  }

  if (policy.retryOn !== undefined && !Array.isArray(policy.retryOn)) {
    errors.push(`${label}: retryPolicy.retryOn must be an array of error codes`);
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Sub-validators: wait config
 * ═══════════════════════════════════════════════════════════ */

/**
 * Validate a normalized `wait` config on a step.
 *
 * @param {Object}   wait   - The wait config (already normalized).
 * @param {string}   label  - Human-readable context.
 * @param {string[]} errors - Accumulator.
 */
function validateWait(wait, label, errors) {
  if (wait === undefined) return;
  if (!isObject(wait)) {
    errors.push(`${label}: wait must be an object`);
    return;
  }
  if (wait.type !== 'delay') {
    errors.push(`${label}: wait.type must be "delay"`);
  }
  if (!Number.isFinite(wait.ms) || wait.ms < 0) {
    errors.push(`${label}: wait.ms must be a number >= 0`);
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Sub-validators: guard config
 * ═══════════════════════════════════════════════════════════ */

/**
 * Validate a guard config on a step.
 *
 * @param {Object}   guard  - The guard config.
 * @param {string}   label  - Human-readable context.
 * @param {string[]} errors - Accumulator.
 */
function validateGuard(guard, label, errors) {
  if (guard === undefined) return;
  if (!isObject(guard)) {
    errors.push(`${label}: guard must be an object`);
    return;
  }

  if (!SUPPORTED_GUARDS.has(guard.type)) {
    errors.push(`${label}: guard.type must be one of ${Array.from(SUPPORTED_GUARDS).join(', ')}`);
    return;
  }

  if ((guard.type === 'element-exists' || guard.type === 'element-absent') && !guard.selector && !guard.target) {
    errors.push(`${label}: ${guard.type} guard requires selector or target`);
  }
  if (guard.type === 'url-matches' && !guard.urlPattern) {
    errors.push(`${label}: url-matches guard requires urlPattern`);
  }
  if (guard.type === 'expression' && !guard.expression) {
    errors.push(`${label}: expression guard requires expression`);
  }
  if (guard.timeout !== undefined && (!Number.isFinite(guard.timeout) || guard.timeout < 0)) {
    errors.push(`${label}: guard.timeout must be a number >= 0`);
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Sub-validators: template references
 * ═══════════════════════════════════════════════════════════ */

/**
 * Validate that all `{{ expression }}` template references in a value tree
 * resolve to known variables, step ids, or captured outputs.
 *
 * In strict mode, unresolvable references are errors; otherwise warnings.
 *
 * @param {*}        value          - The value tree to scan.
 * @param {string}   label          - Human-readable context.
 * @param {Set}      knownVariables - Variable names known at this point.
 * @param {Set}      stepIds        - All declared step ids.
 * @param {string[]} errors         - Accumulator.
 * @param {string[]} warnings       - Accumulator.
 * @param {boolean}  strict         - Treat unknown refs as errors.
 */
function validateTemplateRefs(value, label, knownVariables, stepIds, errors, warnings, strict) {
  const refs = Array.from(extractTemplatePaths(value)).sort();

  for (const expression of refs) {
    const parts = expression.split('.').map((part) => part.trim()).filter(Boolean);
    const root = parts[0];

    if (!root) continue;
    if (BUILTIN_VARIABLES.has(expression) || BUILTIN_VARIABLES.has(root)) continue;
    if (root === 'last') continue;

    if (root === 'steps') {
      const stepId = parts[1];
      if (!stepId) {
        errors.push(`${label}: template "{{${expression}}}" must include a step id`);
      } else if (!stepIds.has(stepId)) {
        errors.push(`${label}: template "{{${expression}}}" references unknown step "${stepId}"`);
      }
      continue;
    }

    if (root === 'outputs') {
      const outputName = parts[1];
      if (!outputName || knownVariables.has(outputName)) continue;
      const message = `${label}: template "{{${expression}}}" references unknown captured output "${outputName}"`;
      if (strict) errors.push(message);
      else warnings.push(message);
      continue;
    }

    if (!knownVariables.has(root)) {
      const message = `${label}: template "{{${expression}}}" references unknown variable "${root}"`;
      if (strict) errors.push(message);
      else warnings.push(message);
    }
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Cycle detection
 * ═══════════════════════════════════════════════════════════ */

/**
 * Detect infinite loops in onSuccess routing chains.
 *
 * Walks each step's onSuccess chain and flags if a cycle is found.
 *
 * @param {Object[]}            steps    - Array of step objects.
 * @param {Map<string, Object>} stepById - Lookup map of step id → step.
 * @param {string[]}            errors   - Accumulator.
 */
function detectOnSuccessCycles(steps, stepById, errors) {
  for (const start of steps) {
    const seen = new Set();
    let current = start;

    while (current?.onSuccess) {
      if (seen.has(current.id)) {
        errors.push(`Step "${start.id}": onSuccess route contains a cycle at "${current.id}"`);
        break;
      }

      seen.add(current.id);
      current = stepById.get(current.onSuccess);
    }
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Main entry point
 * ═══════════════════════════════════════════════════════════ */

/**
 * Validate a normalized workflow definition.
 *
 * @param {Object} workflow  - Normalized workflow object (from normalizeWorkflow).
 * @param {Object} [options={}]
 * @param {boolean} [options.strict=false]             - Treat unknown template refs as errors.
 * @param {boolean} [options.allowUnknownCommand=false] - Allow passthrough commands not in the catalog.
 * @param {Object}  [options.runtimeVariables={}]       - CLI/API variable overrides.
 * @returns {{ valid: boolean, errors: string[], warnings: string[] }}
 */
function validateWorkflow(workflow, options = {}) {
  const errors = [];
  const warnings = [];
  const strict = Boolean(options.strict);
  const allowUnknownCommand = Boolean(options.allowUnknownCommand);
  const runtimeVariables = options.runtimeVariables || {};
  const knownVariables = new Set([
    ...Object.keys(workflow?.variables || {}),
    ...Object.keys(runtimeVariables),
    ...BUILTIN_VARIABLES,
  ]);

  /* ── Top-level structure ─────────────────────────────── */

  if (!workflow || !isObject(workflow)) {
    return { valid: false, errors: ['Workflow must be an object'], warnings };
  }

  if (!workflow.id) errors.push('Workflow is missing "id"');
  if (!workflow.name) errors.push('Workflow is missing "name"');
  if (workflow.settings !== undefined && !isObject(workflow.settings)) {
    errors.push('Workflow "settings" must be an object');
  }
  if (isObject(workflow.settings)) {
    if (!Number.isFinite(workflow.settings.defaultTimeout) || workflow.settings.defaultTimeout <= 0) {
      errors.push('Workflow settings.defaultTimeout must be a positive number');
    }
    validateRetryPolicy(workflow.settings.defaultRetryPolicy, 'Workflow settings.defaultRetryPolicy', errors);
  }
  if (!Array.isArray(workflow.steps)) {
    errors.push('Workflow "steps" must be an array');
    return { valid: false, errors, warnings };
  }
  if (workflow.steps.length === 0) errors.push('Workflow must contain at least one step');

  /* ── Pass 1: collect step ids ────────────────────────── */

  const stepById = new Map();
  const stepIds = new Set();
  for (let index = 0; index < workflow.steps.length; index++) {
    const step = workflow.steps[index];
    const label = `Step ${index + 1}${step?.id ? ` "${step.id}"` : ''}`;

    if (!isObject(step)) {
      errors.push(`${label}: step must be an object`);
      continue;
    }

    if (!step.id) {
      errors.push(`${label}: missing "id"`);
      continue;
    }
    if (stepIds.has(step.id)) errors.push(`${label}: duplicate step id "${step.id}"`);
    stepIds.add(step.id);
    stepById.set(step.id, step);
  }

  /* ── Pass 2: validate each step ──────────────────────── */

  for (let index = 0; index < workflow.steps.length; index++) {
    const step = workflow.steps[index];
    if (!isObject(step)) continue;
    const label = `Step ${index + 1}${step.id ? ` "${step.id}"` : ''}`;

    /* step type */
    if (step.type !== undefined && step.type !== 'command' && step.type !== 'forEach') {
      errors.push(`${label}: unknown step type "${step.type}"`);
    }

    /* forEach config (body-1-step: the loop body is this step's own command/strategy) */
    if (step.type === 'forEach') {
      if (!isObject(step.forEach)) {
        errors.push(`${label}: forEach step requires a "forEach" config object`);
      } else {
        if (step.forEach.items === undefined) errors.push(`${label}: forEach requires "items"`);
        if (typeof step.forEach.as !== 'string' || !step.forEach.as) {
          errors.push(`${label}: forEach requires "as" (non-empty string)`);
        }
        if (step.forEach.indexAs !== undefined && (typeof step.forEach.indexAs !== 'string' || !step.forEach.indexAs)) {
          errors.push(`${label}: forEach.indexAs must be a non-empty string`);
        }
        if (step.forEach.collectAs && !step.captureAs) {
          errors.push(`${label}: forEach.collectAs requires the step to set "captureAs"`);
        }
      }
    }

    /* command or strategy required (also the forEach body) */
    if (!step.command && !step.strategy) {
      errors.push(`${label}: must define either "command" or "strategy"`);
    }

    /* command validation */
    if (step.command) {
      validateCommandUsage(step.command, step.params, label, errors, warnings, {
        allowUnknownCommand,
      });
    }

    /* strategy validation */
    if (step.strategy) {
      if (!SUPPORTED_STRATEGIES.has(step.strategy)) {
        errors.push(`${label}: unsupported strategy "${step.strategy}"`);
      }
      if (step.strategy === 'ai-vision' && !step.instruction) {
        errors.push(`${label}: strategy "ai-vision" requires instruction`);
      }
      if (step.strategy === 'aria-ref') {
        const params = isObject(step.params) ? step.params : {};
        const action = params.action || step.action || 'click';
        const actionIsTemplate = hasTemplate(action);
        if (!actionIsTemplate && !ARIA_REF_ACTIONS.has(action)) {
          errors.push(`${label}: strategy "aria-ref" action must be one of ${Array.from(ARIA_REF_ACTIONS).join(', ')}`);
        }
        if (!params.ref && !step.ref && !params.target && !step.target && !step.instruction) {
          errors.push(`${label}: strategy "aria-ref" requires params.ref, target, or instruction`);
        }
        if (!actionIsTemplate && action === 'type' && params.text === undefined) {
          errors.push(`${label}: strategy "aria-ref" type action requires params.text`);
        }
        if (!actionIsTemplate && action === 'select' && params.values === undefined) {
          errors.push(`${label}: strategy "aria-ref" select action requires params.values`);
        }
      }
    }

    /* fallback validation */
    if (step.fallback) {
      if (!isObject(step.fallback)) {
        errors.push(`${label}: fallback must be an object`);
      } else {
        validateCommandUsage(step.fallback.command, step.fallback.params || {}, `${label} fallback`, errors, warnings, {
          allowUnknownCommand,
        });
      }
    }

    /* route target validation */
    for (const route of routeTargets(step)) {
      if (typeof route.target !== 'string' || !stepIds.has(route.target)) {
        errors.push(`${label}: ${route.label} points to unknown step "${route.target}"`);
      }
      if (route.target === step.id) {
        errors.push(`${label}: ${route.label} cannot point to itself`);
      }
    }

    /* timeout validation */
    if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)) {
      errors.push(`${label}: timeoutMs must be a positive number`);
    }

    /* sub-validators */
    validateRetryPolicy(step.retryPolicy, label, errors);
    validateWait(step.wait, label, errors);
    validateGuard(step.guard, label, errors);

    /* loop-scoped variables (as/indexAs) are known inside a forEach body */
    let stepKnownVariables = knownVariables;
    if (step.type === 'forEach' && isObject(step.forEach)) {
      stepKnownVariables = new Set(knownVariables);
      if (step.forEach.as) stepKnownVariables.add(step.forEach.as);
      stepKnownVariables.add(step.forEach.indexAs || '__INDEX__');
    }
    validateTemplateRefs(step, label, stepKnownVariables, stepIds, errors, warnings, strict);

    if (step.captureAs) {
      knownVariables.add(step.captureAs);
    }
    if (step.type === 'forEach' && step.forEach?.collectAs) {
      knownVariables.add(step.forEach.collectAs);
    }
  }

  /* ── Cycle detection ─────────────────────────────────── */

  detectOnSuccessCycles(workflow.steps.filter(isObject), stepById, errors);

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = {
  BUILTIN_VARIABLES,
  SUPPORTED_STRATEGIES,
  SUPPORTED_GUARDS,
  validateWorkflow,
};

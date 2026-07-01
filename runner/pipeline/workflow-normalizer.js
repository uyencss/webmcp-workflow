/**
 * @module pipeline/workflow-normalizer
 * @description Pre-processing pass that normalizes a raw workflow JSON into a
 * canonical internal form before validation and execution.
 *
 * Normalization guarantees:
 * - Every step has `params`, `timeoutMs`, `retryPolicy`, and `critical` set.
 * - Settings are merged with sensible defaults.
 * - `wait` shorthand (a bare number) is expanded to `{ type: 'delay', ms }`.
 * - `fallback.params` defaults to `{}` when a fallback command is present.
 *
 * The normalizer deep-clones the input so the original workflow object is
 * never mutated.
 */

/* ═══════════════════════════════════════════════════════════
 *  Default settings
 * ═══════════════════════════════════════════════════════════ */

/** @type {Object} Canonical default settings applied when no overrides are given. */
const DEFAULT_SETTINGS = {
  defaultTimeout: 30000,
  defaultRetryPolicy: {
    maxAttempts: 1,
    backoffMs: 1000,
    maxBackoffMs: 10000,
  },
  continueOnNonCriticalFailure: true,
};

/* ═══════════════════════════════════════════════════════════
 *  Internal helpers
 * ═══════════════════════════════════════════════════════════ */

/**
 * Deep-clone a value via JSON round-trip.
 * @param {*} value
 * @returns {*} Cloned value, or `undefined` if the input is `undefined`.
 */
function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * Coerce a value to a finite number, falling back to `fallback` on failure.
 *
 * @param {*}      value    - Value to coerce.
 * @param {number} fallback - Returned when `value` is empty or non-numeric.
 * @returns {number}
 */
function toNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

/* ═══════════════════════════════════════════════════════════
 *  Retry policy normalization
 * ═══════════════════════════════════════════════════════════ */

/**
 * Normalize a retry policy object, applying defaults for missing fields.
 *
 * @param {Object} [policy={}]  - Raw retry policy from the workflow JSON.
 * @param {Object} [defaults]   - Default retry policy to fill gaps.
 * @returns {{ maxAttempts: number, backoffMs: number, maxBackoffMs: number, retryOn?: string[] }}
 */
function normalizeRetryPolicy(policy = {}, defaults = DEFAULT_SETTINGS.defaultRetryPolicy) {
  const source = policy || {};
  return {
    maxAttempts: Math.max(1, Math.floor(toNumber(source.maxAttempts, defaults.maxAttempts || 1))),
    backoffMs: Math.max(0, toNumber(source.backoffMs, defaults.backoffMs || 1000)),
    maxBackoffMs: Math.max(0, toNumber(source.maxBackoffMs, defaults.maxBackoffMs || 10000)),
    ...(Array.isArray(source.retryOn) ? { retryOn: [...source.retryOn] } : {}),
  };
}

/* ═══════════════════════════════════════════════════════════
 *  Wait normalization
 * ═══════════════════════════════════════════════════════════ */

/**
 * Normalize the `wait` field on a step.
 *
 * Accepts:
 * - `undefined | null | false` → no post-step wait.
 * - A bare number (ms) → `{ type: 'delay', ms }`.
 * - An object → canonical form with `type` defaulting to `'delay'`.
 *
 * @param {number|Object|undefined|null|false} wait
 * @returns {{ type: string, ms?: number }|undefined}
 */
function normalizeWait(wait) {
  if (wait === undefined || wait === null || wait === false) return undefined;

  if (typeof wait === 'number') {
    return { type: 'delay', ms: wait };
  }

  if (typeof wait === 'object') {
    const type = wait.type || 'delay';
    const ms = toNumber(wait.ms ?? wait.timeout, undefined);
    return {
      ...wait,
      type: type === 'wait' ? 'delay' : type,
      ...(ms !== undefined ? { ms } : {}),
    };
  }

  return wait;
}

/* ═══════════════════════════════════════════════════════════
 *  Settings normalization
 * ═══════════════════════════════════════════════════════════ */

/**
 * Merge raw workflow settings with {@link DEFAULT_SETTINGS}.
 *
 * @param {Object} [settings={}]  - Raw settings from the workflow JSON.
 * @param {Object} [options={}]
 * @param {number} [options.defaultTimeout] - CLI/API timeout override.
 * @returns {Object} Fully resolved settings object.
 */
function normalizeSettings(settings = {}, options = {}) {
  const merged = {
    ...DEFAULT_SETTINGS,
    ...settings,
    defaultRetryPolicy: {
      ...DEFAULT_SETTINGS.defaultRetryPolicy,
      ...(settings.defaultRetryPolicy || {}),
    },
  };

  if (options.defaultTimeout !== undefined) {
    merged.defaultTimeout = options.defaultTimeout;
  }

  merged.defaultTimeout = Math.max(1, toNumber(merged.defaultTimeout, DEFAULT_SETTINGS.defaultTimeout));
  merged.defaultRetryPolicy = normalizeRetryPolicy(
    merged.defaultRetryPolicy,
    DEFAULT_SETTINGS.defaultRetryPolicy,
  );
  merged.continueOnNonCriticalFailure = merged.continueOnNonCriticalFailure !== false;

  return merged;
}

/* ═══════════════════════════════════════════════════════════
 *  Step normalization
 * ═══════════════════════════════════════════════════════════ */

/**
 * Normalize a single workflow step, applying defaults for `params`, `timeoutMs`,
 * `retryPolicy`, and `critical`.
 *
 * @param {Object} step      - Raw step definition from the workflow JSON.
 * @param {number} index     - Zero-based position in the steps array.
 * @param {Object} settings  - The normalized workflow settings.
 * @returns {Object} Normalized step with guaranteed fields.
 */
function normalizeStep(step, index, settings) {
  const normalized = {
    ...step,
    index,
    critical: step.critical !== false,
    timeoutMs: Math.max(1, toNumber(step.timeoutMs, settings.defaultTimeout)),
    retryPolicy: normalizeRetryPolicy(step.retryPolicy, settings.defaultRetryPolicy),
  };

  if (step.params === undefined && step.command) {
    normalized.params = {};
  }

  if (step.fallback) {
    normalized.fallback = {
      ...step.fallback,
      params: step.fallback.params || {},
    };
  }

  if (step.wait !== undefined) {
    normalized.wait = normalizeWait(step.wait);
  }

  return normalized;
}

/* ═══════════════════════════════════════════════════════════
 *  Main entry point
 * ═══════════════════════════════════════════════════════════ */

/**
 * Normalize a complete workflow definition.
 *
 * Deep-clones the input, merges settings with defaults, and normalizes
 * every step.  The returned object is safe to mutate during execution.
 *
 * @param {Object} workflow      - Raw workflow JSON.
 * @param {Object} [options={}]
 * @param {number} [options.defaultTimeout] - CLI/API timeout override.
 * @returns {Object} Deep-cloned, normalized workflow.
 */
function normalizeWorkflow(workflow, options = {}) {
  const source = clone(workflow) || {};
  const settings = normalizeSettings(source.settings || {}, {
    defaultTimeout: options.defaultTimeout,
  });

  return {
    ...source,
    settings,
    variables: source.variables || {},
    steps: Array.isArray(source.steps)
      ? source.steps.map((step, index) => normalizeStep(step, index, settings))
      : source.steps,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  normalizeWorkflow,
  normalizeSettings,
  normalizeStep,
  normalizeRetryPolicy,
  normalizeWait,
};

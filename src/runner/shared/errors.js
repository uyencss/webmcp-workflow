/**
 * @module shared/errors
 * @description Custom error types and error-handling utilities for the workflow runner.
 *
 * Provides:
 * - {@link RunnerError}     — Typed error with code, retryable flag, and structured details.
 * - {@link normalizeError}  — Wraps any thrown value into a RunnerError.
 * - {@link errorToJSON}     — Serializes an error for event payloads and logs.
 * - {@link classifyMessage} — Heuristic error-code classifier for gateway messages.
 * - {@link isRetryableCode} — Checks whether an error code is worth retrying.
 */

/* ═══════════════════════════════════════════════════════════
 *  RunnerError class
 * ═══════════════════════════════════════════════════════════ */

/**
 * Structured error used throughout the runner pipeline.
 *
 * Every RunnerError carries a machine-readable `code` (e.g. 'TIMEOUT',
 * 'VALIDATION_ERROR', 'ABORTED') and an optional `retryable` flag so the
 * retry loop can make informed decisions.
 *
 * @extends Error
 */
class RunnerError extends Error {
  /**
   * @param {string} message  - Human-readable error description.
   * @param {Object} [options]
   * @param {string} [options.code='RUNNER_ERROR'] - Machine-readable error code.
   * @param {number} [options.status]              - HTTP status from the gateway, if applicable.
   * @param {*}      [options.details]             - Arbitrary structured context (e.g. validation list).
   * @param {boolean}[options.retryable=false]     - Whether the caller should retry.
   * @param {Error}  [options.cause]               - Original cause for error-chain debugging.
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'RunnerError';
    this.code = options.code || 'RUNNER_ERROR';
    this.status = options.status;
    this.details = options.details;
    this.retryable = Boolean(options.retryable);
    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Message classification
 * ═══════════════════════════════════════════════════════════ */

/**
 * Infer a machine-readable error code from a free-text message string.
 *
 * Used when the gateway returns an error without a structured code —
 * we scan the message for well-known keywords and map to internal codes.
 *
 * @param {string} message - The raw error message from the gateway or transport layer.
 * @returns {string} One of: 'TIMEOUT', 'GATEWAY_UNAVAILABLE', 'UNKNOWN_COMMAND',
 *   'VALIDATION_ERROR', 'ABORTED', or the fallback 'COMMAND_FAILED'.
 */
function classifyMessage(message) {
  const text = String(message || '').toLowerCase();

  if (text.includes('timed out') || text.includes('timeout')) return 'TIMEOUT';
  if (text.includes('profileid') && (text.includes('required') || text.includes('multiple'))) return 'PROFILE_REQUIRED';
  if (text.includes('profile') && (text.includes('not found') || text.includes('unknown') || text.includes('disconnected'))) return 'PROFILE_NOT_FOUND';
  if (text.includes('extension is not connected')) return 'GATEWAY_UNAVAILABLE';
  if (text.includes('extension disconnected')) return 'GATEWAY_UNAVAILABLE';
  if (text.includes('method not found')) return 'UNKNOWN_COMMAND';
  if (text.includes('missing required param')) return 'VALIDATION_ERROR';
  if (text.includes('aborted') || text.includes('abort')) return 'ABORTED';

  return 'COMMAND_FAILED';
}

/**
 * Check whether an error code represents a transient failure worth retrying.
 *
 * @param {string} code - The error code to test.
 * @returns {boolean} `true` if the error is likely transient.
 */
function isRetryableCode(code) {
  return code === 'TIMEOUT' || code === 'GATEWAY_UNAVAILABLE' || code === 'NETWORK_ERROR';
}

/* ═══════════════════════════════════════════════════════════
 *  Error normalization & serialization
 * ═══════════════════════════════════════════════════════════ */

/**
 * Wrap any value into a {@link RunnerError}.
 *
 * If `error` is already a RunnerError it is returned as-is.  Otherwise a new
 * RunnerError is created using the message and inferred code.
 *
 * @param {*}      error                       - The thrown value to normalize.
 * @param {string} [fallbackCode='RUNNER_ERROR'] - Code to use when classification yields nothing.
 * @returns {RunnerError}
 */
function normalizeError(error, fallbackCode = 'RUNNER_ERROR') {
  if (error instanceof RunnerError) return error;

  const message = error?.message || String(error || 'Unknown runner error');
  const code = error?.code || classifyMessage(message) || fallbackCode;

  return new RunnerError(message, {
    code,
    cause: error,
    retryable: isRetryableCode(code),
  });
}

/**
 * Serialize a RunnerError (or any error) into a plain JSON-safe object
 * suitable for event payloads and structured logs.
 *
 * @param {Error|RunnerError} error - The error to serialize.
 * @returns {{ name: string, code: string, message: string, retryable: boolean, status?: number, details?: * }}
 */
function errorToJSON(error) {
  const normalized = normalizeError(error);
  return {
    name: normalized.name,
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
    ...(normalized.status !== undefined ? { status: normalized.status } : {}),
    ...(normalized.details !== undefined ? { details: normalized.details } : {}),
  };
}

module.exports = {
  RunnerError,
  normalizeError,
  errorToJSON,
  classifyMessage,
  isRetryableCode,
};

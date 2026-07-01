/**
 * @module core/transport
 * @description HTTP transport layer for sending commands to the WebMCP gateway.
 *
 * The gateway is the Express server that bridges the workflow runner to the
 * Chrome extension via WebSocket.  This module handles:
 * - JSON-RPC style request/response over HTTP POST.
 * - Timeout enforcement via AbortController.
 * - External abort signal forwarding (for workflow-level cancellation).
 * - Structured error classification for retries.
 */

const { RunnerError, classifyMessage, normalizeError, isRetryableCode } = require('../shared/errors');

/* ═══════════════════════════════════════════════════════════
 *  Constants
 * ═══════════════════════════════════════════════════════════ */

/** @type {string} Default gateway URL when none is configured. */
const DEFAULT_GATEWAY_URL = 'http://localhost:7865/api';

/* ═══════════════════════════════════════════════════════════
 *  Internal helpers
 * ═══════════════════════════════════════════════════════════ */

/**
 * Resolve the gateway URL from explicit arg → env var → default.
 *
 * @param {string} [gatewayUrl] - Explicit URL override.
 * @returns {string} Resolved gateway URL.
 */
function getGatewayUrl(gatewayUrl) {
  return gatewayUrl || process.env.WEBMCP_GATEWAY_URL || DEFAULT_GATEWAY_URL;
}

/**
 * Create a RunnerError for abort/timeout scenarios.
 *
 * @param {string} message      - Human-readable message.
 * @param {string} [code='ABORTED'] - Error code ('ABORTED' or 'TIMEOUT').
 * @returns {RunnerError}
 */
function makeAbortError(message, code = 'ABORTED') {
  return new RunnerError(message, { code, retryable: code === 'TIMEOUT' });
}

/**
 * Parse a gateway HTTP response body as JSON.
 *
 * @param {Response} response - The fetch Response object.
 * @returns {Promise<Object>} Parsed JSON, or `{}` if the body is empty.
 * @throws {RunnerError} If the body is not valid JSON.
 */
async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RunnerError('Gateway returned a non-JSON response', {
      code: 'GATEWAY_BAD_RESPONSE',
      status: response.status,
      details: { body: text.slice(0, 1000) },
      cause: error,
    });
  }
}

/* ═══════════════════════════════════════════════════════════
 *  Main transport function
 * ═══════════════════════════════════════════════════════════ */

/**
 * Send a command to the WebMCP gateway and return the result.
 *
 * Handles:
 * - Timeout: creates an internal AbortController that fires after `timeoutMs`.
 * - External abort: forwards an optional `signal` from the caller.
 * - Error classification: HTTP errors, JSON errors, and gateway-level errors
 *   are all wrapped in {@link RunnerError} with appropriate codes.
 *
 * @param {string} method          - The WebMCP command name (e.g. `'clickByRef'`).
 * @param {Object} [params={}]     - Command parameters.
 * @param {Object} [options={}]
 * @param {string} [options.gatewayUrl]  - Gateway endpoint override.
 * @param {string} [options.profileId]   - Gateway profile id for multi-profile routing.
 * @param {number} [options.timeoutMs]   - Per-command timeout in milliseconds.
 * @param {AbortSignal} [options.signal] - External abort signal for cancellation.
 * @returns {Promise<*>} The gateway's `result` payload.
 * @throws {RunnerError} On timeout, abort, network failure, or gateway error.
 */
async function sendCommand(method, params = {}, options = {}) {
  const gatewayUrl = getGatewayUrl(options.gatewayUrl);
  const timeoutMs = options.timeoutMs;
  const controller = new AbortController();
  let timeoutTimer = null;

  const abortFromExternalSignal = () => {
    const reason = options.signal?.reason;
    controller.abort(reason || makeAbortError(`Command "${method}" aborted`));
  };

  if (options.signal?.aborted) {
    throw normalizeError(options.signal.reason || makeAbortError(`Command "${method}" aborted`), 'ABORTED');
  }

  if (options.signal) {
    options.signal.addEventListener('abort', abortFromExternalSignal, { once: true });
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      controller.abort(makeAbortError(`Command "${method}" timed out after ${timeoutMs}ms`, 'TIMEOUT'));
    }, timeoutMs);
  }

  try {
    const requestBody = { method, params };
    if (options.profileId) requestBody.profileId = options.profileId;

    const response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    const data = await parseJsonResponse(response);

    if (!response.ok) {
      const message = data.error || `Gateway returned HTTP ${response.status}`;
      const code = classifyMessage(message);
      throw new RunnerError(message, {
        code,
        status: response.status,
        retryable: isRetryableCode(code),
      });
    }

    if (data.error) {
      const message = typeof data.error === 'string' ? data.error : data.error.message || 'Gateway command failed';
      const code = classifyMessage(message);
      throw new RunnerError(message, {
        code,
        retryable: isRetryableCode(code),
        details: typeof data.error === 'object' ? data.error : undefined,
      });
    }

    return data.result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw normalizeError(controller.signal.reason || makeAbortError(`Command "${method}" aborted`));
    }

    if (error instanceof TypeError && String(error.message || '').includes('fetch')) {
      throw new RunnerError(`Unable to reach WebMCP gateway at ${gatewayUrl}: ${error.message}`, {
        code: 'GATEWAY_UNAVAILABLE',
        retryable: true,
        cause: error,
      });
    }

    throw normalizeError(error);
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (options.signal) {
      options.signal.removeEventListener('abort', abortFromExternalSignal);
    }
  }
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  getGatewayUrl,
  sendCommand,
};

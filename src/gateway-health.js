const { RunnerError, classifyMessage } = require('./runner');
const { CliError } = require('./errors');

function timeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
}

async function parseResponseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(`Gateway returned non-JSON response: ${text.slice(0, 200)}`, {
      code: 'GATEWAY_BAD_RESPONSE',
      exitCode: 3,
    });
  }
}

async function fetchHealth(gateway) {
  const { signal, cleanup } = timeoutSignal(gateway.healthTimeoutMs || 3000);
  try {
    const response = await fetch(gateway.healthUrl, { signal });
    const payload = await parseResponseJson(response);
    if (!response.ok) {
      throw new CliError(payload.error || `Gateway health returned HTTP ${response.status}`, {
        code: 'GATEWAY_UNAVAILABLE',
        exitCode: 3,
        details: payload,
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Unable to reach WebMCP gateway health endpoint at ${gateway.healthUrl}: ${error.message}`, {
      code: 'GATEWAY_UNAVAILABLE',
      exitCode: 3,
      cause: error,
    });
  } finally {
    cleanup();
  }
}

async function pingGateway(gateway, profileId) {
  const { signal, cleanup } = timeoutSignal(gateway.healthTimeoutMs || 3000);
  try {
    const body = { method: 'ping', params: {} };
    if (profileId) body.profileId = profileId;

    const headers = { 'Content-Type': 'application/json' };
    const token = process.env.WEBMCP_GATEWAY_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(gateway.apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });
    const payload = await parseResponseJson(response);
    if (!response.ok || payload.error) {
      const message = typeof payload.error === 'string'
        ? payload.error
        : payload.error?.message || `Gateway ping returned HTTP ${response.status}`;
      throw new RunnerError(message, {
        code: classifyMessage(message),
        status: response.status,
        details: payload,
      });
    }
    return payload.result || payload;
  } catch (error) {
    if (error instanceof RunnerError) throw error;
    throw new CliError(`Unable to ping WebMCP gateway at ${gateway.apiUrl}: ${error.message}`, {
      code: 'GATEWAY_UNAVAILABLE',
      exitCode: 3,
      cause: error,
    });
  } finally {
    cleanup();
  }
}

async function checkGateway(gateway, profileId) {
  const health = await fetchHealth(gateway);
  let ping = null;
  let pingError = null;

  try {
    ping = await pingGateway(gateway, profileId);
  } catch (error) {
    pingError = {
      code: error.code || 'GATEWAY_PING_FAILED',
      message: error.message,
      status: error.status,
      details: error.details,
    };
  }

  return {
    ok: !pingError,
    gateway: {
      name: gateway.name,
      apiUrl: gateway.apiUrl,
      healthUrl: gateway.healthUrl,
    },
    health,
    ping,
    pingError,
  };
}

module.exports = {
  fetchHealth,
  pingGateway,
  checkGateway,
};

const fs = require('fs');
const path = require('path');
const { CliError } = require('./errors');
const { defaultHealthUrl, toAbsolutePath } = require('./paths');
const { getDefaultHistoryDir, getWebmcpHome } = require('./home');

const DEFAULT_GATEWAY_NAME = 'local';
const DEFAULT_GATEWAY_URL = 'http://localhost:7865/api';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function defaultConfig(env = {}) {
  return {
    defaultGateway: DEFAULT_GATEWAY_NAME,
    gateways: {
      [DEFAULT_GATEWAY_NAME]: {
        apiUrl: env.gatewayUrl || DEFAULT_GATEWAY_URL,
        healthUrl: defaultHealthUrl(env.gatewayUrl || DEFAULT_GATEWAY_URL),
        healthTimeoutMs: 3000,
        profiles: {},
      },
    },
    defaults: {
      timeoutMs: 30000,
      strict: false,
      allowUnknownCommand: false,
      historyDir: getDefaultHistoryDir(),
      redactKeys: ['token', 'password', 'cookie', 'authorization', 'apiKey'],
    },
    workflows: {},
  };
}

function normalizeGateway(name, gateway) {
  if (typeof gateway === 'string') {
    return {
      apiUrl: gateway,
      healthUrl: defaultHealthUrl(gateway),
      healthTimeoutMs: 3000,
      profiles: {},
    };
  }

  const apiUrl = gateway.apiUrl || gateway.url;
  return {
    ...gateway,
    apiUrl,
    healthUrl: gateway.healthUrl || defaultHealthUrl(apiUrl),
    healthTimeoutMs: gateway.healthTimeoutMs || 3000,
    profiles: gateway.profiles || {},
  };
}

function normalizeConfig(raw, configDir, env = {}) {
  const base = defaultConfig(env);
  const source = isObject(raw) ? raw : {};
  const gateways = {};
  const rawGateways = isObject(source.gateways) ? source.gateways : base.gateways;

  for (const [name, gateway] of Object.entries(rawGateways)) {
    gateways[name] = normalizeGateway(name, gateway);
  }

  return {
    ...base,
    ...source,
    configDir,
    defaultGateway: source.defaultGateway || base.defaultGateway,
    gateways,
    defaults: {
      ...base.defaults,
      ...(source.defaults || {}),
    },
    workflows: source.workflows || {},
  };
}

function validateConfig(config) {
  const errors = [];

  if (!isObject(config.gateways) || Object.keys(config.gateways).length === 0) {
    errors.push('gateways must be a non-empty object');
  } else {
    for (const [name, gateway] of Object.entries(config.gateways)) {
      if (!isObject(gateway)) {
        errors.push(`gateways.${name} must be an object or URL string`);
        continue;
      }
      if (!gateway.apiUrl || typeof gateway.apiUrl !== 'string') {
        errors.push(`gateways.${name}.apiUrl is required`);
      }
      if (gateway.healthTimeoutMs !== undefined && !positiveInteger(gateway.healthTimeoutMs)) {
        errors.push(`gateways.${name}.healthTimeoutMs must be a positive integer`);
      }
      if (gateway.profiles !== undefined && !isObject(gateway.profiles)) {
        errors.push(`gateways.${name}.profiles must be an object`);
      }
      if (gateway.defaultProfile !== undefined && typeof gateway.defaultProfile !== 'string') {
        errors.push(`gateways.${name}.defaultProfile must be a string`);
      }
    }
  }

  if (config.defaultGateway && !config.gateways[config.defaultGateway]) {
    errors.push(`defaultGateway "${config.defaultGateway}" does not exist in gateways`);
  }

  if (!isObject(config.defaults)) {
    errors.push('defaults must be an object');
  } else {
    if (config.defaults.timeoutMs !== undefined && !positiveInteger(config.defaults.timeoutMs)) {
      errors.push('defaults.timeoutMs must be a positive integer');
    }
    // Reserved for the Phase B headless agent fallback (CLI-spawns-AI on
    // failure). Shape-validated now so the key is stable; the runner ignores
    // it today.
    const agentFallback = config.defaults.agentFallback;
    if (agentFallback !== undefined) {
      if (!isObject(agentFallback)) {
        errors.push('defaults.agentFallback must be an object');
      } else {
        if (agentFallback.enabled !== undefined && typeof agentFallback.enabled !== 'boolean') {
          errors.push('defaults.agentFallback.enabled must be a boolean');
        }
        if (agentFallback.command !== undefined && typeof agentFallback.command !== 'string') {
          errors.push('defaults.agentFallback.command must be a string');
        }
        if (agentFallback.args !== undefined && !Array.isArray(agentFallback.args)) {
          errors.push('defaults.agentFallback.args must be an array');
        }
        if (agentFallback.timeoutMs !== undefined && !positiveInteger(agentFallback.timeoutMs)) {
          errors.push('defaults.agentFallback.timeoutMs must be a positive integer');
        }
      }
    }
  }

  if (!isObject(config.workflows)) {
    errors.push('workflows must be an object');
  } else {
    for (const [id, workflow] of Object.entries(config.workflows)) {
      if (!isObject(workflow)) {
        errors.push(`workflows.${id} must be an object`);
        continue;
      }
      if (!workflow.path || typeof workflow.path !== 'string') {
        errors.push(`workflows.${id}.path is required`);
      }
      if (workflow.gateway && !config.gateways[workflow.gateway]) {
        errors.push(`workflows.${id}.gateway references unknown gateway "${workflow.gateway}"`);
      }
      if (workflow.variables !== undefined && !isObject(workflow.variables)) {
        errors.push(`workflows.${id}.variables must be an object`);
      }
      if (workflow.timeoutMs !== undefined && !positiveInteger(workflow.timeoutMs)) {
        errors.push(`workflows.${id}.timeoutMs must be a positive integer`);
      }
      if (workflow.schedule?.enabled && !positiveInteger(workflow.schedule.intervalMs)) {
        errors.push(`workflows.${id}.schedule.intervalMs must be a positive integer when schedule is enabled`);
      }
    }
  }

  return errors;
}

const CONFIG_BASENAME = 'dispatcher.config.json';

// Where an implicit config may live, in priority order. `gateways.<name>.profiles`
// is a per-machine alias map (alias → real Chrome profileId), so it needs a home
// on the machine — not in a store/automation repo that is published and shared.
// The home entry is what lets a pipeline outside the store tree still resolve
// `"profile": "gemini"`. See
// docs/20260715_store_root_and_config_decoupling_plan.md.
function implicitConfigPaths(cwd) {
  return [path.resolve(cwd, CONFIG_BASENAME), path.join(getWebmcpHome(), CONFIG_BASENAME)];
}

function loadConfig(options = {}) {
  const env = options.env || {};
  const cwd = options.cwd || process.cwd();
  const explicitPath = options.configPath;
  // An explicit path is used as-is and must exist (checked below). Otherwise
  // take the first implicit path that exists; when none do, keep the cwd path so
  // error messages and `configDir` resolution stay stable, and fall through to
  // defaults without throwing.
  const candidates = implicitConfigPaths(cwd);
  const configPath = explicitPath
    ? toAbsolutePath(explicitPath, cwd)
    : candidates.find((p) => fs.existsSync(p)) || candidates[0];
  let raw = {};
  let exists = false;

  if (fs.existsSync(configPath)) {
    exists = true;
    try {
      raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new CliError(`Invalid config JSON at ${configPath}: ${error.message}`, {
        code: 'CONFIG_PARSE_ERROR',
        exitCode: 2,
        cause: error,
      });
    }
  } else if (explicitPath) {
    throw new CliError(`Config file not found: ${configPath}`, {
      code: 'CONFIG_NOT_FOUND',
      exitCode: 2,
    });
  }

  const config = normalizeConfig(raw, path.dirname(configPath), env);
  config.configPath = exists ? configPath : null;
  config.configExists = exists;

  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new CliError('Invalid dispatcher config', {
      code: 'CONFIG_VALIDATION_ERROR',
      exitCode: 2,
      details: errors,
    });
  }

  return config;
}

module.exports = {
  DEFAULT_GATEWAY_URL,
  defaultConfig,
  loadConfig,
  validateConfig,
};

const { CliError } = require('./errors');
const { defaultHealthUrl } = require('./paths');

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function resolveGateway(config, gatewayArg, workflowEntry = {}) {
  const requested = gatewayArg || workflowEntry.gateway || config.defaultGateway;
  if (looksLikeUrl(requested)) {
    return {
      name: null,
      apiUrl: requested,
      healthUrl: defaultHealthUrl(requested),
      healthTimeoutMs: config.defaults?.healthTimeoutMs || 3000,
      profiles: {},
      source: 'arg-url',
    };
  }

  const gatewayName = requested || 'local';
  const gateway = config.gateways[gatewayName];
  if (!gateway) {
    throw new CliError(`Unknown gateway "${gatewayName}"`, {
      code: 'GATEWAY_CONFIG_NOT_FOUND',
      exitCode: 2,
    });
  }

  return {
    name: gatewayName,
    ...gateway,
    source: gatewayArg ? 'arg-name' : (workflowEntry.gateway ? 'workflow' : 'default'),
  };
}

function resolveProfile(config, gateway, workflowEntry = {}, options = {}) {
  const profiles = gateway.profiles || {};
  const candidates = [
    { value: options.profile, source: 'arg' },
    { value: workflowEntry.profile, source: 'workflow' },
    { value: gateway.defaultProfile, source: 'gateway-default' },
    { value: options.envProfileId, source: 'env' },
  ];
  const selected = candidates.find((candidate) => candidate.value);

  if (!selected) {
    return {
      profileId: undefined,
      profileAlias: undefined,
      profileSource: 'none',
    };
  }

  const profileId = profiles[selected.value] || selected.value;
  return {
    profileId,
    profileAlias: profiles[selected.value] ? selected.value : undefined,
    profileSource: selected.source,
  };
}

function assertProfileAvailable(health, profileId) {
  if (!profileId) {
    if (health && Number(health.profileCount) > 1) {
      throw new CliError('Multiple profiles are connected; pass --profile or configure a default profile', {
        code: 'PROFILE_REQUIRED',
        exitCode: 2,
        details: { profiles: health.profiles, profileDetails: health.profileDetails },
      });
    }
    return;
  }

  const profiles = Array.isArray(health?.profiles) ? health.profiles : [];
  if (profiles.length > 0 && !profiles.includes(profileId)) {
    throw new CliError(`Profile "${profileId}" is not connected to the gateway`, {
      code: 'PROFILE_NOT_FOUND',
      exitCode: 2,
      details: { profiles, profileDetails: health.profileDetails },
    });
  }
}

module.exports = {
  resolveGateway,
  resolveProfile,
  assertProfileAvailable,
};

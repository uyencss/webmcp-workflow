const { loadConfig } = require('../config-loader');
const { readEnv } = require('../env-loader');
const { checkGateway } = require('../gateway-health');
const { assertProfileAvailable, resolveGateway, resolveProfile } = require('../profile-resolver');
const { printDoctor, writeJson } = require('../output');
const { WEBMCP_EXTENSION_ID, WEBMCP_EXTENSION_STORE_URL } = require('../extension-info');

async function doctorCommand(args, context) {
  const { options, stdout } = context;
  const env = readEnv();
  const config = loadConfig({ configPath: options.config, cwd: context.cwd, env });
  const gateway = resolveGateway(config, options.gateway);
  const profile = resolveProfile(config, gateway, {}, {
    profile: options.profile,
    envProfileId: env.profileId,
  });
  const result = await checkGateway(gateway, profile.profileId);
  assertProfileAvailable(result.health, profile.profileId);
  const payload = {
    ...result,
    profile,
    extension: {
      id: WEBMCP_EXTENSION_ID,
      chromeWebStoreUrl: WEBMCP_EXTENSION_STORE_URL,
    },
  };

  if (options.json) writeJson(stdout, payload);
  else printDoctor(stdout, payload);
  return result.ok ? 0 : 3;
}

module.exports = {
  doctorCommand,
};

const { loadConfig } = require('../config-loader');
const { readEnv } = require('../env-loader');
const { resolveGateway } = require('../profile-resolver');
const { fetchHealth } = require('../gateway-health');
const { printProfiles, writeJson } = require('../output');

async function profilesCommand(args, context) {
  const { options, stdout } = context;
  const env = readEnv();
  const config = loadConfig({ configPath: options.config, cwd: context.cwd, env });
  const gateway = resolveGateway(config, options.gateway);
  const health = await fetchHealth(gateway);
  const result = { ok: true, gateway, health };

  if (options.json) writeJson(stdout, result);
  else printProfiles(stdout, result);
  return 0;
}

module.exports = {
  profilesCommand,
};

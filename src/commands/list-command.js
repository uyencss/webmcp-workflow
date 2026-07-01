const { loadConfig } = require('../config-loader');
const { readEnv } = require('../env-loader');
const { listConfiguredWorkflows } = require('../workflow-registry');
const { printList, writeJson } = require('../output');

async function listCommand(args, context) {
  const { options, stdout } = context;
  const env = readEnv();
  const config = loadConfig({ configPath: options.config, cwd: context.cwd, env });
  const workflows = listConfiguredWorkflows(config);

  if (options.json) writeJson(stdout, { ok: true, workflows });
  else printList(stdout, workflows);
  return 0;
}

module.exports = {
  listCommand,
};

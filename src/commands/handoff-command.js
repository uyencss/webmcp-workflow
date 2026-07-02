const { loadConfig } = require('../config-loader');
const { readEnv } = require('../env-loader');
const { resolveRun, buildHandoffPackage, renderHandoffMarkdown } = require('../handoff');
const { writeJson } = require('../output');

async function handoffCommand(args, context) {
  const { options, stdout } = context;
  const env = readEnv();
  const config = loadConfig({ configPath: options.config, cwd: context.cwd, env });
  const historyDir = options.historyDir || config.defaults.historyDir;
  const baseDir = config.configDir || context.cwd;

  const { runId, runDir } = resolveRun(args[0] || 'latest', { historyDir, baseDir });
  const pkg = buildHandoffPackage({ runDir, runId, redactKeys: config.defaults.redactKeys });

  if (options.json) {
    writeJson(stdout, { ok: true, runId, ...pkg });
  } else {
    stdout.write(renderHandoffMarkdown(pkg));
  }

  return 0;
}

module.exports = {
  handoffCommand,
};

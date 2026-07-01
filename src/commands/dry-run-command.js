const { loadConfig } = require('../config-loader');
const { readEnv } = require('../env-loader');
const { resolveWorkflow } = require('../workflow-registry');
const { buildDryRunReport } = require('../executor');
const { printDryRun, writeJson } = require('../output');

async function dryRunCommand(args, context) {
  const { options, stdout } = context;
  const env = readEnv();
  const config = loadConfig({ configPath: options.config, cwd: context.cwd, env });
  const resolved = resolveWorkflow(args[0], {
    config,
    options: { ...options, cwd: context.cwd },
    env,
  });
  const report = buildDryRunReport(resolved);

  if (options.json || options.jsonEvents) writeJson(stdout, { ok: report.validation.valid, ...report });
  else printDryRun(stdout, report);

  return report.validation.valid ? 0 : 2;
}

module.exports = {
  dryRunCommand,
};

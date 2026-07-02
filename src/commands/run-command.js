const { loadConfig } = require('../config-loader');
const { readEnv } = require('../env-loader');
const { resolveWorkflow } = require('../workflow-registry');
const { executeWorkflow } = require('../executor');
const { writeJson } = require('../output');

async function runCommand(args, context) {
  const { options, stdout } = context;
  const env = readEnv();
  const config = loadConfig({ configPath: options.config, cwd: context.cwd, env });
  const workflowInput = args[0];
  const resolved = resolveWorkflow(workflowInput, {
    config,
    options: {
      ...options,
      cwd: context.cwd,
    },
    env,
  });

  const result = await executeWorkflow(resolved, {
    runId: options.runId,
    json: options.json,
    jsonEvents: options.jsonEvents,
    stdout,
    stderr: context.stderr,
    signal: context.signal,
    history: options.history !== false,
  });

  if (options.json) {
    const payload = { ok: result.exitCode === 0, summary: result.summary, history: result.history };
    if (result.exitCode !== 0 && result.summary?.runId) {
      payload.handoff = {
        hint: `${context.commandName || 'webmcp-workflow'} handoff ${result.summary.runId}`,
        runId: result.summary.runId,
        playbookFound: Boolean(result.summary.playbook?.exists),
      };
    }
    writeJson(stdout, payload);
  }
  return result.exitCode;
}

module.exports = {
  runCommand,
};

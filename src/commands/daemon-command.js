const { loadConfig } = require('../config-loader');
const { readEnv } = require('../env-loader');
const { WorkflowDispatcher } = require('../dispatcher');
const { writeJson } = require('../output');

async function daemonCommand(args, context) {
  const { options, stdout, stderr } = context;
  const env = readEnv();
  const config = loadConfig({ configPath: options.config, cwd: context.cwd, env });
  const dispatcher = new WorkflowDispatcher(config, {
    ...options,
    env,
    stdout,
    stderr,
  });
  const count = dispatcher.start();

  if (options.json) writeJson(stdout, { ok: true, scheduled: count });
  else stdout.write(`Workflow dispatcher daemon started with ${count} scheduled workflow(s).\n`);

  if (count === 0) return 0;

  await new Promise((resolve) => {
    const stop = () => {
      dispatcher.stop();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

module.exports = {
  daemonCommand,
};

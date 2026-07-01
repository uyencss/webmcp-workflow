const { loadConfig } = require('../config-loader');
const { readEnv } = require('../env-loader');
const { resolveWorkflow } = require('../workflow-registry');
const { validateResolvedWorkflow } = require('../executor');
const { printValidation, writeJson } = require('../output');

async function validateCommand(args, context) {
  const { options, stdout } = context;
  const env = readEnv();
  const config = loadConfig({ configPath: options.config, cwd: context.cwd, env });
  const resolved = resolveWorkflow(args[0], {
    config,
    options: { ...options, cwd: context.cwd },
    env,
  });
  const { validation, normalized } = validateResolvedWorkflow(resolved);

  if (options.json) {
    writeJson(stdout, {
      ok: validation.valid,
      workflowFile: resolved.workflowFile,
      workflow: { id: normalized.id, name: normalized.name, version: normalized.version || '1.0' },
      validation,
    });
  } else {
    stdout.write(`Loaded: ${resolved.workflowFile}\n`);
    printValidation(stdout, validation);
  }

  return validation.valid ? 0 : 2;
}

module.exports = {
  validateCommand,
};

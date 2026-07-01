const fs = require('fs');
const path = require('path');
const { CliError } = require('./errors');
const { EXAMPLES_ROOT, toAbsolutePath } = require('./paths');
const { resolveGateway, resolveProfile } = require('./profile-resolver');

function readJsonFile(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new CliError(`Invalid ${label} JSON at ${filePath}: ${error.message}`, {
      code: 'JSON_PARSE_ERROR',
      exitCode: 2,
      cause: error,
    });
  }
}

function resolveWorkflowPath(inputPath, baseDir) {
  let workflowFile = toAbsolutePath(inputPath, baseDir);
  if (fs.existsSync(workflowFile)) return workflowFile;

  const normalized = inputPath.startsWith('./') ? inputPath.slice(2) : inputPath;
  if (normalized.startsWith('workflows/')) {
    const examplePath = path.join(EXAMPLES_ROOT, normalized);
    if (fs.existsSync(examplePath)) return examplePath;
  }

  throw new CliError(`Workflow file not found: ${workflowFile}`, {
    code: 'WORKFLOW_NOT_FOUND',
    exitCode: 2,
  });
}

function loadWorkflowFile(inputPath, baseDir) {
  const workflowFile = resolveWorkflowPath(inputPath, baseDir);
  return {
    workflowFile,
    workflow: readJsonFile(workflowFile, 'workflow'),
  };
}

function listConfiguredWorkflows(config) {
  return Object.entries(config.workflows || {}).map(([id, workflow]) => {
    const gateway = config.gateways[workflow.gateway || config.defaultGateway];
    return {
      id,
      description: workflow.description || '',
      path: workflow.path,
      gateway: workflow.gateway || config.defaultGateway,
      profile: workflow.profile || gateway?.defaultProfile || '',
      scheduled: Boolean(workflow.schedule?.enabled),
    };
  });
}

function resolveWorkflow(input, context) {
  if (!input) {
    throw new CliError('Workflow id or path is required', {
      code: 'USAGE_ERROR',
      exitCode: 2,
    });
  }

  const { config, options = {}, env = {} } = context;
  const configured = config.workflows && config.workflows[input];
  const workflowEntry = configured || {};
  const workflowId = configured ? input : undefined;
  const baseDir = configured ? config.configDir : (options.cwd || process.cwd());
  const workflowPath = configured ? workflowEntry.path : input;
  const { workflowFile, workflow } = loadWorkflowFile(workflowPath, baseDir);
  const gateway = resolveGateway(config, options.gateway, workflowEntry);
  const profile = resolveProfile(config, gateway, workflowEntry, {
    profile: options.profile,
    envProfileId: env.profileId,
  });
  const timeoutMs = options.timeoutMs || workflowEntry.timeoutMs || config.defaults.timeoutMs;
  const variables = {
    ...(workflowEntry.variables || {}),
    ...(options.variables || {}),
  };

  return {
    workflowId,
    workflowFile,
    workflow,
    workflowEntry,
    gateway,
    profile,
    variables,
    timeoutMs,
    strict: options.strict ?? config.defaults.strict,
    allowUnknownCommand: options.allowUnknownCommand ?? config.defaults.allowUnknownCommand,
    historyDir: options.historyDir || config.defaults.historyDir,
    configDir: config.configDir,
    redactKeys: config.defaults.redactKeys,
    metadata: {
      source: configured ? 'config' : 'path',
      configuredId: workflowId,
    },
  };
}

module.exports = {
  loadWorkflowFile,
  listConfiguredWorkflows,
  resolveWorkflow,
};

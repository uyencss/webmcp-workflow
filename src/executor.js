const path = require('path');
const {
  WorkflowRunner,
  normalizeWorkflow,
  validateWorkflow,
  extractTemplatePaths,
  getCommand,
  getCommandGroups,
  isUnsupportedCommand,
  getUnsupportedReason,
} = require('./runner');
const { EventLogger } = require('./event-logger');
const { createRunHistory, writeJson, appendJsonLine } = require('./run-history');
const { redact } = require('./redaction');

function statusToExitCode(summary) {
  if (!summary) return 1;
  if (summary.status === 'completed' || summary.status === 'completed_with_errors') return 0;
  const code = summary.error?.code;
  if (code === 'ABORTED') return 130;
  if (code === 'VALIDATION_ERROR') return 2;
  if (code === 'GATEWAY_UNAVAILABLE') return 3;
  if (code === 'PROFILE_REQUIRED' || code === 'PROFILE_NOT_FOUND') return 2;
  return 1;
}

function buildRouteSummary(steps) {
  const routes = [];
  for (const step of steps || []) {
    if (step.onSuccess) routes.push({ from: step.id, type: 'onSuccess', to: step.onSuccess });
    if (typeof step.onFailure === 'string') {
      routes.push({ from: step.id, type: 'onFailure', to: step.onFailure });
    } else if (step.onFailure && typeof step.onFailure === 'object') {
      for (const [code, target] of Object.entries(step.onFailure)) {
        routes.push({ from: step.id, type: `onFailure.${code}`, to: target });
      }
    }
  }
  return routes;
}

function buildUsedCommands(steps) {
  const commands = new Set();
  for (const step of steps || []) {
    if (step.command) commands.add(step.command);
    if (step.fallback?.command) commands.add(step.fallback.command);
    if (step.strategy === 'ai-vision') {
      commands.add('getInteractiveElements');
      commands.add('dispatchClick');
    }
    if (step.strategy === 'aria-ref') {
      const action = step.params?.action || step.action || 'click';
      const actionCommands = {
        click: 'clickByRef',
        type: 'typeByRef',
        hover: 'hoverByRef',
        select: 'selectByRef',
      };
      commands.add('getAriaSnapshot');
      if (actionCommands[action]) commands.add(actionCommands[action]);
    }
  }

  return Array.from(commands).sort().map((name) => {
    const command = getCommand(name);
    return {
      name,
      known: Boolean(command),
      group: command?.group,
      unsupported: isUnsupportedCommand(name),
      reason: isUnsupportedCommand(name) ? getUnsupportedReason(name) : undefined,
    };
  });
}

function buildDryRunReport(resolved) {
  const normalized = normalizeWorkflow(resolved.workflow, {
    defaultTimeout: resolved.timeoutMs,
  });
  const validation = validateWorkflow(normalized, {
    strict: resolved.strict,
    allowUnknownCommand: resolved.allowUnknownCommand,
    runtimeVariables: resolved.variables,
  });

  return {
    workflowFile: resolved.workflowFile,
    workflow: {
      id: normalized.id,
      name: normalized.name,
      version: normalized.version || '1.0',
      description: normalized.description,
    },
    gateway: {
      name: resolved.gateway.name,
      apiUrl: resolved.gateway.apiUrl,
    },
    profile: resolved.profile,
    settings: normalized.settings,
    validation,
    templateRefs: Array.from(extractTemplatePaths(normalized.steps)).sort(),
    commands: buildUsedCommands(normalized.steps || []),
    routes: buildRouteSummary(normalized.steps || []),
    steps: (normalized.steps || []).map((step) => ({
      id: step.id,
      label: step.label,
      command: step.command,
      strategy: step.strategy,
      action: step.action || step.params?.action,
      critical: step.critical,
      timeoutMs: step.timeoutMs,
      retryPolicy: step.retryPolicy,
      wait: step.wait,
      captureAs: step.captureAs,
      onSuccess: step.onSuccess,
      onFailure: step.onFailure,
    })),
    commandGroups: getCommandGroups().map((group) => ({
      id: group.id,
      label: group.label,
      commands: group.commands.map((command) => command.name),
    })),
  };
}

function validateResolvedWorkflow(resolved) {
  const normalized = normalizeWorkflow(resolved.workflow, {
    defaultTimeout: resolved.timeoutMs,
  });
  const validation = validateWorkflow(normalized, {
    strict: resolved.strict,
    allowUnknownCommand: resolved.allowUnknownCommand,
    runtimeVariables: resolved.variables,
  });
  return { normalized, validation };
}

async function executeWorkflow(resolved, options = {}) {
  const { normalized, validation } = validateResolvedWorkflow(resolved);
  const runId = options.runId;
  let history = null;

  if (!validation.valid) {
    if (options.history !== false) {
      history = createRunHistory({
        historyDir: resolved.historyDir,
        baseDir: resolved.configDir || process.cwd(),
        runId: runId || `${normalized.id || 'workflow'}-${Date.now().toString(36)}`,
      });
      writeJson(history.workflowFile, normalized);
    }
    const summary = {
      runId: runId || null,
      workflowId: normalized.id,
      status: 'failed',
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Workflow validation failed',
        details: validation.errors,
      },
      warnings: validation.warnings,
    };
    if (history) writeJson(history.summaryFile, redact(summary, resolved.redactKeys));
    return { summary, exitCode: 2, validation, history };
  }

  const runner = new WorkflowRunner(resolved.workflow, {
    variables: resolved.variables,
    gatewayUrl: resolved.gateway.apiUrl,
    profileId: resolved.profile.profileId,
    runId,
    timeoutMs: resolved.timeoutMs,
    strictValidation: resolved.strict,
    allowUnknownCommand: resolved.allowUnknownCommand,
    signal: options.signal,
  });

  if (options.history !== false) {
    history = createRunHistory({
      historyDir: resolved.historyDir,
      baseDir: resolved.configDir || process.cwd(),
      runId: runner.runId,
    });
    writeJson(history.workflowFile, normalized);
  }

  const logger = new EventLogger({
    jsonEvents: options.jsonEvents,
    quiet: options.quiet || options.json,
    eventsFile: history?.eventsFile,
    redactKeys: resolved.redactKeys,
    stdout: options.stdout,
    stderr: options.stderr,
  });
  logger.attach(runner);

  const summary = await runner.run();
  const enrichedSummary = {
    ...summary,
    workflowFile: resolved.workflowFile,
    gateway: {
      name: resolved.gateway.name,
      apiUrl: resolved.gateway.apiUrl,
    },
    profile: resolved.profile,
  };
  const safeSummary = redact(enrichedSummary, resolved.redactKeys);

  if (history) {
    writeJson(history.summaryFile, safeSummary);
    appendJsonLine(history.indexFile, {
      runId: safeSummary.runId,
      workflowId: safeSummary.workflowId,
      workflowName: safeSummary.workflowName,
      status: safeSummary.status,
      startedAt: summary.context?.variables?.__TIMESTAMP__,
      endedAt: new Date().toISOString(),
      duration: safeSummary.duration,
      runDir: path.relative(history.historyRoot, history.runDir),
    });
  }

  return {
    summary: safeSummary,
    exitCode: statusToExitCode(summary),
    history,
  };
}

module.exports = {
  buildDryRunReport,
  executeWorkflow,
  statusToExitCode,
  validateResolvedWorkflow,
};

/**
 * @module handoff
 * @description Assembles an AI-readable "handoff package" from a finished (or
 * failed) workflow run so an agent can take over recovery.
 *
 * The package gathers, from a single run directory under the history root:
 *   - the failure context (which step, which error),
 *   - the progress so far (completed steps, captured variables/outputs),
 *   - the remaining steps (from the normalized workflow),
 *   - the paired playbook content (the agent's intent/guardrail reference).
 *
 * It performs reads only — no run is re-executed and no LLM is invoked. The
 * same builder feeds the Phase B headless fallback (its output *is* the prompt).
 */

const fs = require('fs');
const path = require('path');
const { CliError } = require('./errors');
const { resolveHistoryDir } = require('./run-history');
const { redact, DEFAULT_REDACT_KEYS } = require('./redaction');

const MAX_PREVIEW_LENGTH = 200;

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new CliError(`Invalid JSON in run artifact ${filePath}: ${error.message}`, {
      code: 'HANDOFF_PARSE_ERROR',
      exitCode: 2,
      cause: error,
    });
  }
}

function readLastIndexEntry(indexFile) {
  if (!fs.existsSync(indexFile)) return null;
  const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

/**
 * Resolve a run directory from a run id or the sentinel "latest".
 *
 * @param {string} runIdOrLatest
 * @param {{ historyDir: string, baseDir?: string }} options
 * @returns {{ runId: string, runDir: string, historyRoot: string }}
 */
function resolveRun(runIdOrLatest, options = {}) {
  const historyRoot = resolveHistoryDir(options.historyDir, options.baseDir || process.cwd());
  const target = runIdOrLatest || 'latest';

  if (target === 'latest') {
    const entry = readLastIndexEntry(path.join(historyRoot, 'index.jsonl'));
    if (!entry || !entry.runId) {
      throw new CliError(`No runs found in history: ${historyRoot}`, {
        code: 'HANDOFF_NO_RUNS',
        exitCode: 2,
      });
    }
    const runDir = path.join(historyRoot, entry.runDir || entry.runId);
    if (!fs.existsSync(runDir)) {
      throw new CliError(`Latest run directory is missing: ${runDir}`, {
        code: 'HANDOFF_RUN_NOT_FOUND',
        exitCode: 2,
      });
    }
    return { runId: entry.runId, runDir, historyRoot };
  }

  const runDir = path.join(historyRoot, target);
  if (!fs.existsSync(runDir)) {
    throw new CliError(`Run not found: ${target} (looked in ${historyRoot})`, {
      code: 'HANDOFF_RUN_NOT_FOUND',
      exitCode: 2,
    });
  }
  return { runId: target, runDir, historyRoot };
}

function previewValue(value) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text === undefined) return 'undefined';
  return text.length > MAX_PREVIEW_LENGTH ? `${text.slice(0, MAX_PREVIEW_LENGTH)}…` : text;
}

/**
 * Determine the index of the first step the agent should resume from.
 * Prefers the failing result's step index, then the recorded lastStepId,
 * else 0 (whole workflow) when nothing completed.
 */
function resolveResumeIndex(summary, steps) {
  const failing = (summary.results || []).find((result) => result.status === 'failed');
  if (failing && Number.isInteger(failing.stepIndex)) return failing.stepIndex;

  const lastStepId = summary.context?.lastStepId;
  if (lastStepId) {
    const index = steps.findIndex((step) => step.id === lastStepId);
    if (index !== -1) {
      // A completed run's lastStepId is the final step; nothing remains.
      return summary.status === 'completed' ? steps.length : index;
    }
  }
  return summary.status === 'completed' ? steps.length : 0;
}

/**
 * Build a structured handoff package for a resolved run directory.
 *
 * @param {{ runDir: string, runId?: string, redactKeys?: string[] }} options
 * @returns {Object} structured package (see renderHandoffMarkdown for shape use)
 */
function buildHandoffPackage(options = {}) {
  const { runDir } = options;
  const redactKeys = options.redactKeys || DEFAULT_REDACT_KEYS;

  const summary = readJsonIfExists(path.join(runDir, 'summary.json'));
  if (!summary) {
    throw new CliError(`No summary.json in run directory: ${runDir}`, {
      code: 'HANDOFF_NO_SUMMARY',
      exitCode: 2,
    });
  }
  const normalized = readJsonIfExists(path.join(runDir, 'workflow.normalized.json'));
  const steps = Array.isArray(normalized?.steps) ? normalized.steps : [];

  const failing = (summary.results || []).find((result) => result.status === 'failed') || null;
  const resumeIndex = resolveResumeIndex(summary, steps);

  const remainingSteps = steps.slice(resumeIndex).map((step) => ({
    id: step.id,
    type: step.type || 'command',
    command: step.command || null,
    strategy: step.strategy || null,
    paramsPreview: step.params !== undefined ? previewValue(redact(step.params, redactKeys)) : null,
  }));

  const stepStates = summary.context?.steps || {};
  const completedSteps = Object.entries(stepStates)
    .filter(([, state]) => state.status === 'success')
    .map(([id]) => id);
  const skippedSteps = Object.entries(stepStates)
    .filter(([, state]) => state.status === 'skipped')
    .map(([id]) => id);

  const safeVariables = redact(summary.context?.variables || {}, redactKeys);
  const capturedVariables = Object.entries(safeVariables)
    .filter(([key]) => !key.startsWith('__'))
    .map(([key, value]) => ({ key, preview: previewValue(value) }));
  const safeOutputs = redact(summary.context?.outputs || {}, redactKeys);
  const capturedOutputs = Object.entries(safeOutputs)
    .map(([key, value]) => ({ key, preview: previewValue(value) }));

  const playbookMeta = summary.playbook || { path: null, exists: false, source: null };
  let playbookContent = null;
  let playbookFound = false;
  if (playbookMeta.path && fs.existsSync(playbookMeta.path)) {
    playbookContent = fs.readFileSync(playbookMeta.path, 'utf8');
    playbookFound = true;
  }

  return {
    run: {
      runId: summary.runId,
      workflowId: summary.workflowId,
      workflowName: summary.workflowName,
      workflowVersion: summary.workflowVersion,
      status: summary.status,
      workflowFile: summary.workflowFile || null,
      profileId: summary.profile?.profileId || null,
      profileAlias: summary.profile?.profileAlias || null,
      gateway: summary.gateway?.apiUrl || null,
    },
    failure: failing
      ? {
          stepId: failing.stepId,
          stepIndex: failing.stepIndex,
          totalSteps: failing.totalSteps ?? steps.length,
          command: failing.command || null,
          attempts: failing.attempts,
          error: failing.error || null,
        }
      : (summary.error ? { stepId: null, error: summary.error } : null),
    progress: {
      completedSteps,
      skippedSteps,
      capturedVariables,
      capturedOutputs,
    },
    remainingSteps,
    playbook: {
      path: playbookMeta.path,
      found: playbookFound,
      source: playbookMeta.source,
      content: playbookContent,
    },
    instructions: [
      'Honor the playbook\'s Hard identifiers and Never-do sections above all else.',
      `Continue the remaining steps live via the WebMCP gateway (webmcp-browser-automation skill)${
        summary.profile?.profileId ? `, profile ${summary.profile.profileId}` : ''
      }.`,
      'Verify the outcome against the playbook\'s Verification section before reporting success.',
      'Patch the workflow JSON with the durable fix, then run validate + dry-run.',
    ],
  };
}

function renderList(items, render) {
  if (!items || items.length === 0) return '- (none)\n';
  return items.map(render).join('');
}

/**
 * Render a handoff package as agent-readable markdown.
 *
 * @param {Object} pkg - Output of buildHandoffPackage.
 * @returns {string}
 */
function renderHandoffMarkdown(pkg) {
  const { run, failure, progress, remainingSteps, playbook, instructions } = pkg;
  let md = '';

  md += `# Handoff: ${run.workflowName || run.workflowId} (${run.runId})\n\n`;
  md += `Status: ${run.status}   `;
  md += `Profile: ${run.profileAlias || run.profileId || '(auto/single)'}   `;
  md += `Gateway: ${run.gateway || '(default)'}\n`;
  if (run.workflowFile) md += `Workflow file: ${run.workflowFile}\n`;
  md += '\n';

  md += '## Failure\n';
  if (failure) {
    if (failure.stepId) {
      md += `Step \`${failure.stepId}\``;
      if (Number.isInteger(failure.stepIndex)) md += ` (index ${failure.stepIndex}/${failure.totalSteps ?? '?'})`;
      if (failure.command) md += `, command \`${failure.command}\``;
      if (failure.attempts) md += `, attempts ${failure.attempts}`;
      md += '\n';
    }
    const err = failure.error;
    if (err) md += `Error: ${err.code || err.name || 'error'} — ${err.message || ''}\n`;
  } else {
    md += 'No recorded failure (run may have completed or aborted cleanly).\n';
  }
  md += '\n';

  md += '## Progress\n';
  md += `Completed steps:\n${renderList(progress.completedSteps, (id) => `- ${id}\n`)}`;
  if (progress.skippedSteps.length) {
    md += `Skipped steps:\n${renderList(progress.skippedSteps, (id) => `- ${id}\n`)}`;
  }
  md += `Captured variables (redacted):\n${renderList(
    progress.capturedVariables,
    (v) => `- ${v.key}: ${v.preview}\n`,
  )}`;
  if (progress.capturedOutputs.length) {
    md += `Captured outputs (redacted):\n${renderList(
      progress.capturedOutputs,
      (v) => `- ${v.key}: ${v.preview}\n`,
    )}`;
  }
  md += '\n';

  md += '## Remaining steps\n';
  md += renderList(remainingSteps, (step) => {
    const kind = step.strategy ? `strategy:${step.strategy}` : `command:${step.command}`;
    let line = `- \`${step.id}\` (${kind})`;
    if (step.paramsPreview) line += ` params=${step.paramsPreview}`;
    return `${line}\n`;
  });
  md += '\n';

  md += '## Playbook\n';
  if (playbook.found) {
    md += `Source: ${playbook.path} (${playbook.source})\n\n`;
    md += `${playbook.content.trim()}\n`;
  } else {
    md += 'NO PLAYBOOK FOUND — proceed with caution. ';
    md += 'Do not improvise outward-facing actions (sending messages, submitting forms) ';
    md += 'without an explicit target confirmation. Consider authoring a playbook after recovery.\n';
    if (playbook.path) md += `(Expected at: ${playbook.path})\n`;
  }
  md += '\n';

  md += '## Instructions for the recovering agent\n';
  md += instructions.map((line, i) => `${i + 1}. ${line}\n`).join('');

  return md;
}

module.exports = {
  resolveRun,
  buildHandoffPackage,
  renderHandoffMarkdown,
};

'use strict';

/**
 * pipeline command — compose verified workflows into a durable pipeline.
 *
 *   pipeline run <manifest>            Run a *.pipeline.json end to end
 *   pipeline resume <runId>            Continue a paused/failed run from its checkpoint
 *   pipeline approve <runId>           Approve outward-facing stage(s) awaiting a human gate
 *   pipeline reject <runId>            Reject awaiting stage(s)
 *   pipeline scan                      Resume every run whose gate was approved
 *   pipeline status [runId]            Show checkpoints + pending approvals
 */

const fs = require('fs');
const path = require('path');
const { writeJson } = require('../output');
const { CliError } = require('../errors');
const {
  runPipeline, listPending, approvePending, loadCheckpoint,
  checkpointDirFromManifest, webmcpHome,
} = require('../pipeline/pipeline-runner');

function defaultCheckpointDir() {
  return path.join(webmcpHome(), 'pipelines');
}

async function pipelineCommand(positional, context) {
  const { options, stdout } = context;
  const sub = positional[0];
  const rest = positional.slice(1);

  if (!sub || sub === 'help') {
    stdout.write(
      'Usage: pipeline <run|resume|approve|reject|scan|status> [args]\n' +
      '  run <manifest.pipeline.json> [--profile <id>] [--config <path>]\n' +
      '  resume <runId> [manifest]\n' +
      '  approve <runId>\n  reject <runId>\n  scan [manifest]\n  status [runId]\n');
    return 0;
  }

  switch (sub) {
    case 'run': {
      const manifestPath = rest[0];
      if (!manifestPath) throw new CliError('pipeline run needs a manifest path', { code: 'USAGE_ERROR', exitCode: 2 });
      const res = await runPipeline({ manifestPath, cliOptions: options, context });
      if (options.json) writeJson(stdout, res);
      return res.status === 'done' || res.status === 'awaiting-approval' ? 0 : 1;
    }

    case 'resume': {
      const runId = rest[0];
      if (!runId) throw new CliError('pipeline resume needs a runId', { code: 'USAGE_ERROR', exitCode: 2 });
      const cpDir = rest[1] ? checkpointDirFromManifest(rest[1]) : defaultCheckpointDir();
      const cp = loadCheckpoint(cpDir, runId);
      const res = await runPipeline({ manifestPath: cp.manifestRef, resumeRunId: runId, cliOptions: options, context });
      if (options.json) writeJson(stdout, res);
      return res.status === 'done' || res.status === 'awaiting-approval' ? 0 : 1;
    }

    case 'approve':
    case 'reject': {
      const runId = rest[0];
      if (!runId) throw new CliError(`pipeline ${sub} needs a runId`, { code: 'USAGE_ERROR', exitCode: 2 });
      const cpDir = defaultCheckpointDir();
      const stages = approvePending(cpDir, runId, sub === 'approve' ? 'approved' : 'rejected');
      if (options.json) writeJson(stdout, { runId, decision: sub, stages });
      else if (stages.length) {
        stdout.write(`${sub === 'approve' ? '✓ approved' : '✗ rejected'} ${runId}: ${stages.join(', ')}\n`);
        if (sub === 'approve') stdout.write(`  continue: webmcp-workflow pipeline resume ${runId}   (or: pipeline scan)\n`);
      } else stdout.write(`No awaiting-approval stage for runId '${runId}'.\n`);
      return 0;
    }

    case 'scan': {
      const cpDir = rest[0] ? checkpointDirFromManifest(rest[0]) : defaultCheckpointDir();
      const approved = listPending(cpDir).filter((p) => p.status === 'approved');
      const results = [];
      for (const p of approved) {
        const cp = loadCheckpoint(cpDir, p.runId);
        const res = await runPipeline({ manifestPath: cp.manifestRef, resumeRunId: p.runId, cliOptions: options, context });
        results.push({ runId: p.runId, status: res.status });
      }
      if (options.json) writeJson(stdout, { scanned: approved.length, results });
      else stdout.write(approved.length ? `Resumed ${results.length} approved run(s).\n` : 'No approved runs to resume.\n');
      return 0;
    }

    case 'status': {
      const cpDir = defaultCheckpointDir();
      const runId = rest[0];
      const pending = listPending(cpDir).filter((p) => !runId || p.runId === runId);
      const runs = [];
      if (fs.existsSync(cpDir)) {
        for (const d of fs.readdirSync(cpDir)) {
          const f = path.join(cpDir, d, 'checkpoint.json');
          if ((!runId || d === runId) && fs.existsSync(f)) {
            const cp = JSON.parse(fs.readFileSync(f, 'utf8'));
            runs.push({ runId: cp.runId, status: cp.status, completedStages: cp.completedStages, updatedAt: cp.updatedAt });
          }
        }
      }
      if (options.json) { writeJson(stdout, { runs, pending }); return 0; }
      stdout.write(`Checkpoint dir: ${cpDir}\n\nRuns:\n`);
      if (!runs.length) stdout.write('  (none)\n');
      for (const r of runs) stdout.write(`  ${r.runId}  ${r.status}  stages:${r.completedStages}  ${r.updatedAt || ''}\n`);
      stdout.write('\nPending approvals:\n');
      if (!pending.length) stdout.write('  (none)\n');
      for (const p of pending) stdout.write(`  ${p.runId}@${p.stageId}  ${p.status}\n`);
      return 0;
    }

    default:
      throw new CliError(`Unknown pipeline subcommand: ${sub}`, { code: 'USAGE_ERROR', exitCode: 2 });
  }
}

module.exports = { pipelineCommand };

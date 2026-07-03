'use strict';

/**
 * pipeline-runner — durable orchestration over the single-workflow runner.
 *
 * A pipeline composes EXISTING, individually-verified workflows into a chain with
 * inter-stage state handoff, verify-as-gate, pipeline-level checkpoint/resume, a
 * human gate for outward-facing stages, and idempotency so a resume never repeats
 * an already-done outward action. See docs/20260703_pipeline_orchestration_layer.md.
 *
 * Stability comes from the deterministic gates between stages, not from the AI.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const { loadConfig } = require('../config-loader');
const { readEnv } = require('../env-loader');
const { resolveWorkflow } = require('../workflow-registry');
const { executeWorkflow } = require('../executor');
const { gradeSummary } = require('../grade/grade-summary');

// ─── small helpers ────────────────────────────────────────────────────────────

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function webmcpHome() {
  return process.env.WEBMCP_HOME || process.env.WEBMCP_DATA_DIR || path.join(os.homedir(), '.webmcp');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJsonFile(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`);
}

function shortId() {
  return crypto.randomBytes(4).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function hashOf(str) {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 12);
}

function hashFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  return hashOf(fs.readFileSync(file));
}

function gitShaFor(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// Resolve a dotted ref like "PIPELINE.keywords" or "NEWS.items" against state.
function resolveRef(state, ref) {
  const parts = String(ref).split('.');
  let cur = state;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

// Hydrate one `with` value: a sole `{{X.y}}` returns the actual value (object/array
// preserved); an embedded ref does string interpolation (objects JSON-stringified).
function hydrateValue(value, state) {
  if (typeof value !== 'string') return value;
  const sole = value.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
  if (sole) return resolveRef(state, sole[1]);
  return value.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, ref) => {
    const v = resolveRef(state, ref);
    if (v == null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function hydrateWith(withObj, state) {
  const out = {};
  for (const [k, v] of Object.entries(withObj || {})) out[k] = hydrateValue(v, state);
  return out;
}

// Walk up from the manifest to the store root (nearest ancestor containing `sites/`).
function findStoreRoot(manifestPath) {
  let dir = path.dirname(path.resolve(manifestPath));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'sites'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(path.resolve(manifestPath));
}

function stageRisk(stage) {
  return stage.risk || 'read-only';
}

function validateManifest(manifest) {
  const errors = [];
  const stages = Array.isArray(manifest.stages) ? manifest.stages : [];
  const validRisks = new Set(['read-only', 'generate', 'outward-facing', 'destructive']);

  if (!Array.isArray(stages) || !stages.length) {
    errors.push('stages must be a non-empty array');
    return errors;
  }

  stages.forEach((stage, index) => {
    const label = stage.id || `#${index}`;
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) {
      errors.push(`stage ${label} must be an object`);
      return;
    }
    if (!stage.id || typeof stage.id !== 'string') errors.push(`stage ${label} needs a string id`);
    if (!stage.workflow || typeof stage.workflow !== 'string') errors.push(`stage ${label} needs a workflow path`);

    const risk = stageRisk(stage);
    if (!validRisks.has(risk)) {
      errors.push(`stage ${label} has unknown risk '${risk}'`);
    }
    if (risk === 'outward-facing' && (!stage.idempotencyKey || typeof stage.idempotencyKey !== 'string' || !stage.idempotencyKey.trim())) {
      errors.push(`stage ${label} is outward-facing and needs a non-empty idempotencyKey`);
    }
    if (risk === 'destructive') {
      errors.push(`stage ${label} is destructive; destructive stages are blocked by this runner`);
    }
  });

  return errors;
}

function buildStageAnchors(stages, storeRoot) {
  return (stages || []).map((stage, index) => {
    const workflowPath = stage.workflow ? path.resolve(storeRoot, stage.workflow) : null;
    const verifyPath = typeof stage.verify === 'string' ? path.resolve(storeRoot, stage.verify) : null;
    return {
      index,
      id: stage.id || null,
      workflow: stage.workflow || null,
      workflowHash: hashFile(workflowPath),
      verify: typeof stage.verify === 'string' ? stage.verify : null,
      verifyHash: hashFile(verifyPath),
    };
  });
}

function failureAction(onStageFail) {
  if (onStageFail === 'skip') return 'continue';
  if (onStageFail === 'alert') return 'alert';
  return 'stop';
}

function stageFailureStatus(action) {
  if (action === 'continue') return 'running';
  if (action === 'alert') return 'alert';
  return 'failed';
}

// ─── checkpoint / pending / idempotency I/O ─────────────────────────────────────

function runDir(checkpointDir, runId) {
  return path.join(checkpointDir, runId);
}
function checkpointFile(checkpointDir, runId) {
  return path.join(runDir(checkpointDir, runId), 'checkpoint.json');
}
function doneFile(checkpointDir, runId) {
  return path.join(runDir(checkpointDir, runId), 'done.json');
}
function pendingFile(checkpointDir, runId, stageId) {
  return path.join(checkpointDir, 'pending', `${runId}@${stageId}.json`);
}

function writeCheckpoint(checkpointDir, cp) {
  writeJsonFile(checkpointFile(checkpointDir, cp.runId), { ...cp, updatedAt: nowIso() });
}
function loadCheckpoint(checkpointDir, runId) {
  const f = checkpointFile(checkpointDir, runId);
  if (!fs.existsSync(f)) throw new Error(`No checkpoint for runId '${runId}' at ${f}`);
  return readJson(f);
}

function recordDone(checkpointDir, runId, key) {
  if (!key) return;
  const f = doneFile(checkpointDir, runId);
  const done = fs.existsSync(f) ? readJson(f) : {};
  done[key] = { at: nowIso() };
  writeJsonFile(f, done);
}
function isDone(checkpointDir, runId, key) {
  if (!key) return false;
  const f = doneFile(checkpointDir, runId);
  return fs.existsSync(f) && key in readJson(f);
}

// ─── verify-as-gate ─────────────────────────────────────────────────────────────

function gradeStage(verify, summary, storeRoot) {
  if (typeof verify === 'string') {
    const specPath = path.resolve(storeRoot, verify);
    if (!fs.existsSync(specPath)) return { verdict: 'amber', signals: [], reason: `verify spec missing: ${verify}` };
    return gradeSummary(readJson(specPath), summary);
  }
  if (verify && verify.type === 'artifact') {
    const report = (summary.context && summary.context.outputs && summary.context.outputs.FINAL_REPORT) || {};
    const { jsonPathGet } = require('../grade/grade-summary');
    const val = jsonPathGet(report, verify.path || '$');
    const present = val !== undefined && val !== null && val !== '';
    const want = verify.exists !== false;
    return {
      verdict: present === want ? 'green' : 'red',
      signals: [{ id: 'artifact', pass: present === want, detail: `${verify.path} present=${present}` }],
    };
  }
  return { verdict: 'green', signals: [] };
}

// ─── the run loop (shared by run + resume) ──────────────────────────────────────

function loadManifest(manifestPath) {
  const abs = path.resolve(manifestPath);
  if (!fs.existsSync(abs)) throw new Error(`Pipeline manifest not found: ${abs}`);
  return { abs, manifest: readJson(abs) };
}

async function runPipeline({ manifestPath, resumeRunId, cliOptions = {}, context }) {
  const { stdout, stderr, signal } = context;
  const log = (m) => stdout.write(`${m}\n`);
  const warn = (m) => stderr.write(`⚠  ${m}\n`);

  const { abs, manifest } = loadManifest(manifestPath);
  const storeRoot = findStoreRoot(abs);
  const stages = manifest.stages || [];
  const settings = manifest.settings || {};
  const onStageFail = settings.onStageFail || 'stop';
  const checkpointDir = path.resolve(expandHome(settings.checkpointDir || path.join(webmcpHome(), 'pipelines')));
  const manifestHash = hashOf(JSON.stringify(manifest));
  const storeGitSha = gitShaFor(storeRoot);
  const stageAnchors = buildStageAnchors(stages, storeRoot);
  const checkpointBase = { manifestRef: abs, manifestHash, storeGitSha, stageAnchors };
  const manifestErrors = validateManifest(manifest);

  let runId;
  let state;
  let startIndex;

  if (resumeRunId) {
    const cp = loadCheckpoint(checkpointDir, resumeRunId);
    runId = resumeRunId;
    state = cp.state || { PIPELINE: manifest.variables || {} };
    startIndex = cp.completedStages || 0;
    if (cp.manifestHash && cp.manifestHash !== manifestHash) {
      warn(`manifest changed since this run started (hash ${cp.manifestHash} → ${manifestHash}); resuming anyway.`);
    }
    if (cp.storeGitSha && storeGitSha && cp.storeGitSha !== storeGitSha) {
      warn(`store git revision changed since this run started (${cp.storeGitSha} → ${storeGitSha}); resuming anyway.`);
    }
    log(`▶ resume pipeline ${manifest.id} runId=${runId} from stage #${startIndex}`);
  } else {
    runId = `${manifest.id}-${shortId()}`;
    state = { PIPELINE: manifest.variables || {} };
    startIndex = 0;
    if (manifestErrors.length) {
      writeCheckpoint(checkpointDir, { ...checkpointBase, runId, completedStages: 0, status: 'failed', state, errors: manifestErrors });
      return { status: 'failed', runId, reason: manifestErrors.join('; '), errors: manifestErrors };
    }
    writeCheckpoint(checkpointDir, { ...checkpointBase, runId, completedStages: 0, status: 'running', state });
    log(`▶ run pipeline ${manifest.id} runId=${runId} (${stages.length} stages)`);
  }

  if (resumeRunId && manifestErrors.length) {
    writeCheckpoint(checkpointDir, { ...checkpointBase, runId, completedStages: startIndex, status: 'failed', state, errors: manifestErrors });
    return { status: 'failed', runId, reason: manifestErrors.join('; '), errors: manifestErrors };
  }

  const env = readEnv();
  const config = loadConfig({ configPath: cliOptions.config, cwd: storeRoot, env });

  for (let i = startIndex; i < stages.length; i++) {
    const stage = stages[i];
    const gated = stageRisk(stage) === 'outward-facing';

    // ── human gate (outward-facing) ──
    if (gated) {
      const pf = pendingFile(checkpointDir, runId, stage.id);
      const pending = fs.existsSync(pf) ? readJson(pf) : null;
      if (!pending || pending.status === 'awaiting-approval') {
        const hydratedKey = hydrateValue(stage.idempotencyKey, state);
        const idempotencyKey = hydratedKey == null || String(hydratedKey).trim() === '' ? null : String(hydratedKey);
        if (!idempotencyKey) {
          writeCheckpoint(checkpointDir, { ...checkpointBase, runId, completedStages: i, status: 'failed', state, failedStage: stage.id });
          return { status: 'failed', runId, stage: stage.id, reason: 'outward-facing stage needs a resolvable idempotencyKey' };
        }
        writeJsonFile(pf, {
          runId, stageId: stage.id, stageIndex: i, status: 'awaiting-approval',
          workflow: stage.workflow, idempotencyKey,
          artifacts: state, checkpoint: checkpointFile(checkpointDir, runId), createdAt: nowIso(),
        });
        writeCheckpoint(checkpointDir, { ...checkpointBase, runId, completedStages: i, status: 'awaiting-approval', state });
        log(`⏸  stage '${stage.id}' is outward-facing — paused for approval.`);
        log(`   approve: webmcp-workflow pipeline approve ${runId}`);
        return { status: 'awaiting-approval', runId, stage: stage.id, pendingFile: pf };
      }
      if (pending.status === 'rejected') {
        log(`✗  stage '${stage.id}' was rejected — stopping pipeline.`);
        writeCheckpoint(checkpointDir, { ...checkpointBase, runId, completedStages: i, status: 'rejected', state });
        return { status: 'rejected', runId, stage: stage.id };
      }
      // approved → idempotency guard
      if (pending.idempotencyKey && isDone(checkpointDir, runId, pending.idempotencyKey)) {
        log(`↩  stage '${stage.id}' already done (idempotencyKey) — skipping re-execution.`);
        writeCheckpoint(checkpointDir, { ...checkpointBase, runId, completedStages: i + 1, status: 'running', state });
        continue;
      }
    }

    // ── run the child workflow ──
    const hydrated = hydrateWith(stage.with, state);
    const workflowAbs = path.resolve(storeRoot, stage.workflow);
    log(`\n─ stage #${i} '${stage.id}' → ${stage.workflow}  [risk:${stage.risk || 'read-only'}]`);
    const resolved = resolveWorkflow(workflowAbs, {
      config,
      options: { ...cliOptions, variables: hydrated, cwd: storeRoot },
      env,
    });
    const result = await executeWorkflow(resolved, {
      stdout, stderr, signal, history: true, quiet: cliOptions.json,
    });
    const summary = result.summary || {};

    // ── runner-level failure ──
    if (result.exitCode !== 0) {
      warn(`stage '${stage.id}' runner exit ${result.exitCode}`);
      const act = failureAction(onStageFail);
      writeCheckpoint(checkpointDir, { ...checkpointBase, runId, completedStages: i, status: stageFailureStatus(act), state, failedStage: stage.id });
      if (act !== 'continue') return { status: stageFailureStatus(act), runId, stage: stage.id, reason: `runner exit ${result.exitCode}` };
      continue;
    }

    // ── verify-as-gate ──
    if (stage.verify) {
      const graded = gradeStage(stage.verify, summary, storeRoot);
      log(`   verify: ${graded.verdict}${graded.reason ? ` (${graded.reason})` : ''}`);
      if (graded.verdict !== 'green') {
        const act = failureAction(onStageFail);
        writeCheckpoint(checkpointDir, { ...checkpointBase, runId, completedStages: i, status: stageFailureStatus(act), state, failedStage: stage.id });
        if (act !== 'continue') return { status: stageFailureStatus(act), runId, stage: stage.id, reason: `verify ${graded.verdict}` };
        continue;
      }
    }

    // ── capture state ──
    if (stage.captureAs) {
      const outputs = (summary.context && summary.context.outputs) || {};
      state[stage.captureAs] = 'FINAL_REPORT' in outputs ? outputs.FINAL_REPORT : outputs;
    }

    // ── idempotency record for outward-facing ──
    if (gated && stage.idempotencyKey) {
      recordDone(checkpointDir, runId, String(hydrateValue(stage.idempotencyKey, state)));
      const pf = pendingFile(checkpointDir, runId, stage.id);
      if (fs.existsSync(pf)) writeJsonFile(pf, { ...readJson(pf), status: 'done', doneAt: nowIso() });
    }

    writeCheckpoint(checkpointDir, { ...checkpointBase, runId, completedStages: i + 1, status: 'running', state });
  }

  writeCheckpoint(checkpointDir, { ...checkpointBase, runId, completedStages: stages.length, status: 'done', state });
  writeJsonFile(path.join(runDir(checkpointDir, runId), 'pipeline-summary.json'), {
    runId, pipeline: manifest.id, status: 'done', stages: stages.length, state, finishedAt: nowIso(),
  });
  log(`\n✓ pipeline ${manifest.id} done (runId=${runId})`);
  return { status: 'done', runId };
}

// ─── approve / scan / status ────────────────────────────────────────────────────

function pendingDir(checkpointDir) {
  return path.join(checkpointDir, 'pending');
}

function listPending(checkpointDir) {
  const dir = pendingDir(checkpointDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ file: path.join(dir, f), ...readJson(path.join(dir, f)) }));
}

function approvePending(checkpointDir, runId, decision = 'approved') {
  const items = listPending(checkpointDir).filter((p) => p.runId === runId && (p.status === 'awaiting-approval'));
  if (!items.length) return [];
  for (const it of items) writeJsonFile(it.file, { ...it, status: decision, decidedAt: nowIso() });
  return items.map((it) => it.stageId);
}

function checkpointDirFromManifest(manifestPath) {
  try {
    const { manifest } = loadManifest(manifestPath);
    const settings = manifest.settings || {};
    return path.resolve(expandHome(settings.checkpointDir || path.join(webmcpHome(), 'pipelines')));
  } catch {
    return path.join(webmcpHome(), 'pipelines');
  }
}

module.exports = {
  runPipeline,
  listPending,
  approvePending,
  loadCheckpoint,
  loadManifest,
  findStoreRoot,
  checkpointDirFromManifest,
  webmcpHome,
  expandHome,
  hydrateWith,
  gradeStage,
};

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { validateWorkflow, normalizeWorkflow } = require('../src/runner');
const { resolvePlaybook } = require('../src/workflow-registry');
const { resolveRun, buildHandoffPackage, renderHandoffMarkdown } = require('../src/handoff');
const { validateConfig } = require('../src/config-loader');
const { main } = require('../src/cli');

const ROOT = path.resolve(__dirname, '..');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

/* ── Validator ───────────────────────────────────────────── */

test('validator accepts a string playbook field', () => {
  const wf = normalizeWorkflow({ id: 'x', name: 'X', playbook: './x.playbook.md', steps: [{ id: 's', command: 'ping', params: {} }] });
  const result = validateWorkflow(wf);
  assert.equal(result.valid, true, result.errors.join('; '));
});

test('validator rejects a non-string playbook field', () => {
  const wf = normalizeWorkflow({ id: 'x', name: 'X', playbook: 42, steps: [{ id: 's', command: 'ping', params: {} }] });
  const result = validateWorkflow(wf);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('"playbook"')));
});

test('validator rejects an empty-string playbook field', () => {
  const wf = normalizeWorkflow({ id: 'x', name: 'X', playbook: '   ', steps: [{ id: 's', command: 'ping', params: {} }] });
  const result = validateWorkflow(wf);
  assert.equal(result.valid, false);
});

test('validator treats an absent playbook field as valid', () => {
  const wf = normalizeWorkflow({ id: 'x', name: 'X', steps: [{ id: 's', command: 'ping', params: {} }] });
  assert.equal(validateWorkflow(wf).valid, true);
});

/* ── Normalizer regression ───────────────────────────────── */

test('normalizer preserves the playbook field into normalized output', () => {
  const wf = normalizeWorkflow({ id: 'x', name: 'X', playbook: './x.playbook.md', steps: [{ id: 's', command: 'ping', params: {} }] });
  assert.equal(wf.playbook, './x.playbook.md');
});

/* ── Registry resolution ─────────────────────────────────── */

test('registry resolves an explicit playbook field relative to the workflow dir', () => {
  const dir = tmpDir('pb-field-');
  const wfFile = path.join(dir, 'wf.json');
  const pbFile = path.join(dir, 'guide.md');
  fs.writeFileSync(wfFile, '{}');
  fs.writeFileSync(pbFile, '# guide');
  const resolved = resolvePlaybook(wfFile, { playbook: './guide.md' });
  assert.equal(resolved.source, 'field');
  assert.equal(resolved.exists, true);
  assert.equal(resolved.path, pbFile);
});

test('registry flags an explicit playbook field that points at a missing file', () => {
  const dir = tmpDir('pb-missing-');
  const wfFile = path.join(dir, 'wf.json');
  fs.writeFileSync(wfFile, '{}');
  const resolved = resolvePlaybook(wfFile, { playbook: './nope.md' });
  assert.equal(resolved.source, 'field');
  assert.equal(resolved.exists, false);
});

test('registry falls back to the convention sibling file', () => {
  const dir = tmpDir('pb-conv-');
  const wfFile = path.join(dir, 'wf.json');
  const pbFile = path.join(dir, 'wf.playbook.md');
  fs.writeFileSync(wfFile, '{}');
  fs.writeFileSync(pbFile, '# guide');
  const resolved = resolvePlaybook(wfFile, {});
  assert.equal(resolved.source, 'convention');
  assert.equal(resolved.exists, true);
  assert.equal(resolved.path, pbFile);
});

test('registry returns none when no playbook exists', () => {
  const dir = tmpDir('pb-none-');
  const wfFile = path.join(dir, 'wf.json');
  fs.writeFileSync(wfFile, '{}');
  const resolved = resolvePlaybook(wfFile, {});
  assert.equal(resolved.source, null);
  assert.equal(resolved.path, null);
  assert.equal(resolved.exists, false);
});

/* ── Config reserved agentFallback ───────────────────────── */

test('config accepts a well-formed reserved agentFallback block', () => {
  const errors = validateConfig({
    gateways: { local: { apiUrl: 'http://x/api' } },
    defaultGateway: 'local',
    defaults: { agentFallback: { enabled: false, command: 'claude', args: ['-p'], timeoutMs: 1000 } },
    workflows: {},
  });
  assert.deepEqual(errors, []);
});

test('config rejects a malformed agentFallback block', () => {
  const errors = validateConfig({
    gateways: { local: { apiUrl: 'http://x/api' } },
    defaultGateway: 'local',
    defaults: { agentFallback: { enabled: 'yes', args: 'nope' } },
    workflows: {},
  });
  assert.ok(errors.some((e) => e.includes('agentFallback.enabled')));
  assert.ok(errors.some((e) => e.includes('agentFallback.args')));
});

/* ── Handoff builder ─────────────────────────────────────── */

function bakeRun(dir, { summary, normalized, playbookContent }) {
  const runId = summary.runId;
  const runDir = path.join(dir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  let playbookPath = null;
  if (playbookContent !== undefined) {
    playbookPath = path.join(runDir, 'guide.playbook.md');
    fs.writeFileSync(playbookPath, playbookContent);
    summary.playbook = { path: playbookPath, exists: true, source: 'field' };
  }
  writeJson(path.join(runDir, 'summary.json'), summary);
  if (normalized) writeJson(path.join(runDir, 'workflow.normalized.json'), normalized);
  fs.writeFileSync(
    path.join(dir, 'index.jsonl'),
    `${JSON.stringify({ runId, workflowId: summary.workflowId, status: summary.status, runDir: runId })}\n`,
  );
  return { runDir, runId };
}

const NORMALIZED = {
  id: 'wf',
  name: 'WF',
  steps: [
    { id: 'a', command: 'newTab', params: { url: 'https://x' } },
    { id: 'b', command: 'evaluateJS', params: { code: 'return 1;' } },
    { id: 'c', command: 'evaluateJS', params: { code: 'return 2;' } },
  ],
};

function failedSummary() {
  return {
    runId: 'wf-fail1',
    workflowId: 'wf',
    workflowName: 'WF',
    status: 'failed',
    results: [
      { status: 'success', stepId: 'a', stepIndex: 0, command: 'newTab' },
      { status: 'failed', stepId: 'b', stepIndex: 1, totalSteps: 3, command: 'evaluateJS', attempts: 2, error: { code: 'COMMAND_FAILED', message: 'boom' } },
    ],
    context: {
      variables: { TARGET_URL: 'https://x', AUTH_TOKEN: 'super-secret', __RUN_ID__: 'wf-fail1' },
      outputs: {},
      steps: { a: { status: 'success' }, b: { status: 'failed' } },
      lastStepId: 'b',
    },
  };
}

test('handoff builder computes remaining steps from the failed step onward', () => {
  const dir = tmpDir('ho-remain-');
  const { runDir } = bakeRun(dir, { summary: failedSummary(), normalized: NORMALIZED, playbookContent: '# guide' });
  const pkg = buildHandoffPackage({ runDir });
  assert.deepEqual(pkg.remainingSteps.map((s) => s.id), ['b', 'c']);
  assert.deepEqual(pkg.progress.completedSteps, ['a']);
  assert.equal(pkg.failure.stepId, 'b');
});

test('handoff builder redacts secret-named variables', () => {
  const dir = tmpDir('ho-redact-');
  const { runDir } = bakeRun(dir, { summary: failedSummary(), normalized: NORMALIZED, playbookContent: '# guide' });
  const pkg = buildHandoffPackage({ runDir, redactKeys: ['token'] });
  const auth = pkg.progress.capturedVariables.find((v) => v.key === 'AUTH_TOKEN');
  assert.equal(auth.preview, '[REDACTED]');
  const md = renderHandoffMarkdown(pkg);
  assert.ok(!md.includes('super-secret'));
});

test('handoff builder marks a missing playbook explicitly', () => {
  const dir = tmpDir('ho-nopb-');
  const summary = failedSummary();
  const { runDir } = bakeRun(dir, { summary, normalized: NORMALIZED });
  const pkg = buildHandoffPackage({ runDir });
  assert.equal(pkg.playbook.found, false);
  const md = renderHandoffMarkdown(pkg);
  assert.ok(md.includes('NO PLAYBOOK FOUND'));
});

test('handoff builder inlines playbook content when present', () => {
  const dir = tmpDir('ho-pb-');
  const { runDir } = bakeRun(dir, { summary: failedSummary(), normalized: NORMALIZED, playbookContent: '# My Playbook\nNever do X.' });
  const md = renderHandoffMarkdown(buildHandoffPackage({ runDir }));
  assert.ok(md.includes('Never do X.'));
});

test('handoff resolveRun finds the latest run and rejects unknown ids', () => {
  const dir = tmpDir('ho-latest-');
  bakeRun(dir, { summary: failedSummary(), normalized: NORMALIZED, playbookContent: '# g' });
  const { runId } = resolveRun('latest', { historyDir: dir });
  assert.equal(runId, 'wf-fail1');
  assert.throws(() => resolveRun('does-not-exist', { historyDir: dir }), /Run not found/);
});

test('handoff resolveRun errors when history is empty', () => {
  const dir = tmpDir('ho-empty-');
  assert.throws(() => resolveRun('latest', { historyDir: dir }), /No runs found/);
});

/* ── Executor persistence via CLI run (fake gateway) ─────── */

test('run persists playbook metadata into summary and history index', async () => {
  const dir = tmpDir('exec-pb-');
  const wfFile = path.join(dir, 'wf.json');
  const pbFile = path.join(dir, 'wf.playbook.md');
  fs.writeFileSync(wfFile, JSON.stringify({
    id: 'exec-pb', name: 'Exec PB', playbook: './wf.playbook.md',
    steps: [{ id: 'ping', command: 'ping', params: {} }],
  }));
  fs.writeFileSync(pbFile, '# playbook');
  const historyDir = path.join(dir, 'runs');

  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ result: { ok: true } }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  try {
    const exitCode = await main([
      'run', wfFile,
      '--gateway', 'http://gateway.local/api',
      '--profile', 'p1',
      '--history-dir', historyDir,
      '--run-id', 'exec-pb-run',
      '--json',
    ], { cwd: ROOT, stdout: { write() {} }, stderr: { write() {} } });
    assert.equal(exitCode, 0);
  } finally {
    global.fetch = originalFetch;
  }

  const summary = JSON.parse(fs.readFileSync(path.join(historyDir, 'exec-pb-run', 'summary.json'), 'utf8'));
  assert.equal(summary.playbook.exists, true);
  assert.equal(summary.playbook.source, 'field');
  const indexLine = JSON.parse(fs.readFileSync(path.join(historyDir, 'index.jsonl'), 'utf8').trim());
  assert.equal(indexLine.playbook, true);
});

/* ── CLI handoff end-to-end ──────────────────────────────── */

test('CLI handoff renders a package for the latest run', async () => {
  const dir = tmpDir('cli-ho-');
  bakeRun(dir, { summary: failedSummary(), normalized: NORMALIZED, playbookContent: '# CLI Playbook body' });
  let out = '';
  const exitCode = await main(['handoff', 'latest', '--history-dir', dir], {
    cwd: ROOT, stdout: { write(c) { out += c; } }, stderr: { write() {} },
  });
  assert.equal(exitCode, 0);
  assert.ok(out.includes('# Handoff: WF (wf-fail1)'));
  assert.ok(out.includes('Remaining steps'));
  assert.ok(out.includes('CLI Playbook body'));
});

test('CLI handoff --json exposes the structured package', async () => {
  const dir = tmpDir('cli-ho-json-');
  bakeRun(dir, { summary: failedSummary(), normalized: NORMALIZED, playbookContent: '# g' });
  let out = '';
  const exitCode = await main(['handoff', 'wf-fail1', '--history-dir', dir, '--json'], {
    cwd: ROOT, stdout: { write(c) { out += c; } }, stderr: { write() {} },
  });
  assert.equal(exitCode, 0);
  const payload = JSON.parse(out);
  assert.equal(payload.ok, true);
  assert.equal(payload.run.runId, 'wf-fail1');
  assert.deepEqual(payload.remainingSteps.map((s) => s.id), ['b', 'c']);
});

test('CLI handoff on empty history exits 2', async () => {
  const dir = tmpDir('cli-ho-e2-');
  let err = '';
  const exitCode = await main(['handoff', 'latest', '--history-dir', dir], {
    cwd: ROOT, stdout: { write() {} }, stderr: { write(c) { err += c; } },
  });
  assert.equal(exitCode, 2);
  assert.ok(err.includes('No runs found'));
});

test('root help lists the handoff command', async () => {
  let out = '';
  await main(['--help'], { cwd: ROOT, stdout: { write(c) { out += c; } }, stderr: { write() {} } });
  assert.ok(out.includes('handoff <runId|latest>'));
});

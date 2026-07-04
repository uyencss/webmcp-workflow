const assert = require('node:assert/strict');
const test = require('node:test');

const { hasCommand, getCommand } = require('../src/runner/catalog/command-catalog');
const { validateWorkflow } = require('../src/runner/pipeline/workflow-validator');
const { normalizeWorkflow, normalizeStep, normalizeSettings } = require('../src/runner/pipeline/workflow-normalizer');
const { WorkflowContext } = require('../src/runner/pipeline/workflow-context');
const { WorkflowRunner } = require('../src/runner');

/* ── catalog ─────────────────────────────────────────────── */

test('batch is a known orchestration command in the runner catalog', () => {
  assert.equal(hasCommand('batch'), true);
  const command = getCommand('batch');
  assert.equal(command.group, 'orchestration');
  assert.deepEqual(command.requiredParams, ['actions']);
});

/* ── validator: deep validation of actions ───────────────── */

function validate(steps, options) {
  return validateWorkflow(normalizeWorkflow({ id: 'w', name: 'w', steps }), options);
}

test('batch with valid actions passes validation', () => {
  const result = validate([
    { id: 'b', command: 'batch', params: { actions: [{ method: 'getActiveTab' }, { method: 'getPageText' }] } },
  ]);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('batch with empty actions fails validation', () => {
  const result = validate([{ id: 'b', command: 'batch', params: { actions: [] } }]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /non-empty/.test(e)));
});

test('batch with an unknown inner method fails validation', () => {
  const result = validate([{ id: 'b', command: 'batch', params: { actions: [{ method: 'frobnicate' }] } }]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /unknown command "frobnicate"/.test(e)));
});

test('nested batch is rejected', () => {
  const result = validate([
    { id: 'b', command: 'batch', params: { actions: [{ method: 'batch', params: { actions: [] } }] } },
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /nested batch/.test(e)));
});

test('inner action missing a required param fails validation', () => {
  const result = validate([
    { id: 'b', command: 'batch', params: { actions: [{ method: 'clickByRef', params: {} }] } },
  ]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => /missing required param "ref"/.test(e)));
});

test('delay/wait pseudo-actions are allowed inside a batch', () => {
  const result = validate([
    { id: 'b', command: 'batch', params: { actions: [{ method: 'delay', params: { ms: 500 } }, { method: 'getActiveTab' }] } },
  ]);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('template refs inside action params are recognized (known var satisfies ref)', () => {
  const workflow = normalizeWorkflow({
    id: 'w', name: 'w', variables: { REF: 'r1' },
    steps: [{ id: 'b', command: 'batch', params: { actions: [{ method: 'clickByRef', params: { ref: '{{REF}}' } }] } }],
  });
  const result = validateWorkflow(workflow);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('unknown inner method becomes a warning under allowUnknownCommand', () => {
  const result = validate(
    [{ id: 'b', command: 'batch', params: { actions: [{ method: 'frobnicate' }] } }],
    { allowUnknownCommand: true },
  );
  assert.equal(result.valid, true);
  assert.ok(result.warnings.some((w) => /frobnicate/.test(w)));
});

/* ── normalizer: timeout scaling ─────────────────────────── */

test('batch step timeout scales by action count when unset', () => {
  const settings = normalizeSettings({}, {}); // defaultTimeout 30000
  const step = normalizeStep(
    { id: 'b', command: 'batch', params: { actions: [{ method: 'getActiveTab' }, { method: 'getActiveTab' }, { method: 'getActiveTab' }] } },
    0, settings,
  );
  assert.equal(step.timeoutMs, 90000);
});

test('explicit batch timeoutMs is preserved', () => {
  const settings = normalizeSettings({}, {});
  const step = normalizeStep(
    { id: 'b', command: 'batch', timeoutMs: 5000, params: { actions: [{ method: 'getActiveTab' }, { method: 'getActiveTab' }] } },
    0, settings,
  );
  assert.equal(step.timeoutMs, 5000);
});

test('batch timeout scaling is capped at 5 minutes', () => {
  const settings = normalizeSettings({}, {});
  const actions = Array.from({ length: 20 }, () => ({ method: 'getActiveTab' }));
  const step = normalizeStep({ id: 'b', command: 'batch', params: { actions } }, 0, settings);
  assert.equal(step.timeoutMs, 300000); // 30000 * 20 = 600000, capped
});

/* ── capture + interpolation ─────────────────────────────── */

test('batch envelope capture resolves via numeric-index dot-path', () => {
  const ctx = new WorkflowContext();
  ctx.setCaptured('CHAT', {
    total: 1, executed: 1, success: 1, errors: 0,
    results: [{ index: 0, method: 'getPageText', ok: true, result: { text: 'hello world' } }],
  });
  assert.equal(ctx.interpolate('{{CHAT.results.0.result.text}}'), 'hello world');
});

/* ── runner: active-tab tracking + whole-envelope capture ── */

test('runner adopts the last sub-action tabId after a batch and captures the whole envelope', async () => {
  const calls = [];
  const envelope = {
    total: 1, executed: 1, success: 1, errors: 0,
    results: [{ index: 0, method: 'getActiveTab', ok: true, result: { tabId: 777, url: 'https://x' } }],
  };
  const transport = async (command, params) => {
    calls.push({ command, params });
    if (command === 'batch') return envelope;
    return { tabId: 777, text: 'page body' };
  };

  const runner = new WorkflowRunner({
    id: 'batch-tab', name: 'batch tab',
    steps: [
      { id: 'b', command: 'batch', captureAs: 'CAP', params: { actions: [{ method: 'getActiveTab' }] } },
      { id: 'read', command: 'getPageText', params: {} },
    ],
  }, { transport });

  const summary = await runner.run();

  assert.equal(summary.status, 'completed', JSON.stringify(summary.error || summary.warnings));
  // whole batch envelope captured
  assert.deepEqual(summary.context.outputs.CAP, envelope);
  // active tab picked up from the batch → injected into the later step
  const readCall = calls.find((c) => c.command === 'getPageText');
  assert.equal(readCall.params.tabId, 777);
});

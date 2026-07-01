const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const { WorkflowRunner } = require('../src/runner');

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
}

/** Mock transport that echoes the interpolated `code` param back as the result. */
function echoTransport(calls, opts = {}) {
  return async (command, params) => {
    calls.push({ command, params });
    if (opts.failWhenCode !== undefined && params.code === opts.failWhenCode) {
      throw new Error(`boom on ${params.code}`);
    }
    return { result: params.code };
  };
}

test('forEach collect mode aggregates each iteration and exposes item + index scope', async () => {
  const calls = [];
  const runner = new WorkflowRunner(loadFixture('foreach-strings.json'), {
    transport: echoTransport(calls),
  });

  const summary = await runner.run();

  assert.equal(summary.status, 'completed');
  assert.equal(calls.length, 3);
  // {{word}}-{{i}} resolved per iteration
  assert.deepEqual(calls.map((c) => c.params.code), ['alpha-0', 'beta-1', 'gamma-2']);
  // collectAs published as an array
  assert.deepEqual(summary.context.outputs.ALL, ['alpha-0', 'beta-1', 'gamma-2']);
  // loop variables are scoped — they must not leak after the loop
  assert.equal(summary.context.variables.word, undefined);
  assert.equal(summary.context.variables.i, undefined);
});

test('forEach fire-and-forget iterates without collecting', async () => {
  const calls = [];
  const runner = new WorkflowRunner(loadFixture('foreach-fire-and-forget.json'), {
    transport: echoTransport(calls),
  });

  const summary = await runner.run();

  assert.equal(summary.status, 'completed');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.params.code), ['visit 1', 'visit 2', 'visit 3']);
  const record = summary.results.find((r) => r.stepId === 'visit-each');
  assert.equal(record.iterations, 3);
  assert.equal(summary.context.outputs.ALL, undefined);
});

test('forEach fails when items does not resolve to an array', async () => {
  const calls = [];
  const workflow = {
    id: 'bad-items',
    name: 'bad items',
    variables: { NOT_ARRAY: 'hello' },
    steps: [
      {
        id: 'loop',
        type: 'forEach',
        forEach: { items: '{{NOT_ARRAY}}', as: 'x' },
        command: 'evaluateJS',
        params: { code: '{{x}}' },
      },
    ],
  };
  const runner = new WorkflowRunner(workflow, { transport: echoTransport(calls) });

  const summary = await runner.run();

  assert.equal(summary.status, 'failed');
  assert.equal(summary.error.code, 'VALIDATION_ERROR');
  assert.equal(calls.length, 0);
});

test('forEach stops the loop when a critical iteration fails', async () => {
  const calls = [];
  const workflow = {
    id: 'critical-stop',
    name: 'critical stop',
    variables: { NUMS: [1, 2, 3] },
    steps: [
      {
        id: 'loop',
        type: 'forEach',
        forEach: { items: '{{NUMS}}', as: 'n', collectAs: 'ALL' },
        command: 'evaluateJS',
        params: { code: 'n={{n}}' },
        captureAs: 'ONE',
      },
    ],
  };
  const runner = new WorkflowRunner(workflow, {
    transport: echoTransport(calls, { failWhenCode: 'n=2' }),
  });

  const summary = await runner.run();

  assert.equal(summary.status, 'failed');
  // item 1 (ok) + item 2 (fail) — item 3 is never reached
  assert.equal(calls.length, 2);
});

test('non-critical forEach continues past a failing iteration and collects successes', async () => {
  const calls = [];
  const workflow = {
    id: 'non-critical',
    name: 'non critical',
    variables: { NUMS: [1, 2, 3] },
    steps: [
      {
        id: 'loop',
        type: 'forEach',
        critical: false,
        forEach: { items: '{{NUMS}}', as: 'n', collectAs: 'ALL' },
        command: 'evaluateJS',
        params: { code: 'n={{n}}' },
        captureAs: 'ONE',
      },
    ],
  };
  const runner = new WorkflowRunner(workflow, {
    transport: echoTransport(calls, { failWhenCode: 'n=2' }),
  });

  const summary = await runner.run();

  assert.equal(summary.status, 'completed');
  assert.equal(calls.length, 3);
  // only successful iterations contribute to collectAs
  assert.deepEqual(summary.context.outputs.ALL, ['n=1', 'n=3']);
});

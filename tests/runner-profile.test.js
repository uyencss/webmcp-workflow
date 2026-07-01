const assert = require('node:assert/strict');
const test = require('node:test');
const { WorkflowRunner } = require('../src/runner');

test('WorkflowRunner forwards profileId to every transport call without mutating params', async () => {
  const calls = [];
  const workflow = {
    id: 'minimal',
    name: 'Minimal',
    steps: [
      { id: 'ping', command: 'ping', params: { marker: 'keep' } },
    ],
  };
  const runner = new WorkflowRunner(workflow, {
    profileId: 'profile-A',
    transport: async (command, params, options) => {
      calls.push({ command, params, options });
      return { ok: true };
    },
  });

  const summary = await runner.run();
  assert.equal(summary.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'ping');
  assert.deepEqual(calls[0].params, { marker: 'keep' });
  assert.equal(calls[0].options.profileId, 'profile-A');
});

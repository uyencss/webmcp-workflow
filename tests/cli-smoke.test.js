const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const { getCommandName, main } = require('../src/cli');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin/webmcp-workflow-cli.js');

test('CLI help command name follows the invoked binary or explicit bridge override', () => {
  const originalArgv1 = process.argv[1];
  const originalOverride = process.env.WORKFLOW_DISPATCHER_COMMAND_NAME;

  try {
    delete process.env.WORKFLOW_DISPATCHER_COMMAND_NAME;
    process.argv[1] = '/usr/local/bin/webmcp-workflow';
    assert.equal(getCommandName(), 'webmcp-workflow');

    process.env.WORKFLOW_DISPATCHER_COMMAND_NAME = 'webmcp workflow';
    assert.equal(getCommandName(), 'webmcp workflow');
  } finally {
    process.argv[1] = originalArgv1;
    if (originalOverride === undefined) delete process.env.WORKFLOW_DISPATCHER_COMMAND_NAME;
    else process.env.WORKFLOW_DISPATCHER_COMMAND_NAME = originalOverride;
  }
});

test('CLI dry-run returns JSON validation result', () => {
  const result = spawnSync(process.execPath, [
    BIN,
    'dry-run',
    'tests/fixtures/minimal-workflow.json',
    '--json',
    '--no-history',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.workflow.id, 'minimal');
  assert.equal(payload.validation.valid, true);
});

test('CLI resolves configured workflow profile alias', () => {
  const result = spawnSync(process.execPath, [
    BIN,
    'dry-run',
    'minimal',
    '--config',
    'tests/fixtures/dispatcher.config.json',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.profile.profileAlias, 'personal');
  assert.equal(payload.profile.profileId, 'profile-A');
});

test('CLI run executes workflow through gateway with selected profile', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  let output = '';
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ result: { ok: true } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const exitCode = await main([
      'run',
      'tests/fixtures/minimal-workflow.json',
      '--gateway',
      'http://gateway.local/api',
      '--profile',
      'profile-A',
      '--json',
      '--no-history',
    ], {
      cwd: ROOT,
      stdout: { write(chunk) { output += chunk; } },
      stderr: { write() {} },
    });

    assert.equal(exitCode, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {
      method: 'ping',
      params: {},
      profileId: 'profile-A',
    });
    const payload = JSON.parse(output);
    assert.equal(payload.ok, true);
    assert.equal(payload.summary.status, 'completed');
  } finally {
    global.fetch = originalFetch;
  }
});

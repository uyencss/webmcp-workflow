const assert = require('node:assert/strict');
const test = require('node:test');
const { sendCommand } = require('../runner');

test('transport sends profileId as a top-level gateway field', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ result: { ok: true } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const result = await sendCommand('ping', {}, {
      gatewayUrl: 'http://gateway.local/api',
      profileId: 'profile-A',
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(calls[0].url, 'http://gateway.local/api');
    assert.deepEqual(calls[0].body, {
      method: 'ping',
      params: {},
      profileId: 'profile-A',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('transport preserves previous request shape without profileId', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ result: { ok: true } }), { status: 200 });
  };

  try {
    await sendCommand('ping', {}, { gatewayUrl: 'http://gateway.local/api' });
    assert.deepEqual(calls[0], {
      method: 'ping',
      params: {},
    });
  } finally {
    global.fetch = originalFetch;
  }
});

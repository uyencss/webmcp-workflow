const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { checkGateway } = require('../src/gateway-health');

function startFakeGateway() {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        extensionConnected: true,
        profiles: ['profile-A', 'profile-B'],
        profileCount: 2,
        profileDetails: [
          { profileId: 'profile-A', name: 'Personal' },
          { profileId: 'profile-B', name: 'Work' },
        ],
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result: { ok: true, profileId: parsed.profileId } }));
      });
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        requests,
        gateway: {
          name: 'fake',
          apiUrl: `http://127.0.0.1:${port}/api`,
          healthUrl: `http://127.0.0.1:${port}/health`,
          healthTimeoutMs: 1000,
        },
      });
    });
  });
}

test('gateway health check pings selected profileId top-level', async () => {
  const fake = await startFakeGateway();
  try {
    const result = await checkGateway(fake.gateway, 'profile-A');
    assert.equal(result.ok, true);
    assert.equal(result.health.profileCount, 2);
    assert.equal(fake.requests.length, 1);
    assert.deepEqual(fake.requests[0], {
      method: 'ping',
      params: {},
      profileId: 'profile-A',
    });
  } finally {
    await new Promise((resolve) => fake.server.close(resolve));
  }
});

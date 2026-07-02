#!/usr/bin/env node

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin/webmcp-workflow-cli.js');

function startGateway() {
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
          { profileId: 'profile-A', name: 'Smoke Personal' },
          { profileId: 'profile-B', name: 'Smoke Work' },
        ],
      }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        requests.push(payload);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          result: {
            ok: true,
            method: payload.method,
            routedProfileId: payload.profileId,
          },
        }));
      });
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        requests,
        apiUrl: `http://127.0.0.1:${port}/api`,
      });
    });
  });
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const gateway = await startGateway();
  try {
    const result = await runCli([
      'run',
      'tests/fixtures/minimal-workflow.json',
      '--gateway',
      gateway.apiUrl,
      '--profile',
      'profile-A',
      '--json',
      '--history-dir',
      '.workflow-runs-smoke',
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.summary.status, 'completed');
    assert.equal(gateway.requests.length, 1);
    assert.deepEqual(gateway.requests[0], {
      method: 'ping',
      params: {},
      profileId: 'profile-A',
    });

    console.log(JSON.stringify({
      ok: true,
      workflowStatus: payload.summary.status,
      gatewayRequests: gateway.requests.length,
      routedProfileId: gateway.requests[0].profileId,
      runId: payload.summary.runId,
    }, null, 2));
  } finally {
    await new Promise((resolve) => gateway.server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

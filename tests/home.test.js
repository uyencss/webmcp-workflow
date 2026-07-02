const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');

function loadFresh() {
  delete require.cache[require.resolve('../src/home')];
  return require('../src/home');
}

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('WEBMCP_HOME takes highest priority', () => {
  withEnv({ WEBMCP_HOME: '/custom/home', WEBMCP_DATA_DIR: '/legacy/dir' }, () => {
    const { getWebmcpHome, getDefaultHistoryDir } = loadFresh();
    assert.equal(getWebmcpHome(), '/custom/home');
    assert.equal(getDefaultHistoryDir(), path.join('/custom/home', 'workflow-runs'));
  });
});

test('WEBMCP_DATA_DIR is used as a back-compat alias', () => {
  withEnv({ WEBMCP_HOME: undefined, WEBMCP_DATA_DIR: '/legacy/dir' }, () => {
    const { getWebmcpHome } = loadFresh();
    assert.equal(getWebmcpHome(), '/legacy/dir');
  });
});

test('falls back to ~/.webmcp when no env is set', () => {
  withEnv({ WEBMCP_HOME: undefined, WEBMCP_DATA_DIR: undefined }, () => {
    const { getWebmcpHome, getDefaultHistoryDir } = loadFresh();
    assert.equal(getWebmcpHome(), path.join(os.homedir(), '.webmcp'));
    assert.equal(getDefaultHistoryDir(), path.join(os.homedir(), '.webmcp', 'workflow-runs'));
  });
});

test('default history dir is always absolute (cross-platform)', () => {
  withEnv({ WEBMCP_HOME: undefined, WEBMCP_DATA_DIR: undefined }, () => {
    const { getDefaultHistoryDir } = loadFresh();
    assert.equal(path.isAbsolute(getDefaultHistoryDir()), true);
  });
});

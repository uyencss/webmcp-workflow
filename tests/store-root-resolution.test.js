const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const { findStoreRoot } = require('../src/pipeline/pipeline-runner');
const { loadConfig } = require('../src/config-loader');

// Store-root resolution and config resolution, per
// docs/20260715_store_root_and_config_decoupling_plan.md.
//
// Both exist so a pipeline manifest can live OUTSIDE the site store tree — an
// automation repo consuming the store as an npm dependency. The behaviour these
// tests pin down most carefully is the failure: findStoreRoot used to fall back
// to the manifest's own directory, which turned "site store not found" into a
// "workflow not found" pointing at the wrong repo.

const temps = [];
function tmp(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
test.after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// A directory that looks like a site store: the contract is just `sites/`.
function makeStore(prefix = 'webmcp-store-') {
  const root = tmp(prefix);
  mkdirSync(path.join(root, 'sites'), { recursive: true });
  return root;
}

// A manifest with no `sites/` anywhere above it — an automation repo.
function makeDetachedManifest() {
  const root = tmp('webmcp-automations-');
  const dir = path.join(root, 'automations', 'gemini-to-suno');
  mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'pipeline.json');
  writeFileSync(manifest, '{"id":"x","stages":[]}\n');
  return { root, manifest };
}

// ── resolution order ─────────────────────────────────────────────────────────

test('--store-root wins over WEBMCP_STORE_ROOT', () => {
  const flagStore = makeStore('webmcp-store-flag-');
  const envStore = makeStore('webmcp-store-env-');
  const { manifest } = makeDetachedManifest();
  const got = findStoreRoot(manifest, { storeRootOption: flagStore, env: { storeRoot: envStore } });
  assert.equal(got, path.resolve(flagStore));
});

test('WEBMCP_STORE_ROOT is used when no flag is given', () => {
  const envStore = makeStore('webmcp-store-env-');
  const { manifest } = makeDetachedManifest();
  const got = findStoreRoot(manifest, { env: { storeRoot: envStore } });
  assert.equal(got, path.resolve(envStore));
});

test('an in-tree manifest still resolves by upward walk with no flag or env', () => {
  // Regression: this is how `<store>/_cross-site/pipelines/x/pipeline.json`
  // resolves today, and it must keep working untouched.
  const store = makeStore();
  const dir = path.join(store, '_cross-site', 'pipelines', 'deep-research-3way');
  mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'pipeline.json');
  writeFileSync(manifest, '{"id":"x","stages":[]}\n');
  assert.equal(findStoreRoot(manifest, { env: {} }), path.resolve(store));
});

// ── the failure that used to be silent ───────────────────────────────────────

test('a detached manifest with no flag, env, or installed store throws', () => {
  const { manifest } = makeDetachedManifest();
  assert.throws(
    () => findStoreRoot(manifest, { env: {} }),
    (err) => {
      assert.equal(err.code, 'STORE_ROOT_NOT_FOUND');
      assert.equal(err.exitCode, 2);
      // The message must name the dependency problem and the way out, since the
      // old behaviour misdirected the operator to a missing workflow file.
      assert.match(err.message, /Site store not found/);
      assert.match(err.message, /--store-root/);
      assert.ok(Array.isArray(err.details.attempts) && err.details.attempts.length >= 3);
      return true;
    },
  );
});

test('a detached manifest never silently resolves to its own directory', () => {
  const { manifest } = makeDetachedManifest();
  let resolved = null;
  try {
    resolved = findStoreRoot(manifest, { env: {} });
  } catch {
    resolved = 'threw';
  }
  assert.equal(resolved, 'threw');
  assert.notEqual(resolved, path.dirname(manifest));
});

// ── an explicit-but-wrong root is a config error, not a reason to keep guessing ──

test('--store-root without a sites/ directory throws at resolve time', () => {
  const notAStore = tmp('webmcp-not-a-store-');
  const { manifest } = makeDetachedManifest();
  assert.throws(
    () => findStoreRoot(manifest, { storeRootOption: notAStore, env: {} }),
    (err) => {
      assert.equal(err.code, 'STORE_ROOT_INVALID');
      assert.match(err.message, /not a site store/);
      return true;
    },
  );
});

test('a wrong --store-root does not fall through to the upward walk', () => {
  // If it did, a typo'd flag would silently run against a different store.
  const store = makeStore();
  const dir = path.join(store, '_cross-site', 'pipelines', 'x');
  mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'pipeline.json');
  writeFileSync(manifest, '{"id":"x","stages":[]}\n');
  const notAStore = tmp('webmcp-not-a-store-');
  assert.throws(() => findStoreRoot(manifest, { storeRootOption: notAStore, env: {} }), {
    code: 'STORE_ROOT_INVALID',
  });
});

// ── config resolution ────────────────────────────────────────────────────────

test('config is read from cwd, not from the store root', () => {
  // The coupling this change removes: loadConfig used to be called with
  // `cwd: storeRoot`, so a read-only npm dependency was asked for per-machine
  // config.
  const cwd = tmp('webmcp-cwd-');
  writeFileSync(
    path.join(cwd, 'dispatcher.config.json'),
    JSON.stringify({ gateways: { local: { apiUrl: 'http://localhost:7865/api', profiles: { gemini: 'uuid-from-cwd' } } } }),
  );
  const config = loadConfig({ cwd, env: {} });
  assert.equal(config.gateways.local.profiles.gemini, 'uuid-from-cwd');
  assert.equal(config.configExists, true);
});

test('config falls back to the webmcp home when cwd has none', () => {
  const home = tmp('webmcp-home-');
  writeFileSync(
    path.join(home, 'dispatcher.config.json'),
    JSON.stringify({ gateways: { local: { apiUrl: 'http://localhost:7865/api', profiles: { gemini: 'uuid-from-home' } } } }),
  );
  const prev = process.env.WEBMCP_HOME;
  process.env.WEBMCP_HOME = home;
  try {
    const config = loadConfig({ cwd: tmp('webmcp-empty-cwd-'), env: {} });
    assert.equal(config.gateways.local.profiles.gemini, 'uuid-from-home');
  } finally {
    if (prev === undefined) delete process.env.WEBMCP_HOME;
    else process.env.WEBMCP_HOME = prev;
  }
});

test('cwd config wins over the home config', () => {
  const home = tmp('webmcp-home-');
  writeFileSync(
    path.join(home, 'dispatcher.config.json'),
    JSON.stringify({ gateways: { local: { apiUrl: 'http://localhost:7865/api', profiles: { gemini: 'uuid-from-home' } } } }),
  );
  const cwd = tmp('webmcp-cwd-');
  writeFileSync(
    path.join(cwd, 'dispatcher.config.json'),
    JSON.stringify({ gateways: { local: { apiUrl: 'http://localhost:7865/api', profiles: { gemini: 'uuid-from-cwd' } } } }),
  );
  const prev = process.env.WEBMCP_HOME;
  process.env.WEBMCP_HOME = home;
  try {
    assert.equal(loadConfig({ cwd, env: {} }).gateways.local.profiles.gemini, 'uuid-from-cwd');
  } finally {
    if (prev === undefined) delete process.env.WEBMCP_HOME;
    else process.env.WEBMCP_HOME = prev;
  }
});

test('no config anywhere still loads defaults without throwing', () => {
  // Regression: a pipeline whose stages carry literal profileIds and no config
  // must keep working exactly as before.
  const home = tmp('webmcp-home-empty-');
  const prev = process.env.WEBMCP_HOME;
  process.env.WEBMCP_HOME = home;
  try {
    const config = loadConfig({ cwd: tmp('webmcp-empty-cwd-'), env: {} });
    assert.equal(config.configExists, false);
    assert.deepEqual(config.gateways.local.profiles, {});
  } finally {
    if (prev === undefined) delete process.env.WEBMCP_HOME;
    else process.env.WEBMCP_HOME = prev;
  }
});

test('an explicit --config that does not exist still throws', () => {
  assert.throws(() => loadConfig({ cwd: tmp('webmcp-cwd-'), configPath: 'nope.json', env: {} }), {
    code: 'CONFIG_NOT_FOUND',
  });
});

const assert = require('node:assert/strict');
const { mkdtempSync, existsSync, lstatSync, realpathSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('install-agent local copies skill and creates CLI symlink in install home', () => {
  const installHome = mkdtempSync(path.join(tmpdir(), 'workflow-dispatcher-install-'));
  const result = spawnSync(process.execPath, ['scripts/install-agent.mjs', 'local'], {
    cwd: ROOT,
    env: {
      ...process.env,
      WORKFLOW_DISPATCHER_INSTALL_HOME: installHome,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const skillFile = path.join(installHome, '.codex', 'skills', 'workflow-dispatcher-cli', 'SKILL.md');
  assert.equal(existsSync(skillFile), true);

  const cliLink = path.join(installHome, '.local', 'bin', 'workflow-dispatcher');
  assert.equal(existsSync(cliLink), true);
  assert.equal(lstatSync(cliLink).isSymbolicLink(), true);
  assert.equal(realpathSync(cliLink), path.join(ROOT, 'bin', 'workflow-dispatcher.js'));

  const help = spawnSync(cliLink, ['--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Workflow Dispatcher CLI/);
});

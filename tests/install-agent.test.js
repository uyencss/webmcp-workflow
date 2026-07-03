const assert = require('node:assert/strict');
const { mkdtempSync, existsSync, readFileSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('install-agent local copies skill and creates CLI wrapper in install home', () => {
  const installHome = mkdtempSync(path.join(tmpdir(), 'webmcp-workflow-cli-install-'));
  const result = spawnSync(process.execPath, ['scripts/install-agent.mjs', 'local'], {
    cwd: ROOT,
    env: {
      ...process.env,
      WORKFLOW_DISPATCHER_INSTALL_HOME: installHome,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const skillName of ['webmcp-workflow-cli', 'webmcp-workflow-creator', 'webmcp-pipeline-creator']) {
    const skillFile = path.join(installHome, '.codex', 'skills', skillName, 'SKILL.md');
    assert.equal(existsSync(skillFile), true);
  }

  const cliLink = path.join(installHome, '.local', 'bin', 'webmcp-workflow-cli');
  assert.equal(existsSync(cliLink), true);
  assert.equal(statSync(cliLink).mode & 0o111, 0o111);
  assert.match(readFileSync(cliLink, 'utf8'), /bin\/webmcp-workflow-cli\.js/);

  const help = spawnSync(cliLink, ['--help'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Workflow Dispatcher CLI/);
});

test('install-agent cursor exposes all workflow skill rule references', () => {
  const installHome = mkdtempSync(path.join(tmpdir(), 'webmcp-workflow-cli-cursor-'));
  const result = spawnSync(process.execPath, ['scripts/install-agent.mjs', 'cursor'], {
    cwd: ROOT,
    env: {
      ...process.env,
      WORKFLOW_DISPATCHER_INSTALL_HOME: installHome,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);

  for (const skillName of ['webmcp-workflow-cli', 'webmcp-workflow-creator', 'webmcp-pipeline-creator']) {
    const ruleFile = path.join(installHome, '.cursor', 'rules', `${skillName}.mdc`);
    assert.equal(existsSync(ruleFile), true);
    assert.match(readFileSync(ruleFile, 'utf8'), new RegExp(`${skillName}/SKILL\\.md`));
  }
});

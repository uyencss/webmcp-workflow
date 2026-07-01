#!/usr/bin/env node
/**
 * Installer for the Workflow Dispatcher CLI skill.
 *
 * The source skill lives in this repo under skills/workflow-dispatcher-cli.
 * This installer copies it into provider-specific global skill locations so
 * each AI runtime can discover it independently.
 *
 * Usage:
 *   node scripts/install-agent.mjs <local|claude|codex|copilot|gemini|antigravity|cursor|all>
 */

import {
  cpSync,
  existsSync,
  chmodSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_NAME = 'workflow-dispatcher-cli';
const SKILL_SRC = join(ROOT, 'skills', SKILL_NAME);
const BIN_SRC = join(ROOT, 'bin', 'workflow-dispatcher.js');
const INSTALL_HOME = process.env.WORKFLOW_DISPATCHER_INSTALL_HOME || homedir();

const log = (...args) => console.log(...args);
const ok = (message) => log(`  ✓ ${message}`);
const note = (message) => log(`  → ${message}`);
const head = (message) => log(`\n=== ${message} ===`);

function copySkill(dest) {
  if (!existsSync(SKILL_SRC)) {
    note(`Skipping skill: ${SKILL_SRC} not found`);
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(SKILL_SRC, dest, { recursive: true });
  ok(`Skill copied -> ${dest}`);
}

function installLocalBin() {
  const binDir = join(INSTALL_HOME, '.local', 'bin');
  const binPath = join(binDir, 'workflow-dispatcher');
  mkdirSync(binDir, { recursive: true });

  const content = [
    '#!/bin/sh',
    `exec node ${JSON.stringify(BIN_SRC)} "$@"`,
    '',
  ].join('\n');

  rmSync(binPath, { force: true });
  writeFileSync(binPath, content, { mode: 0o755 });
  chmodSync(binPath, 0o755);
  ok(`CLI wrapper installed -> ${binPath}`);
}

function writeIfAbsent(file, content) {
  if (existsSync(file)) {
    note(`${file} already exists; not overwriting. Merge manually if needed.`);
    note('Suggested content:');
    log(content.trim());
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  ok(`Wrote ${file}`);
}

const TARGETS = {
  local() {
    head('Local Codex Test Install');
    copySkill(join(INSTALL_HOME, '.codex', 'skills', SKILL_NAME));
    installLocalBin();
  },

  claude() {
    head('Claude Code');
    copySkill(join(INSTALL_HOME, '.claude', 'skills', SKILL_NAME));
    note('Use the CLI from this checkout:');
    log(`  node ${BIN_SRC} --help`);
  },

  codex() {
    head('Codex');
    copySkill(join(INSTALL_HOME, '.codex', 'skills', SKILL_NAME));
    note('Use the CLI from this checkout, or run `npm run install:local` to create ~/.local/bin/workflow-dispatcher.');
  },

  copilot() {
    head('GitHub Copilot (VS Code)');
    note('Copilot does not support file-based skills. Use this skill text as custom instructions if needed:');
    log(`  ${join(SKILL_SRC, 'SKILL.md')}`);
  },

  gemini() {
    head('Gemini CLI');
    copySkill(join(INSTALL_HOME, '.gemini', 'config', 'skills', SKILL_NAME));
  },

  antigravity() {
    head('Antigravity');
    copySkill(join(INSTALL_HOME, '.gemini', 'config', 'skills', SKILL_NAME));
  },

  cursor() {
    head('Cursor');
    const source = join(SKILL_SRC, 'SKILL.md');
    const dest = join(INSTALL_HOME, '.cursor', 'rules', `${SKILL_NAME}.mdc`);
    writeIfAbsent(dest, [
      '---',
      'description: Run WebMCP workflow JSON through workflow-dispatcher CLI',
      'alwaysApply: false',
      '---',
      '',
      `See source skill: ${source}`,
      '',
    ].join('\n'));
  },
};

function reminder() {
  log(`\n${'-'.repeat(64)}`);
  log(`Skill source: ${SKILL_SRC}`);
  log('Local CLI command:');
  log(`  node ${BIN_SRC} --help`);
  log('For a PATH command in this machine, run:');
  log('  npm run install:local');
  log(`${'-'.repeat(64)}`);
}

const arg = (process.argv[2] || '').toLowerCase();
if (arg === 'all' || arg === '') {
  if (arg === '') note('No target provided -> installing/printing for all supported runtimes.');
  for (const target of Object.values(TARGETS)) target();
} else if (TARGETS[arg]) {
  TARGETS[arg]();
} else {
  console.error(`Invalid target: "${arg}". Choose: ${Object.keys(TARGETS).join(', ')}, all`);
  process.exit(1);
}

reminder();

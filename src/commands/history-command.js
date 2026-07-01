const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../config-loader');
const { readEnv } = require('../env-loader');
const { resolveHistoryDir } = require('../run-history');
const { writeJson } = require('../output');

function readHistory(indexFile, limit) {
  if (!fs.existsSync(indexFile)) return [];
  const lines = fs.readFileSync(indexFile, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-limit).reverse().map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { parseError: true, line };
    }
  });
}

async function historyCommand(args, context) {
  const { options, stdout } = context;
  const env = readEnv();
  const config = loadConfig({ configPath: options.config, cwd: context.cwd, env });
  const historyRoot = resolveHistoryDir(options.historyDir || config.defaults.historyDir, config.configDir || context.cwd);
  const runs = readHistory(path.join(historyRoot, 'index.jsonl'), options.limit || 20);

  if (options.json) {
    writeJson(stdout, { ok: true, historyRoot, runs });
  } else if (runs.length === 0) {
    stdout.write(`No history found at ${historyRoot}\n`);
  } else {
    for (const run of runs) {
      stdout.write(`${run.runId}\t${run.status}\t${run.workflowId}\t${run.duration}ms\t${run.runDir}\n`);
    }
  }
  return 0;
}

module.exports = {
  historyCommand,
};

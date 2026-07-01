const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function resolveHistoryDir(historyDir, baseDir = process.cwd()) {
  return path.isAbsolute(historyDir) ? historyDir : path.resolve(baseDir, historyDir);
}

function createRunHistory(options) {
  const historyRoot = resolveHistoryDir(options.historyDir || '.workflow-runs', options.baseDir);
  const runDir = path.join(historyRoot, options.runId);
  ensureDir(runDir);
  return {
    historyRoot,
    runDir,
    eventsFile: path.join(runDir, 'events.jsonl'),
    summaryFile: path.join(runDir, 'summary.json'),
    workflowFile: path.join(runDir, 'workflow.normalized.json'),
    indexFile: path.join(historyRoot, 'index.jsonl'),
  };
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonLine(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

module.exports = {
  createRunHistory,
  writeJson,
  appendJsonLine,
  resolveHistoryDir,
};

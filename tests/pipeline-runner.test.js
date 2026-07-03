const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeStore() {
  const storeRoot = mkdtempSync(path.join(tmpdir(), 'webmcp-pipeline-store-'));
  writeJson(path.join(storeRoot, 'sites', 'demo', 'workflows', 'stage.json'), {
    id: 'demo-stage',
    name: 'Demo Stage',
    steps: [],
  });
  writeJson(path.join(storeRoot, 'sites', 'demo', 'workflows', 'stage.verify.json'), {
    signals: [
      { id: 'ok', type: 'jsonPath', from: 'FINAL_REPORT', path: '$.ok', exists: true },
    ],
  });
  return storeRoot;
}

function makeContext() {
  return {
    stdout: { write() {} },
    stderr: { write() {} },
  };
}

function loadPipelineRunnerWithMock(executeWorkflow) {
  const runnerPath = path.join(ROOT, 'src', 'pipeline', 'pipeline-runner.js');
  delete require.cache[require.resolve(runnerPath)];

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === '../executor' && parent?.filename === runnerPath) {
      return { executeWorkflow };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require(runnerPath);
  } finally {
    Module._load = originalLoad;
  }
}

test('gradeSummary fails closed for unknown signal types', () => {
  const { gradeSummary } = require('../src/grade/grade-summary');
  const result = gradeSummary({
    signals: [
      { id: 'typo', type: 'jsonPat', from: 'FINAL_REPORT', path: '$.ok', exists: true },
    ],
  }, { context: { outputs: { FINAL_REPORT: { ok: true } } } });

  assert.equal(result.verdict, 'red');
  assert.equal(result.signals[0].pass, false);
});

test('pipeline pauses outward-facing stages even when gate attempts to weaken policy', async () => {
  const calls = [];
  const { runPipeline } = loadPipelineRunnerWithMock(async () => {
    calls.push('execute');
    return {
      exitCode: 0,
      summary: { context: { outputs: { FINAL_REPORT: { ok: true } } } },
    };
  });
  const storeRoot = makeStore();
  const checkpointDir = path.join(storeRoot, '.checkpoints');
  const manifestPath = path.join(storeRoot, '_cross-site', 'pipelines', 'outward.pipeline.json');
  writeJson(manifestPath, {
    id: 'outward',
    settings: { checkpointDir },
    stages: [
      {
        id: 'publish',
        workflow: 'sites/demo/workflows/stage.json',
        risk: 'outward-facing',
        gate: 'none',
        idempotencyKey: 'publish-1',
      },
    ],
  });

  const result = await runPipeline({ manifestPath, context: makeContext() });

  assert.equal(result.status, 'awaiting-approval');
  assert.deepEqual(calls, []);
  assert.equal(existsSync(path.join(checkpointDir, 'pending', `${result.runId}@publish.json`)), true);
});

test('pipeline rejects outward-facing stages without idempotencyKey before execution', async () => {
  const calls = [];
  const { runPipeline } = loadPipelineRunnerWithMock(async () => {
    calls.push('execute');
    return {
      exitCode: 0,
      summary: { context: { outputs: { FINAL_REPORT: { ok: true } } } },
    };
  });
  const storeRoot = makeStore();
  const manifestPath = path.join(storeRoot, '_cross-site', 'pipelines', 'missing-key.pipeline.json');
  writeJson(manifestPath, {
    id: 'missing-key',
    stages: [
      {
        id: 'publish',
        workflow: 'sites/demo/workflows/stage.json',
        risk: 'outward-facing',
      },
    ],
  });

  const result = await runPipeline({ manifestPath, context: makeContext() });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /idempotencyKey/);
  assert.deepEqual(calls, []);
});

test('pipeline rejects destructive stages before execution', async () => {
  const calls = [];
  const { runPipeline } = loadPipelineRunnerWithMock(async () => {
    calls.push('execute');
    return {
      exitCode: 0,
      summary: { context: { outputs: { FINAL_REPORT: { ok: true } } } },
    };
  });
  const storeRoot = makeStore();
  const manifestPath = path.join(storeRoot, '_cross-site', 'pipelines', 'destructive.pipeline.json');
  writeJson(manifestPath, {
    id: 'destructive',
    stages: [
      {
        id: 'delete',
        workflow: 'sites/demo/workflows/stage.json',
        risk: 'destructive',
      },
    ],
  });

  const result = await runPipeline({ manifestPath, context: makeContext() });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /destructive/);
  assert.deepEqual(calls, []);
});

test('inline artifact verify resolves JSONPath against child FINAL_REPORT', async () => {
  const { runPipeline } = loadPipelineRunnerWithMock(async () => ({
    exitCode: 0,
    summary: { context: { outputs: { FINAL_REPORT: { filePath: '/tmp/video.mp4' } } } },
  }));
  const storeRoot = makeStore();
  const manifestPath = path.join(storeRoot, '_cross-site', 'pipelines', 'artifact.pipeline.json');
  writeJson(manifestPath, {
    id: 'artifact',
    stages: [
      {
        id: 'render',
        workflow: 'sites/demo/workflows/stage.json',
        verify: { type: 'artifact', path: '$.filePath', exists: true },
        captureAs: 'VIDEO',
        risk: 'generate',
      },
    ],
  });

  const result = await runPipeline({ manifestPath, context: makeContext() });

  assert.equal(result.status, 'done');
});

test('pipeline approve accepts a manifest to resolve custom checkpointDir', async () => {
  const { runPipeline } = loadPipelineRunnerWithMock(async () => {
    throw new Error('outward-facing gate should pause before execution');
  });
  const { pipelineCommand } = require('../src/commands/pipeline-command');
  const storeRoot = makeStore();
  const checkpointDir = path.join(storeRoot, '.custom-pipelines');
  const manifestPath = path.join(storeRoot, '_cross-site', 'pipelines', 'approval.pipeline.json');
  writeJson(manifestPath, {
    id: 'approval',
    settings: { checkpointDir },
    stages: [
      {
        id: 'publish',
        workflow: 'sites/demo/workflows/stage.json',
        risk: 'outward-facing',
        idempotencyKey: 'approval-1',
      },
    ],
  });
  const runResult = await runPipeline({ manifestPath, context: makeContext() });

  let output = '';
  const exitCode = await pipelineCommand(['approve', runResult.runId, manifestPath], {
    options: {},
    stdout: { write(chunk) { output += chunk; } },
    stderr: { write() {} },
  });

  assert.equal(exitCode, 0);
  assert.match(output, /approved/);
  const pending = JSON.parse(readFileSync(path.join(checkpointDir, 'pending', `${runResult.runId}@publish.json`), 'utf8'));
  assert.equal(pending.status, 'approved');
});


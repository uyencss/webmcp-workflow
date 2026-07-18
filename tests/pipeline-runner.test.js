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

test('pipeline routes each stage through its declared browser profile', async () => {
  const routedProfiles = [];
  const { runPipeline } = loadPipelineRunnerWithMock(async (resolved) => {
    routedProfiles.push(resolved.profile.profileId);
    return {
      exitCode: 0,
      summary: { context: { outputs: { FINAL_REPORT: { ok: true } } } },
    };
  });
  const storeRoot = makeStore();
  const manifestPath = path.join(storeRoot, '_cross-site', 'pipelines', 'profiles.pipeline.json');
  writeJson(manifestPath, {
    id: 'profiles',
    stages: [
      { id: 'chatgpt', workflow: 'sites/demo/workflows/stage.json', profile: 'chatgpt-profile' },
      { id: 'gemini', workflow: 'sites/demo/workflows/stage.json', profile: 'gemini-profile' },
    ],
  });

  const result = await runPipeline({
    manifestPath,
    cliOptions: { profile: 'fallback-profile' },
    context: makeContext(),
  });

  assert.equal(result.status, 'done');
  assert.deepEqual(routedProfiles, ['chatgpt-profile', 'gemini-profile']);
});

test('pipeline rejects an empty stage profile before executing', async () => {
  const calls = [];
  const { runPipeline } = loadPipelineRunnerWithMock(async () => {
    calls.push('execute');
    return { exitCode: 0, summary: { context: { outputs: { FINAL_REPORT: { ok: true } } } } };
  });
  const storeRoot = makeStore();
  const manifestPath = path.join(storeRoot, '_cross-site', 'pipelines', 'invalid-profile.pipeline.json');
  writeJson(manifestPath, {
    id: 'invalid-profile',
    stages: [{ id: 'chatgpt', workflow: 'sites/demo/workflows/stage.json', profile: '   ' }],
  });

  const result = await runPipeline({ manifestPath, context: makeContext() });

  assert.equal(result.status, 'failed');
  assert.match(result.reason, /profile/);
  assert.deepEqual(calls, []);
});

test('pipeline runtime variables override manifest defaults for every stage', async () => {
  const prompts = [];
  const { runPipeline } = loadPipelineRunnerWithMock(async (resolved) => {
    prompts.push(resolved.variables.PROMPT);
    return {
      exitCode: 0,
      summary: { context: { outputs: { FINAL_REPORT: { ok: true } } } },
    };
  });
  const storeRoot = makeStore();
  const manifestPath = path.join(storeRoot, '_cross-site', 'pipelines', 'runtime-vars.pipeline.json');
  writeJson(manifestPath, {
    id: 'runtime-vars',
    variables: { PROMPT: '' },
    stages: [{
      id: 'research',
      workflow: 'sites/demo/workflows/stage.json',
      with: { PROMPT: '{{PIPELINE.PROMPT}}' },
    }],
  });

  const result = await runPipeline({
    manifestPath,
    cliOptions: { variables: { PROMPT: 'Research this niche' } },
    context: makeContext(),
  });

  assert.equal(result.status, 'done');
  assert.deepEqual(prompts, ['Research this niche']);
});

test('pipeline run accepts a canonical run id and per-run internal roots', async () => {
  const resolvedOptions = [];
  const { runPipeline } = loadPipelineRunnerWithMock(async (resolved) => {
    resolvedOptions.push(resolved.historyDir);
    return {
      exitCode: 0,
      summary: { context: { outputs: { FINAL_REPORT: { ok: true } } } },
    };
  });
  const storeRoot = makeStore();
  const manifestPath = path.join(storeRoot, '_cross-site', 'pipelines', 'canonical.pipeline.json');
  const checkpointDir = path.join(storeRoot, 'run', '.internal', 'pipeline');
  const historyDir = path.join(storeRoot, 'run', '.internal', 'workflow');
  writeJson(manifestPath, {
    id: 'canonical',
    stages: [{ id: 'read', workflow: 'sites/demo/workflows/stage.json' }],
  });

  const result = await runPipeline({
    manifestPath,
    cliOptions: {
      runId: 'run_canonical',
      checkpointDir,
      historyDir,
    },
    context: makeContext(),
  });

  assert.equal(result.runId, 'run_canonical');
  assert.equal(existsSync(path.join(checkpointDir, 'run_canonical', 'pipeline-summary.json')), true);
  assert.deepEqual(resolvedOptions, [historyDir]);
});

test('pipeline with hydration resolves refs recursively inside arrays and objects', () => {
  const { hydrateWith } = require('../src/pipeline/pipeline-runner');
  const state = {
    PIPELINE: {
      ITEM: 'sách triết học',
      ITEM_CONFIG: { maxPages: 1, topN: 20 },
    },
  };

  assert.deepEqual(hydrateWith({
    KEYWORDS: ['{{PIPELINE.ITEM}}'],
    OPTIONS: {
      maxPages: '{{PIPELINE.ITEM_CONFIG.maxPages}}',
      label: 'query={{PIPELINE.ITEM}}',
    },
  }, state), {
    KEYWORDS: ['sách triết học'],
    OPTIONS: {
      maxPages: 1,
      label: 'query=sách triết học',
    },
  });
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

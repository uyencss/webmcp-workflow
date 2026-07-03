# Pipeline Orchestration Hardening Plan

> Date: 2026-07-03
> Scope: harden the first pipeline orchestration implementation after review.
> Status: planned before code changes.

## 1. Goal

The first pipeline layer proves the shape: compose existing workflows, hydrate
state between stages, checkpoint after every stage, verify outputs, pause before
human-gated outward actions, and resume approved runs.

This hardening pass turns that proof into a safer contract:

- The runner enforces risk policy, not just documentation.
- CLI commands can find runs that use non-default checkpoint directories.
- Verify gates fail closed when specs are invalid or typoed.
- Pipeline state/checkpoints are anchored to the store revision and child files.
- The package ships the docs and skills it references.
- Regression tests cover the orchestration behaviors that protect accounts,
  credits, and side effects.

## 2. User Journeys

As an automation author, I want a pipeline with a custom checkpoint directory to
be approvable and resumable, so that local/dev/test runs do not collide with
production state.

As an operator, I want outward-facing stages to pause even if a manifest author
forgets or weakens `gate`, so that the account never posts/sends/uploads without
human approval.

As an operator, I want destructive stages to be blocked by the runner, so that a
manifest cannot accidentally execute irreversible work.

As an automation author, I want verify specs to fail closed on unknown signal
types, so that a typo does not silently disable a gate.

As an operator, I want checkpoints to include store and child artifact anchors,
so that resume can warn when the manifest/store changed between attempts.

As a package user, I want the installed skill to link to documentation that is
actually included in the npm package.

## 3. Contract Changes

### 3.1 Risk policy is enforced

- `risk: "outward-facing"` is always treated as human-gated. `gate` may be
  omitted, but cannot weaken the gate.
- Outward-facing stages must declare a non-empty `idempotencyKey`.
- `risk: "destructive"` is blocked by the runner in this phase. Future support
  requires an explicit separate approval design.
- Unknown risk values fail validation before any child workflow executes.

### 3.2 Checkpoint lookup is explicit

- `pipeline run <manifest>` still uses `settings.checkpointDir`.
- `pipeline resume <runId> [manifest]` keeps the current optional manifest form.
- `pipeline approve|reject|status|scan` accept an optional manifest argument so
  they can resolve the same checkpoint directory as `run`.
- A later CLI flag such as `--checkpoint-dir` can be added if needed, but this
  pass keeps the command surface small.

### 3.3 Verify gates fail closed

- Unknown signal types produce a failed signal with `onFail: "red"`.
- Missing verify specs stay non-green.
- Inline artifact verify paths are resolved against the child workflow's
  `FINAL_REPORT`, so examples should use JSONPath-like values such as
  `$.filePath`, not pipeline-state paths such as `VIDEO.filePath`.

### 3.4 Checkpoints carry anchors

Checkpoint JSON should include:

- `manifestHash`
- `storeGitSha` when the manifest lives inside a git worktree
- per-stage anchors for workflow path/hash and verify path/hash when available

Resume should warn when `manifestHash` or `storeGitSha` changed. Per-stage hashes
are primarily diagnostic in this pass.

### 3.5 Release surface is complete

- `docs/20260703_pipeline_orchestration_layer.md` and this hardening plan are
  included in the npm package.
- The Cursor installer references `webmcp-pipeline-creator` alongside the two
  older skills.

## 4. Regression Tests

Add Node native tests for:

- `gradeSummary` fails unknown signal types.
- `runPipeline` pauses outward-facing stages even when `gate` attempts to weaken
  the policy.
- `runPipeline` rejects outward-facing stages without `idempotencyKey`.
- `runPipeline` rejects destructive stages before execution.
- `approve/status/scan` can target a manifest-specific checkpoint directory.
- Inline artifact verify passes with `$.filePath` against `FINAL_REPORT`.
- Installer local target copies all three skills; Cursor target exposes all
  three rule references.

## 5. Non-goals

- No Telegram/Zalo approval callback.
- No DAG/parallel execution.
- No migration of the full store doctor into workflow-cli.
- No browser-level end-to-end run against Gemini/Suno in unit tests.


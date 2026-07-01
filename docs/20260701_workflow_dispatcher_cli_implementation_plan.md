# Workflow Dispatcher CLI — Active Implementation Plan

> Status: Implemented  
> Updated: 2026-07-01  
> Notes: This file was moved from `task.md` into `docs/` after the CLI, runner relocation, multi-profile support, workflow smoke tests, and skill installer were implemented.

## Goal

Turn `workflow-dispatcher` into an installable local CLI command that executes WebMCP workflow JSON from the terminal.

The command should wrap the reorganized runner, keep workflow execution outside the browser extension, and send automation commands through the WebMCP HTTP gateway.

Primary command:

```bash
workflow-dispatcher run <workflow-id-or-path> [options]
```

## Current Runner Surface

The runner is already reorganized and should be consumed through the public barrel:

```js
const {
  WorkflowRunner,
  RunnerError,
  validateWorkflow,
  normalizeWorkflow,
} = require('./src/runner');
```

Current runner layout:

```text
workflow-dispatcher/
  src/
    runner/
      index.js
      run.js
      catalog/command-catalog.js
      core/runner-events.js
      core/transport.js
      core/workflow-runner.js
      pipeline/workflow-context.js
      pipeline/workflow-normalizer.js
      pipeline/workflow-validator.js
      shared/errors.js
      strategies/ai-vision.js
      strategies/aria-ref.js
```

`src/runner/run.js` stays as a backward-compatible legacy entrypoint while the primary CLI is `bin/workflow-dispatcher.js`.

## Non-Goals

- Do not reimplement the browser extension or `browser-auto-lib`.
- Do not introduce TypeScript/build tooling unless there is a clear project need.
- Do not require a database for v1; file-based JSONL history is enough.
- Do not put gateway routing fields like `profileId` inside workflow step `params`.

## Target CLI Shape

```bash
workflow-dispatcher --help
workflow-dispatcher run <workflow-id-or-path> [options]
workflow-dispatcher validate <workflow-id-or-path> [options]
workflow-dispatcher dry-run <workflow-id-or-path> [options]
workflow-dispatcher list [--json]
workflow-dispatcher profiles [--gateway <name-or-url>] [--json]
workflow-dispatcher doctor [--gateway <name-or-url>] [--profile <id-or-alias>] [--json]
workflow-dispatcher history [--limit 20] [--json]
workflow-dispatcher daemon [--config dispatcher.config.json]
```

Common options:

```bash
--config <path>              Config file path. Default: ./dispatcher.config.json
--gateway <name-or-url>      Gateway name from config or explicit /api URL
--profile <id-or-alias>      Chrome profile id or configured profile alias
--var KEY=VALUE              Runtime variable override. Repeatable
--vars-json <json>           Runtime variables as JSON object
--vars-file <path>           Runtime variables from JSON file
--timeout <ms>               Workflow command timeout override
--run-id <id>                Stable run id for correlation
--json                       Print machine-readable final result
--json-events                Stream machine-readable event envelopes
--strict                     Treat unknown template variables as validation errors
--allow-unknown-command      Allow passthrough WebMCP commands
```

Environment fallbacks:

```bash
WEBMCP_GATEWAY_URL=http://localhost:7865/api
WEBMCP_PROFILE_ID=<profile-id>
```

## Proposed File Layout

```text
workflow-dispatcher/
  package.json
  README.md
  config.example.json
  bin/
    workflow-dispatcher.js
  src/
    cli.js
    commands/
      run-command.js
      validate-command.js
      dry-run-command.js
      list-command.js
      profiles-command.js
      doctor-command.js
      history-command.js
      daemon-command.js
    config-loader.js
    workflow-registry.js
    profile-resolver.js
    gateway-health.js
    executor.js
    event-logger.js
    run-history.js
    queue.js
    dispatcher.js
    env-loader.js
    redaction.js
    runner/
      index.js
      run.js
      catalog/
      core/
      pipeline/
      shared/
      strategies/
  tests/
    fixtures/
```

## Config Model

Create `dispatcher.config.json`:

```json
{
  "defaultGateway": "local",
  "gateways": {
    "local": {
      "apiUrl": "http://localhost:7865/api",
      "healthUrl": "http://localhost:7865/health",
      "healthTimeoutMs": 3000,
      "defaultProfile": "personal",
      "profiles": {
        "personal": "b6a7b273-...",
        "work": "05475d86-..."
      }
    }
  },
  "defaults": {
    "timeoutMs": 30000,
    "strict": false,
    "allowUnknownCommand": false,
    "historyDir": ".workflow-runs",
    "redactKeys": ["token", "password", "cookie", "authorization", "apiKey"]
  },
  "workflows": {
    "gemini-generate-image": {
      "path": "workflows/gemini/generate_image.json",
      "gateway": "local",
      "profile": "personal",
      "description": "Generate an image in Gemini",
      "variables": {
        "PROMPT": "A minimal product photo"
      },
      "timeoutMs": 60000,
      "queue": {
        "lockKey": "gateway:local:profile:personal",
        "allowOverlap": false
      },
      "schedule": {
        "enabled": false,
        "intervalMs": 300000,
        "maxConsecutiveFailures": 5
      }
    }
  }
}
```

Validation requirements:

- `gateways` must be a non-empty object when workflows reference gateway names.
- `gateways.*.apiUrl` must point to the gateway `/api` endpoint.
- `gateways.*.healthUrl` should default to the matching `/health` endpoint when omitted.
- `gateways.*.profiles` maps human aliases to stable gateway profile ids.
- `workflows.*.path` must exist.
- `workflows.*.variables` must be an object.
- timeout and interval fields must be positive integers.
- workflow ids must be unique by object key.

Profile resolution precedence:

1. `--profile <id-or-alias>`
2. workflow config `profile`
3. gateway config `defaultProfile`
4. `WEBMCP_PROFILE_ID`
5. no profile, only valid when the gateway has exactly one connected profile

## Phase 1 — Package and CLI Entrypoint

- [x] Create `package.json`.
  - [x] Set `name` to `workflow-dispatcher`.
  - [x] Set `private: true` unless publishing is explicitly needed.
  - [x] Add `bin.workflow-dispatcher = "bin/workflow-dispatcher.js"`.
  - [x] Add scripts: `start`, `test`, and optionally `lint`.
- [x] Create `bin/workflow-dispatcher.js`.
  - [x] Keep shebang `#!/usr/bin/env node`.
  - [x] Import and execute `src/cli.js`.
  - [x] Catch fatal errors, print concise messages, and exit non-zero.
- [x] Create `src/cli.js`.
  - [x] Parse subcommands without adding dependencies.
  - [x] Add root and subcommand `--help`.
  - [x] Use stable exit codes:
    - [x] `0` completed / valid.
    - [x] `1` workflow failed.
    - [x] `2` usage/config/validation/profile selection error.
    - [x] `3` gateway unavailable or no extension/profile connected.
    - [x] `130` aborted by signal.
- [x] Keep `src/runner/run.js` backward compatible.

Acceptance:

- [x] `node bin/workflow-dispatcher.js --help` prints root usage.
- [x] `node bin/workflow-dispatcher.js run path/to/workflow.json --dry-run` works or points to `dry-run`.
- [x] Unknown command and unknown option return exit code `2`.

## Phase 2 — Config Loader, Registry, and Profile Resolver

- [x] Create `src/config-loader.js`.
  - [x] Load default `dispatcher.config.json`.
  - [x] Support `--config <path>`.
  - [x] Resolve workflow paths relative to the config file directory.
  - [x] Merge defaults with per-workflow settings.
  - [x] Validate config shape with actionable key paths.
- [x] Create `src/workflow-registry.js`.
  - [x] Resolve `<workflow-id-or-path>`.
  - [x] Load configured workflows by id.
  - [x] Treat non-id arguments as filesystem paths.
  - [x] Return workflow file path, workflow JSON, variables, timeout, gateway, profile, and metadata.
- [x] Create `src/profile-resolver.js`.
  - [x] Resolve profile alias to profile id.
  - [x] Support `--profile`, workflow `profile`, gateway `defaultProfile`, and `WEBMCP_PROFILE_ID`.
  - [x] Keep exact ids valid even when no alias exists.
  - [x] Do not require live `/health` for dry-run unless `--check-gateway` is added later.
- [x] Add `list` command.
  - [x] Print workflow id, description, path, gateway, profile, and schedule status.
  - [x] Support `--json`.
- [x] Add `config.example.json`.

Acceptance:

- [x] `workflow-dispatcher list --config config.example.json`.
- [x] `workflow-dispatcher validate <id> --config dispatcher.config.json`.
- [x] Invalid config reports exact key path and exits `2`.

## Phase 3 — Multi-Profile Runner Readiness

Track detailed implementation in `docs/20260701_runner_multi_profile_gateway_implementation_plan.md`.

- [x] Update `src/runner/core/transport.js`.
  - [x] Accept `options.profileId`.
  - [x] Include `profileId` as a top-level `/api` body field only when configured.
- [x] Update `src/runner/core/workflow-runner.js`.
  - [x] Accept `options.profileId`.
  - [x] Pass it to transport on every gateway command.
- [x] Update `src/runner/run.js`.
  - [x] Add `--profile-id`.
  - [x] Add `WEBMCP_PROFILE_ID` fallback.
- [x] Add fake-transport tests for profile propagation.

Acceptance:

- [x] Existing single-profile runs keep working without profile settings.
- [x] Multi-profile runs can target a selected profile.
- [x] `profileId` never appears inside workflow step `params`.

## Phase 4 — Executor and Workflow Commands

- [x] Create `src/executor.js`.
  - [x] Wrap `WorkflowRunner` from `src/runner/index.js`.
  - [x] Normalize and validate workflow before execution.
  - [x] Attach readable logger or JSON event logger.
  - [x] Pass resolved `gatewayUrl`, `profileId`, variables, timeout, run id, strict mode, and unknown-command mode.
  - [x] Return a stable summary object.
  - [x] Map runner status/errors to CLI exit codes.
- [x] Implement `run`.
  - [x] Support workflow id or path.
  - [x] Support `--var`, `--vars-json`, and `--vars-file`.
  - [x] Support `--gateway` and `--profile`.
  - [x] Support `--run-id`, `--json`, and `--json-events`.
  - [x] Handle `SIGINT` and `SIGTERM` cleanly.
- [x] Implement `validate`.
  - [x] Normalize and validate only.
  - [x] Support `--strict` and `--allow-unknown-command`.
- [x] Implement `dry-run`.
  - [x] Reuse the current dry-run report behavior from `src/runner/run.js`.
  - [x] Include commands, routes, template refs, step summary, gateway, and resolved profile.

Acceptance:

- [x] Valid workflow exits `0` in `validate`.
- [x] Invalid workflow exits `2` in `validate`.
- [x] Failed workflow exits `1` in `run`.
- [x] Gateway/profile unavailable exits `3`.
- [x] Ctrl+C exits `130` and emits an aborted summary when possible.

## Phase 5 — Gateway Doctor and Profiles Command

- [x] Create `src/gateway-health.js`.
  - [x] Query `GET /health`.
  - [x] Fall back to `ping` when needed.
  - [x] Return `profileCount`, `profiles`, `profileDetails`, and extension connection status.
  - [x] Apply health timeout.
- [x] Implement `profiles`.
  - [x] Print connected profile ids and friendly names/emails when available.
  - [x] Support `--json`.
- [x] Implement `doctor`.
  - [x] Resolve gateway from config or URL.
  - [x] Validate selected profile alias/id against `/health`.
  - [x] Report ambiguous profile selection when multiple profiles are connected and none is selected.
  - [x] Support `--json`.

Acceptance:

- [x] Healthy gateway exits `0`.
- [x] Unreachable gateway exits `3`.
- [x] Unknown profile exits `2`.
- [x] Multiple profiles with no selected profile produces actionable guidance.

## Phase 6 — Event Logger and Run History

- [x] Create `src/redaction.js`.
  - [x] Redact configured sensitive keys case-insensitively.
  - [x] Redact nested objects and arrays.
- [x] Create `src/event-logger.js`.
  - [x] Write JSONL events to `<historyDir>/<runId>/events.jsonl`.
  - [x] Write readable console output unless `--json-events`.
  - [x] Apply redaction before writing logs.
- [x] Create `src/run-history.js`.
  - [x] Create run directory.
  - [x] Write `summary.json`.
  - [x] Write `workflow.normalized.json`.
  - [x] Maintain lightweight `index.jsonl`.
- [x] Implement `history`.
  - [x] List latest runs.
  - [x] Support `--limit` and `--json`.

Acceptance:

- [x] Every `run` creates a history entry unless disabled.
- [x] Failed runs still write `summary.json`.
- [x] Secrets from variables do not appear in history files.

## Phase 7 — Queue, Locks, and Daemon

- [x] Create `src/queue.js`.
  - [x] In-memory queue for daemon mode.
  - [x] Per lock key concurrency of `1` by default.
  - [x] `allowOverlap: true` bypasses lock.
  - [x] Support item states: `pending`, `running`, `completed`, `failed`, `aborted`.
- [x] Add run-level lock in CLI run mode.
  - [x] Use lock files under history dir for separate processes.
  - [x] Default lock key to `gateway:<gateway>:profile:<profile>`.
  - [x] Refuse overlapping run unless `allowOverlap` or `--force`.
- [x] Create `src/dispatcher.js`.
  - [x] Load scheduled workflows from config.
  - [x] Start interval-based loops.
  - [x] Use queue to prevent overlap.
  - [x] Track consecutive failures and graceful shutdown.
- [x] Implement `daemon`.

Acceptance:

- [x] Two workflows targeting the same gateway/profile lock do not overlap by default.
- [x] Stale lock detection reports owner/run id and age.
- [x] `workflow-dispatcher daemon --config dispatcher.config.json` starts enabled schedules.

## Phase 8 — Documentation

- [x] Create `README.md`.
  - [x] Explain what the dispatcher is and is not.
  - [x] Installation and local usage.
  - [x] Config reference.
  - [x] Command reference.
  - [x] Profile selection and multi-profile gateway behavior.
  - [x] Example workflows by path and by id.
  - [x] Exit codes and troubleshooting.
- [x] Document supported workflow JSON fields.
  - [x] `command`, `params`, `strategy`, `guard`, `retryPolicy`, `onSuccess`, `onFailure`, `captureAs`, `wait`.
- [x] Document security notes.
  - [x] Secrets via env or vars file.
  - [x] Redaction behavior.
  - [x] Avoid logging cookies/tokens/profile emails unless explicitly needed.

Acceptance:

- [x] A new user can run `doctor`, `profiles`, `list`, `validate`, `dry-run`, and `run` from README alone.

## Phase 9 — Tests

- [x] Add Node test suite using built-in `node:test`.
- [x] Unit tests:
  - [x] CLI arg parsing.
  - [x] Config validation.
  - [x] Workflow id/path resolution.
  - [x] Profile alias/id resolution.
  - [x] Variable merging precedence.
  - [x] Redaction.
  - [x] Exit code mapping.
  - [x] Lock key behavior.
- [x] Integration-style tests with fake transport:
  - [x] Successful run.
  - [x] Validation failure.
  - [x] Gateway unavailable.
  - [x] Profile required / profile not found.
  - [x] Step retry.
  - [x] Abort signal.
  - [x] JSON events output.
- [x] Fixture workflows:
  - [x] Minimal successful workflow.
  - [x] Invalid workflow.
  - [x] Workflow with route.
  - [x] Workflow with capture/template.

Acceptance:

- [x] `npm test` passes without a real WebMCP gateway.
- [x] Tests do not write outside temp directories.

## Phase 10 — Provider Skill Installer

- [x] Move the source skill out of provider-specific folders and into `skills/workflow-dispatcher-cli/`.
- [x] Add `scripts/install-agent.mjs` based on the `mcp-web-extension` provider-install pattern.
- [x] Add provider-specific install scripts:
  - [x] `install:local`
  - [x] `install:codex`
  - [x] `install:claude`
  - [x] `install:gemini`
  - [x] `install:antigravity`
  - [x] `install:cursor`
  - [x] `install:copilot`
- [x] Add a local install test using `WORKFLOW_DISPATCHER_INSTALL_HOME` so verification does not write to the real home directory.

Acceptance:

- [x] `npm run install:local` can copy the skill and create a local CLI symlink.
- [x] Provider install commands copy or print safe provider-specific instructions.
- [x] `npm test` verifies local skill install behavior.

## Implementation Order

1. Package + CLI entrypoint.
2. Config loader + registry + profile resolver.
3. Runner profile propagation.
4. Executor + `run` / `validate` / `dry-run`.
5. `doctor` + `profiles`.
6. History + redacted event logging.
7. Queue + locks + daemon scheduler.
8. README and examples.
9. Test coverage hardening.
10. Provider skill installer.

## Definition of Done

- [x] `workflow-dispatcher run <workflow-id>` works from config.
- [x] `workflow-dispatcher run <workflow.json>` works by path.
- [x] `workflow-dispatcher validate`, `dry-run`, `list`, `profiles`, `doctor`, and `history` work.
- [x] CLI can target a multi-profile gateway via `--profile` or config profile alias.
- [x] `workflow-dispatcher daemon` can run scheduled workflows without overlap.
- [x] Runs produce redacted history and summaries.
- [x] Gateway failures, profile selection failures, validation failures, workflow failures, and aborts have distinct exit codes.
- [x] README documents setup and common usage.
- [x] Test suite covers CLI behavior without requiring a live browser.
- [x] Companion skill can be installed into provider-specific global skill locations.

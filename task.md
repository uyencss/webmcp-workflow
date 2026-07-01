# Workflow Dispatcher CLI — Active Implementation Plan

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
} = require('./runner');
```

Current runner layout:

```text
workflow-dispatcher/
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

`runner/run.js` stays as a backward-compatible legacy entrypoint while the new CLI is built around `bin/workflow-dispatcher.js` and `src/`.

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

- [ ] Create `package.json`.
  - [ ] Set `name` to `workflow-dispatcher`.
  - [ ] Set `private: true` unless publishing is explicitly needed.
  - [ ] Add `bin.workflow-dispatcher = "bin/workflow-dispatcher.js"`.
  - [ ] Add scripts: `start`, `test`, and optionally `lint`.
- [ ] Create `bin/workflow-dispatcher.js`.
  - [ ] Keep shebang `#!/usr/bin/env node`.
  - [ ] Import and execute `src/cli.js`.
  - [ ] Catch fatal errors, print concise messages, and exit non-zero.
- [ ] Create `src/cli.js`.
  - [ ] Parse subcommands without adding dependencies.
  - [ ] Add root and subcommand `--help`.
  - [ ] Use stable exit codes:
    - [ ] `0` completed / valid.
    - [ ] `1` workflow failed.
    - [ ] `2` usage/config/validation/profile selection error.
    - [ ] `3` gateway unavailable or no extension/profile connected.
    - [ ] `130` aborted by signal.
- [ ] Keep `runner/run.js` backward compatible.

Acceptance:

- [ ] `node bin/workflow-dispatcher.js --help` prints root usage.
- [ ] `node bin/workflow-dispatcher.js run path/to/workflow.json --dry-run` works or points to `dry-run`.
- [ ] Unknown command and unknown option return exit code `2`.

## Phase 2 — Config Loader, Registry, and Profile Resolver

- [ ] Create `src/config-loader.js`.
  - [ ] Load default `dispatcher.config.json`.
  - [ ] Support `--config <path>`.
  - [ ] Resolve workflow paths relative to the config file directory.
  - [ ] Merge defaults with per-workflow settings.
  - [ ] Validate config shape with actionable key paths.
- [ ] Create `src/workflow-registry.js`.
  - [ ] Resolve `<workflow-id-or-path>`.
  - [ ] Load configured workflows by id.
  - [ ] Treat non-id arguments as filesystem paths.
  - [ ] Return workflow file path, workflow JSON, variables, timeout, gateway, profile, and metadata.
- [ ] Create `src/profile-resolver.js`.
  - [ ] Resolve profile alias to profile id.
  - [ ] Support `--profile`, workflow `profile`, gateway `defaultProfile`, and `WEBMCP_PROFILE_ID`.
  - [ ] Keep exact ids valid even when no alias exists.
  - [ ] Do not require live `/health` for dry-run unless `--check-gateway` is added later.
- [ ] Add `list` command.
  - [ ] Print workflow id, description, path, gateway, profile, and schedule status.
  - [ ] Support `--json`.
- [ ] Add `config.example.json`.

Acceptance:

- [ ] `workflow-dispatcher list --config config.example.json`.
- [ ] `workflow-dispatcher validate <id> --config dispatcher.config.json`.
- [ ] Invalid config reports exact key path and exits `2`.

## Phase 3 — Multi-Profile Runner Readiness

Track detailed implementation in `docs/20260701_runner_multi_profile_gateway_implementation_plan.md`.

- [ ] Update `runner/core/transport.js`.
  - [ ] Accept `options.profileId`.
  - [ ] Include `profileId` as a top-level `/api` body field only when configured.
- [ ] Update `runner/core/workflow-runner.js`.
  - [ ] Accept `options.profileId`.
  - [ ] Pass it to transport on every gateway command.
- [ ] Update `runner/run.js`.
  - [ ] Add `--profile-id`.
  - [ ] Add `WEBMCP_PROFILE_ID` fallback.
- [ ] Add fake-transport tests for profile propagation.

Acceptance:

- [ ] Existing single-profile runs keep working without profile settings.
- [ ] Multi-profile runs can target a selected profile.
- [ ] `profileId` never appears inside workflow step `params`.

## Phase 4 — Executor and Workflow Commands

- [ ] Create `src/executor.js`.
  - [ ] Wrap `WorkflowRunner` from `runner/index.js`.
  - [ ] Normalize and validate workflow before execution.
  - [ ] Attach readable logger or JSON event logger.
  - [ ] Pass resolved `gatewayUrl`, `profileId`, variables, timeout, run id, strict mode, and unknown-command mode.
  - [ ] Return a stable summary object.
  - [ ] Map runner status/errors to CLI exit codes.
- [ ] Implement `run`.
  - [ ] Support workflow id or path.
  - [ ] Support `--var`, `--vars-json`, and `--vars-file`.
  - [ ] Support `--gateway` and `--profile`.
  - [ ] Support `--run-id`, `--json`, and `--json-events`.
  - [ ] Handle `SIGINT` and `SIGTERM` cleanly.
- [ ] Implement `validate`.
  - [ ] Normalize and validate only.
  - [ ] Support `--strict` and `--allow-unknown-command`.
- [ ] Implement `dry-run`.
  - [ ] Reuse the current dry-run report behavior from `runner/run.js`.
  - [ ] Include commands, routes, template refs, step summary, gateway, and resolved profile.

Acceptance:

- [ ] Valid workflow exits `0` in `validate`.
- [ ] Invalid workflow exits `2` in `validate`.
- [ ] Failed workflow exits `1` in `run`.
- [ ] Gateway/profile unavailable exits `3`.
- [ ] Ctrl+C exits `130` and emits an aborted summary when possible.

## Phase 5 — Gateway Doctor and Profiles Command

- [ ] Create `src/gateway-health.js`.
  - [ ] Query `GET /health`.
  - [ ] Fall back to `ping` when needed.
  - [ ] Return `profileCount`, `profiles`, `profileDetails`, and extension connection status.
  - [ ] Apply health timeout.
- [ ] Implement `profiles`.
  - [ ] Print connected profile ids and friendly names/emails when available.
  - [ ] Support `--json`.
- [ ] Implement `doctor`.
  - [ ] Resolve gateway from config or URL.
  - [ ] Validate selected profile alias/id against `/health`.
  - [ ] Report ambiguous profile selection when multiple profiles are connected and none is selected.
  - [ ] Support `--json`.

Acceptance:

- [ ] Healthy gateway exits `0`.
- [ ] Unreachable gateway exits `3`.
- [ ] Unknown profile exits `2`.
- [ ] Multiple profiles with no selected profile produces actionable guidance.

## Phase 6 — Event Logger and Run History

- [ ] Create `src/redaction.js`.
  - [ ] Redact configured sensitive keys case-insensitively.
  - [ ] Redact nested objects and arrays.
- [ ] Create `src/event-logger.js`.
  - [ ] Write JSONL events to `<historyDir>/<runId>/events.jsonl`.
  - [ ] Write readable console output unless `--json-events`.
  - [ ] Apply redaction before writing logs.
- [ ] Create `src/run-history.js`.
  - [ ] Create run directory.
  - [ ] Write `summary.json`.
  - [ ] Write `workflow.normalized.json`.
  - [ ] Maintain lightweight `index.jsonl`.
- [ ] Implement `history`.
  - [ ] List latest runs.
  - [ ] Support `--limit` and `--json`.

Acceptance:

- [ ] Every `run` creates a history entry unless disabled.
- [ ] Failed runs still write `summary.json`.
- [ ] Secrets from variables do not appear in history files.

## Phase 7 — Queue, Locks, and Daemon

- [ ] Create `src/queue.js`.
  - [ ] In-memory queue for daemon mode.
  - [ ] Per lock key concurrency of `1` by default.
  - [ ] `allowOverlap: true` bypasses lock.
  - [ ] Support item states: `pending`, `running`, `completed`, `failed`, `aborted`.
- [ ] Add run-level lock in CLI run mode.
  - [ ] Use lock files under history dir for separate processes.
  - [ ] Default lock key to `gateway:<gateway>:profile:<profile>`.
  - [ ] Refuse overlapping run unless `allowOverlap` or `--force`.
- [ ] Create `src/dispatcher.js`.
  - [ ] Load scheduled workflows from config.
  - [ ] Start interval-based loops.
  - [ ] Use queue to prevent overlap.
  - [ ] Track consecutive failures and graceful shutdown.
- [ ] Implement `daemon`.

Acceptance:

- [ ] Two workflows targeting the same gateway/profile lock do not overlap by default.
- [ ] Stale lock detection reports owner/run id and age.
- [ ] `workflow-dispatcher daemon --config dispatcher.config.json` starts enabled schedules.

## Phase 8 — Documentation

- [ ] Create `README.md`.
  - [ ] Explain what the dispatcher is and is not.
  - [ ] Installation and local usage.
  - [ ] Config reference.
  - [ ] Command reference.
  - [ ] Profile selection and multi-profile gateway behavior.
  - [ ] Example workflows by path and by id.
  - [ ] Exit codes and troubleshooting.
- [ ] Document supported workflow JSON fields.
  - [ ] `command`, `params`, `strategy`, `guard`, `retryPolicy`, `onSuccess`, `onFailure`, `captureAs`, `wait`.
- [ ] Document security notes.
  - [ ] Secrets via env or vars file.
  - [ ] Redaction behavior.
  - [ ] Avoid logging cookies/tokens/profile emails unless explicitly needed.

Acceptance:

- [ ] A new user can run `doctor`, `profiles`, `list`, `validate`, `dry-run`, and `run` from README alone.

## Phase 9 — Tests

- [ ] Add Node test suite using built-in `node:test`.
- [ ] Unit tests:
  - [ ] CLI arg parsing.
  - [ ] Config validation.
  - [ ] Workflow id/path resolution.
  - [ ] Profile alias/id resolution.
  - [ ] Variable merging precedence.
  - [ ] Redaction.
  - [ ] Exit code mapping.
  - [ ] Lock key behavior.
- [ ] Integration-style tests with fake transport:
  - [ ] Successful run.
  - [ ] Validation failure.
  - [ ] Gateway unavailable.
  - [ ] Profile required / profile not found.
  - [ ] Step retry.
  - [ ] Abort signal.
  - [ ] JSON events output.
- [ ] Fixture workflows:
  - [ ] Minimal successful workflow.
  - [ ] Invalid workflow.
  - [ ] Workflow with route.
  - [ ] Workflow with capture/template.

Acceptance:

- [ ] `npm test` passes without a real WebMCP gateway.
- [ ] Tests do not write outside temp directories.

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

## Definition of Done

- [ ] `workflow-dispatcher run <workflow-id>` works from config.
- [ ] `workflow-dispatcher run <workflow.json>` works by path.
- [ ] `workflow-dispatcher validate`, `dry-run`, `list`, `profiles`, `doctor`, and `history` work.
- [ ] CLI can target a multi-profile gateway via `--profile` or config profile alias.
- [ ] `workflow-dispatcher daemon` can run scheduled workflows without overlap.
- [ ] Runs produce redacted history and summaries.
- [ ] Gateway failures, profile selection failures, validation failures, workflow failures, and aborts have distinct exit codes.
- [ ] README documents setup and common usage.
- [ ] Test suite covers CLI behavior without requiring a live browser.

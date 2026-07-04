# Changelog

All notable changes to `@gyga-browser/webmcp-workflow` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 0.5.0 - 2026-07-04

### Added

- **`batch` command** — run several gateway commands in a single round-trip,
  executed inside the extension. Collapses a tightly-coupled micro-sequence
  (`type → click → settle → read`) into one call, cutting round-trips, latency,
  and run-log noise.
  - New `orchestration` command group. `batch` takes
    `actions: [{ method, params }]` plus `onError` (`"continue"` default /
    `"stop-on-error"`), `screenshotAfter`, `tabId`, and `actionTimeoutMs`. The
    `delay`/`wait` pseudo-actions are valid inside `actions`.
  - The runner threads the active tab across a batch — it adopts the last
    sub-action `tabId` so later steps target the right tab.
  - Batch step timeout auto-scales by action count (capped at 5 minutes) when
    `timeoutMs` is not set explicitly, mirroring the gateway's proportional
    batch timeout.
  - `validate` deep-checks batch actions: unknown inner `method`, missing inner
    required params, an empty `actions` array, and nested batch are all rejected
    before a run.
  - `captureAs` on a batch stores the whole envelope; read a specific action via
    `{{VAR.results.<i>.result}}`. Sub-action results are not auto-unwrapped.
  - Skill `webmcp-workflow-creator` documents batch vs. real steps (§5A);
    runnable example `.examples/workflows/gemini/chat_batch.json`.
  - Requires the extension/gateway `batch` handler (from
    `@gyga-browser/webmcp-browser-automation-kit`) to execute a run.

### Note

- This release also ships the pipeline orchestration layer and the doctor
  Chrome Web Store link that landed on `main` after 0.4.0.

## 0.4.0 - 2026-07-02

### Added

- **Playbooks & agentic recovery.** A workflow can now ship a paired
  `<name>.playbook.md` describing the task's goal, hard identifiers, verification
  criteria, and prohibitions — the "why" and guardrails the JSON cannot express.
  Playbooks are fully opt-in; workflows without one run unchanged.
  - New optional top-level `playbook` field on workflow JSON (resolved relative
    to the workflow file), with a convention fallback to the sibling
    `<basename>.playbook.md`.
  - New `webmcp-workflow handoff <runId|latest>` command that assembles a single
    AI-readable recovery package: the failure, progress so far, the remaining
    steps, and the full playbook — all redacted. Supports `--json`.
  - A failed `run --json` now includes a `handoff` block (`hint`, `runId`,
    `playbookFound`) pointing at the next move.
  - `dry-run` reports the resolved playbook; `validate`/`dry-run` warn (never
    error) when an explicit `playbook` field points at a missing file.
  - Run `summary.json` records `playbook` metadata; `history` index tracks a
    `playbook` flag per run.
  - `docs/playbook-format.md` spec and
    `skills/webmcp-workflow-creator/playbook-template.md` template; the creator
    skill now authors JSON + playbook together, and the CLI skill documents the
    recovery loop.
  - Reserved `defaults.agentFallback` config block (shape-validated, not yet
    executed) for a future headless-agent fallback mode.

## 0.3.1 - 2026-07-02

### Fixed

- Fallback run-history location to correctly use the shared default history directory when `options.historyDir` is not specified.
- Documentation command examples in `SKILL.md` to omit custom `--history-dir` flags when not required.

## 0.3.0 - 2026-07-02

### Changed

- **Default run-history location moved to the shared WebMCP kit home.** Runs now
  write artifacts to `~/.webmcp/workflow-runs/<runId>/` by default instead of
  `./.workflow-runs/<runId>/` in the current working directory. The home root is
  resolved as `WEBMCP_HOME` > `WEBMCP_DATA_DIR` (back-compat alias) > `~/.webmcp`,
  keeping it consistent with the `@gyga-browser/webmcp-browser-automation-kit`
  Chrome launcher. Cross-platform via `os.homedir()` (macOS, Linux, Windows).

  To keep the previous behavior of writing inside the project, set
  `"historyDir": ".workflow-runs"` in `dispatcher.config.json`, pass
  `--history-dir .workflow-runs`, or point `WEBMCP_HOME` at the project. Explicit
  `--history-dir` and `defaults.historyDir` overrides are unaffected.

### Added

- `src/home.js` exposing `getWebmcpHome()` and `getDefaultHistoryDir()` for shared
  home resolution, with `tests/home.test.js` covering the env priority order.

## 0.1.0 - 2026-07-01

### Added

- Initial standalone release of the WebMCP workflow runner CLI, published
  independently of `@gyga-browser/webmcp-browser-automation-kit`.
- Commands: `run`, `validate`, `dry-run`, `list`, `profiles`, `doctor`,
  `history`, and `daemon`.
- Multi-profile gateway routing: `profileId` is sent as a top-level `/api`
  field and never injected into workflow step `params`. Profile selection
  resolves from `--profile`, workflow config, gateway `defaultProfile`,
  `WEBMCP_PROFILE_ID`, then a single connected profile.
- Runner engine with retries + exponential backoff, guards
  (`element-exists`/`element-absent`/`url-matches`/`expression`),
  `onSuccess`/`onFailure` routing with loop protection, `ai-vision` and
  `aria-ref` targeting strategies, and abort/timeout handling.
- Redacted run history artifacts (`events.jsonl`, `summary.json`,
  `workflow.normalized.json`) under `.workflow-runs/<runId>/`.
- `--version` flag and machine-readable `--json` output on reporting commands.
- Companion `webmcp-workflow-cli` skill plus provider installers
  (`install:claude`, `install:codex`, `install:gemini`, `install:antigravity`,
  `install:cursor`, `install:copilot`, `install:local`).
- Dual bin names: `webmcp-workflow` (canonical) and `webmcp-workflow-cli`
  (compatibility alias). Also invokable via the optional `webmcp workflow`
  bridge from `@gyga-browser/webmcp-browser-automation-kit`.

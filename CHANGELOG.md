# Changelog

All notable changes to `@gyga-browser/webmcp-workflow` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Companion `workflow-dispatcher-cli` skill plus provider installers
  (`install:claude`, `install:codex`, `install:gemini`, `install:antigravity`,
  `install:cursor`, `install:copilot`, `install:local`).
- Dual bin names: `webmcp-workflow` (canonical) and `workflow-dispatcher`
  (compatibility alias). Also invokable via the optional `webmcp workflow`
  bridge from `@gyga-browser/webmcp-browser-automation-kit`.

---
name: workflow-dispatcher-cli
description: Run, validate, debug, and smoke-test WebMCP workflow JSON through `webmcp-workflow` or the optional `webmcp workflow` bridge. Use when Codex needs to execute workflow commands, run browser workflows via the WebMCP gateway, choose a multi-profile `profileId`, inspect run history, or verify workflow JSON from `workflow-dispatcher/`.
---

# Workflow Dispatcher CLI

Use this skill to run WebMCP workflow JSON from a terminal. Prefer the standalone
command when the package is installed (globally, via `npx`, or `npm link`):

```bash
webmcp-workflow --help
webmcp-workflow --version
```

When `@gyga-browser/webmcp-browser-automation-kit` is also installed, the same
runner is reachable through the optional branded bridge:

```bash
webmcp workflow --help
```

Inside a local checkout of the `webmcp-automation-kit` monorepo, run the bin
directly (paths are relative to the repo root):

```bash
node workflow-dispatcher/bin/workflow-dispatcher.js --help
```

## Skill Installation

The source skill lives in `skills/workflow-dispatcher-cli/`. Do not edit provider
install copies directly. Install or refresh provider copies with:

```bash
npm run install:local      # Codex test install + ~/.local/bin/workflow-dispatcher fallback
npm run install:codex
npm run install:claude
npm run install:gemini
npm run install:antigravity
npm run install:cursor
npm run install:copilot
```

For safe tests, set `WORKFLOW_DISPATCHER_INSTALL_HOME` to a temp directory before
running installer commands.

## Core Workflow

1. Validate the workflow before live execution:

   ```bash
   webmcp-workflow validate tests/fixtures/minimal-workflow.json
   webmcp-workflow dry-run tests/fixtures/example-title-workflow.json --json
   webmcp-workflow dry-run example-title --config dispatcher.config.json --json
   ```

2. Start or verify the WebMCP gateway (from `@gyga-browser/webmcp-browser-automation-kit`):

   ```bash
   webmcp gateway start
   # or, from a monorepo checkout: npm run gateway --prefix mcp-web-extension
   ```

3. In another terminal, list connected browser profiles:

   ```bash
   webmcp-workflow profiles
   ```

4. If more than one profile is connected, pass `--profile <profileId-or-alias>` on every live run:

   ```bash
   webmcp-workflow run tests/fixtures/example-title-workflow.json \
     --profile <profileId> \
     --json
   ```

5. Inspect run artifacts when needed:

   ```bash
   webmcp-workflow history
   ```

## Run History Location

By default, run artifacts are written to the shared WebMCP kit home:
`~/.webmcp/workflow-runs/<runId>/` (the same `~/.webmcp` used by the Chrome
launcher). Resolution order for the home root is `WEBMCP_HOME` >
`WEBMCP_DATA_DIR` (back-compat alias) > `~/.webmcp`.

Only override the history location when the user explicitly asks for it: use
`--history-dir <path>` per run or `defaults.historyDir` in `dispatcher.config.json`
per project (a relative value resolves against the config/cwd). For example,
`--history-dir .workflow-runs-real` is an explicit in-repo smoke-test override;
omit the flag to write to the default `~/.webmcp/workflow-runs`.

## Multi-Profile Rules

The gateway accepts `profileId` as a top-level `/api` field:

```json
{ "method": "ping", "params": {}, "profileId": "profile-id" }
```

Do not put `profileId` inside workflow step `params`. The CLI resolves profile selection from:

1. `--profile`
2. workflow config `profile`
3. gateway config `defaultProfile`
4. `WEBMCP_PROFILE_ID`
5. no profile only when exactly one browser profile is connected

Use `doctor` to catch ambiguity before running:

```bash
webmcp-workflow doctor --profile <profileId> --json
```

## Useful Checks

Run the unit suite:

```bash
npm test
```

Run the fake multi-profile workflow smoke test:

```bash
npm run test:workflow
```

Run a real browser workflow when the gateway and extension are connected:

```bash
webmcp-workflow run tests/fixtures/example-title-workflow.json \
  --profile <profileId> \
  --json
```

Expected successful real-browser result:

- `status`: `completed`
- `stepsCompleted`: `2`
- captured `PAGE_TITLE`: `Example Domain`

## Troubleshooting

- Gateway unreachable: start `npm run gateway` in `mcp-web-extension/`.
- `PROFILE_REQUIRED`: run `profiles`, choose one connected id, and pass `--profile`.
- `PROFILE_NOT_FOUND`: refresh `profiles`; the chosen Chrome profile disconnected or the id is stale.
- Extension disconnected: reload the unpacked Chrome extension from `mcp-web-extension/webmcp-extension/dist`.
- Workflow fails validation: run `dry-run --json` and inspect `validation.errors`.

Keep `.workflow-runs*` and `.examples/` ignored; do not commit generated run artifacts or local example assets. The default history location (`~/.webmcp/workflow-runs`) lives outside the repo, so it needs no gitignore entry — only in-repo overrides via `--history-dir` do.

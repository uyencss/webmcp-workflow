---
name: workflow-dispatcher-cli
description: Run, validate, debug, and smoke-test WebMCP workflow JSON through the local workflow-dispatcher terminal CLI. Use when Codex needs to execute `workflow-dispatcher` commands, run browser workflows via the WebMCP gateway, choose a multi-profile `profileId`, inspect run history, or verify workflow JSON from `workflow-dispatcher/`.
---

# Workflow Dispatcher CLI

Use this skill when operating the `workflow-dispatcher` project from a terminal. The CLI lives in the repo root and wraps `runner/`:

```bash
cd /Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/workflow-dispatcher
node bin/workflow-dispatcher.js --help
```

Prefer `node bin/workflow-dispatcher.js ...` unless the package has been linked with `npm link`.

## Core Workflow

1. Validate the workflow before live execution:

   ```bash
   node bin/workflow-dispatcher.js validate tests/fixtures/minimal-workflow.json
   node bin/workflow-dispatcher.js dry-run tests/fixtures/example-title-workflow.json --json
   node bin/workflow-dispatcher.js dry-run example-title --config config.example.json --json
   ```

2. Start or verify the WebMCP gateway from the sibling project:

   ```bash
   cd /Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/mcp-web-extension
   npm run gateway
   ```

3. In another terminal, list connected browser profiles:

   ```bash
   cd /Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/workflow-dispatcher
   node bin/workflow-dispatcher.js profiles
   ```

4. If more than one profile is connected, pass `--profile <profileId-or-alias>` on every live run:

   ```bash
   node bin/workflow-dispatcher.js run tests/fixtures/example-title-workflow.json \
     --profile <profileId> \
     --json \
     --history-dir .workflow-runs-real
   ```

5. Inspect run artifacts when needed:

   ```bash
   node bin/workflow-dispatcher.js history --history-dir .workflow-runs-real
   ```

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
node bin/workflow-dispatcher.js doctor --profile <profileId> --json
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
node bin/workflow-dispatcher.js run tests/fixtures/example-title-workflow.json \
  --profile <profileId> \
  --json \
  --history-dir .workflow-runs-real
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

Keep `.workflow-runs*` and `.examples/` ignored; do not commit generated run artifacts or local example assets.

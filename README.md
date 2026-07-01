# Workflow Dispatcher

`workflow-dispatcher` is a local Node.js CLI for validating and running WebMCP workflow JSON through the WebMCP HTTP gateway.

It wraps the existing `src/runner/` engine and supports the gateway's multi-profile request shape:

```json
{ "method": "getActiveTab", "params": {}, "profileId": "profile-id" }
```

`profileId` is sent as a top-level `/api` body field. It is never injected into workflow step `params`.

## Install

From this directory:

```bash
npm install
node bin/workflow-dispatcher.js --help
```

For local development without installing onto PATH:

```bash
node bin/workflow-dispatcher.js --help
```

To install the companion skill and a local `workflow-dispatcher` command for
Codex testing:

```bash
npm run install:local
workflow-dispatcher --help
```

Provider-specific skill installs:

```bash
npm run install:codex
npm run install:claude
npm run install:gemini
npm run install:antigravity
npm run install:cursor
npm run install:copilot
```

The source skill lives in `skills/workflow-dispatcher-cli/`. The installer
copies it into each provider's global skill/rules directory, following the same
pattern as `mcp-web-extension/scripts/install-agent.mjs`.

## Gateway

Start the WebMCP gateway and connect the Chrome extension first. By default the CLI uses:

```bash
WEBMCP_GATEWAY_URL=http://localhost:7865/api
```

For a multi-profile gateway, discover connected profiles:

```bash
workflow-dispatcher profiles
workflow-dispatcher doctor --profile <profile-id-or-alias>
```

When more than one Chrome profile is connected, pass `--profile` or configure a default profile alias.

## Config

Copy `config.example.json` to `dispatcher.config.json` and adjust workflow paths/profile aliases.

```json
{
  "defaultGateway": "local",
  "gateways": {
    "local": {
      "apiUrl": "http://localhost:7865/api",
      "healthUrl": "http://localhost:7865/health",
      "profiles": {
        "personal": "b6a7b273-..."
      }
    }
  },
  "workflows": {
    "example-title": {
      "path": "tests/fixtures/example-title-workflow.json",
      "gateway": "local",
      "profile": "personal"
    }
  }
}
```

Profile resolution precedence:

1. `--profile <id-or-alias>`
2. workflow config `profile`
3. gateway config `defaultProfile`
4. `WEBMCP_PROFILE_ID`
5. no profile, valid only when the gateway has exactly one connected profile

## Commands

```bash
workflow-dispatcher list --config dispatcher.config.json
workflow-dispatcher validate example-title --config dispatcher.config.json
workflow-dispatcher dry-run tests/fixtures/example-title-workflow.json
workflow-dispatcher run example-title --profile personal
workflow-dispatcher history --limit 20
```

All commands that produce machine-readable output support `--json`.

## Exit Codes

- `0`: command succeeded
- `1`: workflow execution failed
- `2`: usage, config, validation, or profile selection error
- `3`: gateway unavailable or no connected extension/profile
- `130`: aborted by signal

## History

Runs write redacted artifacts to `.workflow-runs/<runId>/` by default:

- `events.jsonl`
- `summary.json`
- `workflow.normalized.json`

Use `--no-history` to disable history for a run.

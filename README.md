# Workflow Dispatcher

`@gyga-browser/webmcp-workflow` is the independent workflow runner for WebMCP. It validates and runs WebMCP workflow JSON through the WebMCP HTTP gateway.

It wraps the existing `src/runner/` engine and supports the gateway's multi-profile request shape:

```json
{ "method": "getActiveTab", "params": {}, "profileId": "profile-id" }
```

`profileId` is sent as a top-level `/api` body field. It is never injected into workflow step `params`.

## Install

Install globally from npm and use the standalone command:

```bash
npm install -g @gyga-browser/webmcp-workflow
webmcp-workflow --help
webmcp-workflow --version
```

Or run it without installing:

```bash
npx @gyga-browser/webmcp-workflow --help
```

The package also exposes a `webmcp-workflow-cli` bin as a compatibility alias.

When installed alongside `@gyga-browser/webmcp-browser-automation-kit`, the
same runner can also be invoked through the optional branded bridge:

```bash
webmcp workflow --help
```

For direct runner development inside a monorepo checkout:

```bash
node bin/webmcp-workflow-cli.js --help
```

To install the companion skill and a local `webmcp-workflow-cli` fallback command
for Codex testing:

```bash
npm run install:local
webmcp-workflow-cli --help
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

The source skill lives in `skills/webmcp-workflow-cli/`. The installer
copies it into each provider's global skill/rules directory, following the same
pattern as `webmcp-browser-kit/scripts/install-agent.mjs`.

## Prerequisites

The workflow dispatcher sends commands to a real browser through the **WebMCP
gateway** and **Chrome extension** provided by
[`@gyga-browser/webmcp-browser-automation-kit`](https://www.npmjs.com/package/@gyga-browser/webmcp-browser-automation-kit).
Both must be running before any `run` command will work.

### 1. Install the Chrome extension

Print the path to the bundled unpacked extension:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit extension-path
```

Then load it into Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the path printed above.

### 2. Start the WebMCP gateway

In a dedicated terminal, start the gateway:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit gateway start
```

### 3. Verify connectivity

In another terminal, confirm the extension is connected to the gateway:

```bash
npx -y @gyga-browser/webmcp-browser-automation-kit health --json
```

A successful response shows `"extensionConnected": true`.

### 4. (Optional) Configure MCP server for AI agents

If you want AI agents (Claude, Codex, Cursor, etc.) to call browser commands
via MCP, add this to your client's MCP config:

```json
{
  "mcpServers": {
    "webmcp": {
      "command": "npx",
      "args": ["-y", "@gyga-browser/webmcp-browser-automation-kit", "mcp"]
    }
  }
}
```

See the
[webmcp-browser-automation-kit README](https://github.com/uyencss/web-automation-extension#readme)
for full MCP setup details per client.

## Gateway

By default the CLI connects to:

```bash
WEBMCP_GATEWAY_URL=http://localhost:7865/api
```

For a multi-profile gateway, discover connected profiles:

```bash
webmcp-workflow profiles
webmcp-workflow doctor --profile <profile-id-or-alias>
```

When more than one Chrome profile is connected, pass `--profile` or configure a default profile alias.

## Config

Create `dispatcher.config.json` and adjust workflow paths/profile aliases.

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
webmcp-workflow list --config dispatcher.config.json
webmcp-workflow validate example-title --config dispatcher.config.json
webmcp-workflow dry-run tests/fixtures/example-title-workflow.json
webmcp-workflow run example-title --profile personal
webmcp-workflow history --limit 20
webmcp-workflow handoff latest        # recovery package for the last run
```

All commands that produce machine-readable output support `--json`.

## Exit Codes

- `0`: command succeeded
- `1`: workflow execution failed
- `2`: usage, config, validation, or profile selection error
- `3`: gateway unavailable or no connected extension/profile
- `130`: aborted by signal

## History

Runs write redacted artifacts to `~/.webmcp/workflow-runs/<runId>/` by default
(the shared WebMCP kit home, resolved as `WEBMCP_HOME` > `WEBMCP_DATA_DIR` >
`~/.webmcp`):

- `events.jsonl`
- `summary.json`
- `workflow.normalized.json`

Override the location with `WEBMCP_HOME`, `--history-dir <path>`, or
`defaults.historyDir` in `dispatcher.config.json` (a relative value resolves
against the config/cwd — e.g. set `".workflow-runs"` to keep artifacts inside the
current project as in earlier versions). Use `--no-history` to disable history
for a run.

## Playbooks & Agentic Recovery

A workflow can ship a **playbook** — a sibling `<name>.playbook.md` that gives an
AI agent what the JSON cannot: the task's goal, hard identifiers, verification
criteria, and prohibitions. This turns each workflow into a two-tier automation:

- **Fast path** — the workflow JSON, replayed deterministically by the runner.
  Cheap, fast, pinned to exact identifiers.
- **Recovery path** — when the run fails, an agent reads the playbook and
  finishes the task live through the gateway, then patches the JSON (self-heal).

Playbooks are **fully opt-in**: a workflow without one runs exactly as before.

### Linking a playbook

Set the `playbook` field (resolved relative to the workflow file), or rely on the
convention name `<workflow-basename>.playbook.md`:

```jsonc
{ "id": "my-workflow", "playbook": "./my_workflow.playbook.md", ... }
```

`dry-run` reports whether the playbook was found. If the explicit field points at
a missing file, `validate`/`dry-run` warn (never error).

### The recovery flow (agent operates the CLI)

```text
webmcp-workflow run <id> --json        # fast path; on failure the JSON output
                                        # carries a `handoff` hint + runId
webmcp-workflow handoff latest          # one AI-readable package:
                                        #   failure + progress + remaining steps
                                        #   + the full playbook
# → agent finishes the remaining steps live, verifies per the playbook,
#   then patches the JSON and re-runs validate + dry-run
```

The `handoff` package is redacted (same key-based rules as history) and works for
any recorded run. See `docs/playbook-format.md` for the file spec and
`skills/webmcp-workflow-creator/playbook-template.md` for a starting template.

> Review playbooks like code: a playbook steers an agent holding a logged-in
> browser. For `risk: outward-facing` workflows the **Hard identifiers** and
> **Never do** sections are the guardrails that keep the agent on the right
> target.

### Headless fallback (reserved)

`defaults.agentFallback` is reserved in config for a future mode where the runner
itself spawns a headless agent (`claude -p`, `codex exec`, `gemini -p`) on
failure for fully unattended recovery. It is shape-validated today but not yet
executed.

## Security

- **Workflow JSON is executable input.** `expression` guards and target-based
  guards run arbitrary JavaScript in the connected page via `evaluateJS`, and
  steps drive a real, potentially logged-in browser session. Only run workflow
  files you trust, from sources you control.
- **The gateway is unauthenticated and should bind to `localhost` only.** Do not
  expose the WebMCP gateway port to untrusted networks.
- **History redaction is key-name based.** Fields whose keys match
  `token`/`password`/`cookie`/`authorization`/`apiKey` (configurable via
  `defaults.redactKeys`) are masked in run artifacts. Secrets embedded inside
  free-form response text are not automatically redacted — review artifacts
  before sharing.

## License

[MIT](LICENSE) © uyencss

# Runner Multi-Profile Gateway Implementation Plan

> Date: 2026-07-01  
> Status: Planned  
> Scope: `workflow-dispatcher/src/runner/`, future `workflow-dispatcher` CLI  
> Goal: make the reorganized runner able to execute workflow JSON against the new WebMCP gateway when one gateway serves multiple Chrome profiles.

## Context

The runner was reorganized on 2026-07-01 from flat files into:

```text
src/runner/
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

That reorganization intentionally changed no runtime logic. The next update should keep that structure and add profile-aware gateway routing in a small, explicit way.

The gateway-side multi-profile contract already exists in `mcp-web-extension`:

- `GET /health` returns connected profiles, including `profiles`, `profileCount`, and optionally `profileDetails`.
- `POST /api` accepts `{ "method": "...", "params": { ... }, "profileId": "..." }`.
- `profileId` is a top-level sibling of `params`, not nested inside `params`.
- If exactly one profile is connected, `profileId` is optional.
- If two or more profiles are connected, omitting `profileId` returns HTTP 400.
- An unknown or disconnected `profileId` returns HTTP 404.
- No connected profile returns HTTP 503.

## Design Decisions

### Keep profile routing in transport options

`profileId` should be a runner/transport option, not a workflow step param. Browser commands already use `params` for extension command arguments; mixing gateway routing data into step params would leak transport concerns into workflow JSON.

Target request body:

```js
{
  method,
  params,
  profileId, // only when configured/resolved
}
```

### Preserve backward compatibility

Existing single-profile workflows must continue to run without a profile setting. The runner should only include `profileId` when the caller supplies it. Multi-profile strictness comes from the gateway response.

### Let CLI/config resolve aliases

The runner should accept an exact `profileId`. The future CLI should add higher-level ergonomics:

- `--profile <id-or-alias>`
- `WEBMCP_PROFILE_ID`
- workflow-level `profile`
- gateway-level `profiles` aliases
- `profiles` / `doctor` commands that read `/health`

The runner should not guess aliases itself.

## Required Runner Changes

### Task 1: Add `profileId` support to transport

File: `workflow-dispatcher/src/runner/core/transport.js`

- [ ] Extend `sendCommand(method, params, options)` JSDoc with `options.profileId`.
- [ ] Build `requestBody` before `fetch`:
  ```js
  const requestBody = { method, params };
  if (options.profileId) requestBody.profileId = options.profileId;
  ```
- [ ] Use `JSON.stringify(requestBody)`.
- [ ] Preserve current timeout, abort, and error classification behavior.
- [ ] Ensure no profile data is nested into `params`.

Acceptance:

- [ ] `sendCommand("ping", {}, { profileId: "profile-A" })` posts a top-level `profileId`.
- [ ] `sendCommand("ping", {})` keeps the previous request shape.

### Task 2: Thread profile option through `WorkflowRunner`

File: `workflow-dispatcher/src/runner/core/workflow-runner.js`

- [ ] Extend constructor JSDoc with `options.profileId`.
- [ ] Pass `profileId: this.options.profileId` from `sendGatewayCommand()` into `this.transport(...)`.
- [ ] Include profile information in debug/event metadata only as `profileId`; do not include cookies, emails, or profile names in runner events.

Acceptance:

- [ ] `new WorkflowRunner(workflow, { profileId: "profile-A" })` sends all gateway commands to that profile.
- [ ] Existing callers with only `gatewayUrl` keep working.

### Task 3: Update legacy runner CLI flags

File: `workflow-dispatcher/src/runner/run.js`

- [ ] Add `--profile-id ID`.
- [ ] Add env fallback `WEBMCP_PROFILE_ID`.
- [ ] Pass `profileId` into `new WorkflowRunner(...)`.
- [ ] Mention multi-profile behavior in `--help`.
- [ ] Preserve existing `--gateway-url` behavior.

Acceptance:

- [ ] `node src/runner/run.js workflow.json --profile-id profile-A --dry-run` parses successfully.
- [ ] `WEBMCP_PROFILE_ID=profile-A node src/runner/run.js workflow.json` routes through profile-A on live runs.

### Task 4: Add unit coverage with fake transport

Files:

- `workflow-dispatcher/test/transport-profile.test.js` or future `tests/runner-profile.test.js`
- `workflow-dispatcher/package.json` when test script exists

Use built-in `node:test` if a test suite is added.

Coverage:

- [ ] Transport adds top-level `profileId` only when configured.
- [ ] `WorkflowRunner` forwards `profileId` to injected fake transport.
- [ ] Step params remain unchanged and do not receive `profileId`.

Acceptance:

- [ ] Tests pass without a live gateway or browser extension.

## Future CLI Integration

The production CLI should make profile selection ergonomic around the runner option above.

### Config model

```json
{
  "defaultGateway": "local",
  "gateways": {
    "local": {
      "apiUrl": "http://localhost:7865/api",
      "healthUrl": "http://localhost:7865/health",
      "defaultProfile": "personal",
      "profiles": {
        "personal": "b6a7b273-...",
        "work": "05475d86-..."
      }
    }
  },
  "workflows": {
    "gemini-generate-image": {
      "path": "workflows/gemini/generate_image.json",
      "gateway": "local",
      "profile": "personal"
    }
  }
}
```

Resolution precedence:

1. `--profile <id-or-alias>`
2. workflow config `profile`
3. gateway config `defaultProfile`
4. `WEBMCP_PROFILE_ID`
5. no profile, allowed only when gateway has exactly one connected profile

### CLI commands

```bash
webmcp-workflow profiles [--gateway local] [--json]
webmcp-workflow doctor [--gateway local] [--profile personal] [--json]
webmcp-workflow run <workflow-id-or-path> --profile personal
webmcp-workflow dry-run <workflow-id-or-path> --profile personal
```

`profiles` should call `/health` and print connected profile ids plus friendly metadata when available.

`doctor` should verify:

- gateway is reachable
- extension is connected
- profile selection is unambiguous
- configured profile alias resolves to a connected profile

## Error Handling Expectations

Map multi-profile gateway failures to actionable runner/CLI errors:

| Gateway result | Runner code | CLI exit | User-facing guidance |
|---|---|---:|---|
| HTTP 400 missing `profileId` with multiple profiles | `PROFILE_REQUIRED` or `GATEWAY_BAD_REQUEST` | 2 | Run `profiles`, then pass `--profile` or configure a default profile. |
| HTTP 404 unknown profile | `PROFILE_NOT_FOUND` | 2 | Check `/health` and update profile alias/id. |
| HTTP 503 no connected profile | `GATEWAY_UNAVAILABLE` | 3 | Open Chrome profile and reload/connect the extension. |
| Gateway not reachable | `GATEWAY_UNAVAILABLE` | 3 | Start the WebMCP gateway. |

If the current `classifyMessage()` cannot reliably distinguish profile errors, add narrow message matching there rather than spreading string checks across the CLI.

## Verification Plan

### No live gateway

```bash
node -e "const { sendCommand, WorkflowRunner } = require('./src/runner'); console.log(Boolean(sendCommand && WorkflowRunner))"
node src/runner/run.js tests/fixtures/example-title-workflow.json --dry-run --profile-id profile-A
npm test
```

### Live gateway, one profile

```bash
node src/runner/run.js tests/fixtures/example-title-workflow.json --dry-run
node src/runner/run.js tests/fixtures/example-title-workflow.json --gateway-url http://localhost:7865/api
```

Expected: no profile argument is required.

### Live gateway, multiple profiles

```bash
curl -sS http://localhost:7865/health
node src/runner/run.js tests/fixtures/example-title-workflow.json --profile-id <profile-id>
```

Expected:

- Without `--profile-id`, gateway returns a clear ambiguity error.
- With a connected `profileId`, all workflow steps run in the selected Chrome profile.

## Definition of Done

- [ ] Runner transport supports top-level `profileId`.
- [ ] `WorkflowRunner` forwards profile selection for every gateway command.
- [ ] Legacy `src/runner/run.js` accepts `--profile-id` and `WEBMCP_PROFILE_ID`.
- [ ] Dry-run remains available and backward compatible.
- [ ] Tests verify request shape and runner option propagation without a live gateway.
- [ ] Future CLI plan in `task.md` includes profile discovery, profile aliases, `doctor`, and `profiles`.

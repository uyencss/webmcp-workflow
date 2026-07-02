# Playbook + Agentic Recovery — Implementation Plan

> Status: Implemented (Phases 1–6) in v0.4.0. Phase 7 (headless agent fallback) remains future work; only its `defaults.agentFallback` config stub is reserved.  
> Updated: 2026-07-02  
> Depends on: `20260701_workflow_dispatcher_cli_implementation_plan.md` (implemented CLI surface), `20260701_reorgnanize_runner_code_implementation_plan.md` (runner layout)

## Goal

Make every workflow a **two-tier automation**:

1. **Fast path (deterministic):** the existing workflow JSON, executed by the runner. Cheap, fast, reproducible, pinned to hard identifiers.
2. **Recovery path (agentic):** a sibling **playbook** (`<workflow>.playbook.md`) that an AI agent (Claude Code / Codex / Gemini CLI) reads when the JSON run fails, then finishes the task live through the WebMCP gateway, verifies the outcome, and patches the JSON so the next run is deterministic again (self-healing).

Three deliverables make this work:

- A **playbook file convention + content spec** (what the `.md` must contain so an AI can act safely).
- A new CLI command — `webmcp-workflow handoff <runId|latest>` — that assembles the **handoff package**: playbook + failure context + remaining steps, in one AI-readable blob.
- **Skill updates**: `webmcp-workflow-creator` generates the playbook together with the JSON; `webmcp-workflow-cli` teaches the agent the recovery loop.

## Background & Rationale

### Why not "AI-only" execution

Replacing JSON with pure agentic replay trades brittleness for three worse problems: per-run token cost/latency, non-determinism (e.g. Zalo has two near-identical chats `Uyên` / `Uyên Đặng (TTS)` — JSON pins conversation id `7915241005141557070`, a free-wheeling agent can pick the wrong one), and unbounded improvisation on outward-facing actions (sending messages, submitting forms). JSON stays the source of truth for *what exactly to do*; the playbook is the source of truth for *why*, so the agent can deviate on the *how* without changing the *what*.

### Why the AI sits outside the runner (phase model)

The CLI is a plain Node process; the AI agents are themselves CLIs that *invoke* it via installed skills (`npm run install:claude|codex|gemini` already exists). So:

- **Phase A (this plan):** *AI calls CLI.* The agent runs `run`, sees a failure, runs `handoff`, reads the package, continues via gateway commands it already has (the `webmcp-browser-automation` skill), then patches the JSON. No LLM code inside the runner.
- **Phase B (future, out of scope here except config stubs):** *CLI calls AI.* On failure the runner spawns a headless agent (`claude -p`, `codex exec`, `gemini -p`) with the handoff package as prompt — needed only for unattended/cron runs.

Phase A delivers ~90% of the value with no API-key, cost, or permission management inside the runner. Phase B reuses every artifact built here.

### Why a `handoff` command instead of "the AI just reads `.workflow-runs/`"

Everything the agent needs already exists on disk after a failed run (`summary.json`, `workflow.normalized.json`, `events.jsonl`) — but scattered, partially redacted, and without the playbook. One command that assembles a single ordered, redacted, self-describing package:

- keeps skill instructions short and deterministic ("run `handoff latest`" vs. a page of file-spelunking rules),
- guarantees redaction is applied once, centrally,
- gives Phase B its prompt-builder for free (the package *is* the prompt).

### Where discovery knowledge goes today (and why the creator skill must change)

Authoring a workflow is two-phase (probe live → bake JSON). Today everything learned during probing that doesn't fit a JSON step — the API shape, alternate selectors, the "two Uyên chats" trap, why a wait is 6 s — is thrown away. The playbook is where that knowledge persists, which is why generation belongs in `webmcp-workflow-creator` at authoring time, not as an afterthought.

## Non-Goals

- No LLM client, API keys, or model calls inside the runner or CLI (Phase B is spec'd as config stubs only).
- No runner engine changes to step execution, retries, or routing.
- No new package/library — everything lands in `webmcp-workflow-cli` (mechanics + skills) and the workflow stores (content). A separate library would duplicate the registry/profile/history stack and drift.
- No playbook "execution engine": the playbook is prose for an agent, never parsed for control flow by the runner.
- Playbooks are optional per workflow — a missing playbook must never fail `validate` or `run`.

## Design

### Component map

```text
webmcp-workflow-store/ (or .examples/workflows/)
  library/<site>/<name>.json            ← fast path (existing)
  library/<site>/<name>.playbook.md     ← NEW: agent reference

webmcp-workflow-cli/
  src/
    commands/handoff-command.js         ← NEW: assemble handoff package
    handoff.js                          ← NEW: package builder (shared with Phase B)
    executor.js                         ← MOD: resolve + persist playbook info into summary/index
    workflow-registry.js                ← MOD: resolve `playbook` path relative to workflow file
    cli.js                              ← MOD: register `handoff`, help text
    runner/pipeline/workflow-validator.js ← MOD: warn (not error) on missing playbook file
  skills/
    webmcp-workflow-cli/SKILL.md        ← MOD: agent recovery loop
    webmcp-workflow-creator/SKILL.md    ← MOD: playbook generation spec + template
```

### Runtime flow (Phase A)

```text
Agent (Claude Code / Codex / Gemini CLI)
  │ 1. webmcp-workflow run <id> --json          ← fast path
  │      └─ fails at step N; summary.json now records playbook path
  │ 2. webmcp-workflow handoff latest           ← one readable package
  │ 3. reads playbook: goal, hard identifiers, never-do, verification
  │ 4. finishes remaining work live via WebMCP gateway tools
  │ 5. verifies outcome per playbook criteria
  │ 6. patches workflow JSON → validate → dry-run   (self-healing)
```

### Workflow JSON: new optional top-level field

```jsonc
{
  "id": "zalo-send-greeting-to-uyen",
  "playbook": "./send_greeting_to_uyen.playbook.md",   // NEW, optional
  ...
}
```

- Path is resolved **relative to the workflow JSON file** (same rule as config-relative workflow paths).
- Convention fallback: when the field is absent, tooling looks for a sibling `<basename>.playbook.md`. The registry implements the fallback so JSON authors can omit the field.
- `normalizeWorkflow` already spreads unknown top-level fields (`...source` in `src/runner/pipeline/workflow-normalizer.js:212-219`), so the field survives into `workflow.normalized.json` with **no normalizer change**. Only the validator needs to learn the field (type check + existence warning).

### Playbook file spec (the contract the creator skill enforces)

Filename: `<workflow-basename>.playbook.md`, sibling of the JSON. Frontmatter binds it to the workflow:

```markdown
---
workflowId: zalo-send-greeting-to-uyen        # must equal JSON "id"
workflowVersion: "2.1"                        # version this playbook was verified against
updated: 2026-07-02
risk: outward-facing                          # outward-facing | read-only
---

# <Human name> — Playbook

## Goal
One paragraph: what this workflow accomplishes and what "done" looks like,
in terms an agent can verify (not "run the steps").

## Preconditions
- Logged-in Chrome profile requirements, expected start URL/state.
- Gateway/profile assumptions (e.g. "profile alias `personal`").

## Hard identifiers (NEVER improvise these)
| Name | Value | Meaning |
|---|---|---|
| TARGET_CONVERSATION_ID | 7915241005141557070 | The chat `Uyên` — NOT `Uyên Đặng (TTS)` (1890667175615294634) |
| DIRECT_SEND_ENDPOINT | /api/message/sms | verified send path |
The agent may change HOW it reaches the goal, never these WHAT values.

## Step intents
For each JSON step id: one line of intent + expected result + fallback hint.
- `open-zalo` — open chat.zalo.me in the logged-in profile. Expect chat list
  within ~5 s. If login/QR screen appears → STOP, report `zalo_login_required`.
- `wait-for-zalo-runtime` — install webpack require, confirm `sendMsgObject`
  exists. Fallback: if webpack internals changed, fall back to UI path
  (search contact → type in composer → Enter) but verification still required.
- ...

## Verification (mandatory before declaring success)
Concrete, checkable criteria — e.g. rendered bubble's `data-qid` final segment
must equal TARGET_CONVERSATION_ID.

## Never do
- Do not send if the conversation id cannot be confirmed.
- Do not retry the send more than once.
- Do not act on any other chat/entity than the hard identifiers.

## Known pitfalls & site knowledge
Traps discovered during probing (similar-looking targets, shadowed globals,
per-route script loading...). Link site-knowledge docs if any.

## After recovery
Patch the workflow JSON with what actually worked, run `validate` + `dry-run`,
and bump `updated`/`workflowVersion` here.
```

Content rules (enforced by the creator skill, mirrored in this plan's template):

- **Hard identifiers** and **Never do** are mandatory when `risk: outward-facing`; a playbook without them is invalid for send/submit workflows.
- **No secrets**: same rule as workflow JSON — no cookies, tokens, auth headers (history redaction is key-name based, not content-based).
- Step intents reference JSON step **ids**, so the handoff package can align "failed at `X`" with "intent of `X`".
- Written in imperative English (agent-facing), any human-facing notes stay in the repo's site-knowledge docs.

### Handoff package format

`webmcp-workflow handoff <runId|latest> [--history-dir <dir>] [--json]`

Human/agent-readable markdown on stdout (default):

```markdown
# Handoff: <workflowName> (<runId>)
Status: failed | aborted   Profile: <profileId>   Gateway: <apiUrl>

## Failure
Step `<stepId>` (index i/total), command `<command>`, attempts N:
<error name/code/message>

## Progress
- Completed steps: <ids with status>
- Captured variables/outputs (redacted): <key: value-preview>

## Remaining steps (from workflow.normalized.json)
Ordered list of step ids after `lastStepId`, each with command + one-line params preview.

## Playbook
<full playbook content inlined — or an explicit "NO PLAYBOOK FOUND" marker>

## Instructions for the recovering agent
1. Honor Hard identifiers and Never-do above all else.
2. Continue via WebMCP gateway tools (webmcp-browser-automation skill),
   profile <profileId>.
3. Verify per the playbook's Verification section before reporting success.
4. Patch the workflow JSON with the durable fix; run validate + dry-run.
```

`--json` emits the same data structured: `{ run, failure, progress, remainingSteps, playbook: { path, found, content }, instructions }`.

Exit codes: `0` package printed (even with missing playbook — the marker is part of the package); `2` run id not found / no runs; honors existing conventions.

### Why the executor must persist playbook info at run time

`handoff` runs later, possibly from another cwd, and only sees `.workflow-runs/<runId>/`. The workflow file's location (needed to resolve a relative playbook path) is only known during `run`. Therefore the executor resolves the playbook **at run time** and writes into `summary.json`:

```jsonc
"playbook": { "path": "/abs/path/to/x.playbook.md", "exists": true, "source": "field" | "convention" | null }
```

and a `playbook: true|false` flag into the `index.jsonl` line (so `history` can show which runs are recoverable).

### Phase B stub (config only, no implementation)

Reserve the config key now so Phase B is additive:

```jsonc
"defaults": {
  "agentFallback": {
    "enabled": false,
    "command": "claude",
    "args": ["-p", "{{HANDOFF_PACKAGE}}", "--max-turns", "30"],
    "timeoutMs": 600000
  }
}
```

Config loader validates the shape if present but `run` ignores it (documented as reserved). Spawning, permission flags, and cost controls are a separate future plan.

## Phase 1 — Playbook Spec and Template

- [ ] Add `docs/playbook-format.md` — the canonical spec (frontmatter fields, mandatory sections, content rules, risk levels) matching the Design section above.
- [ ] Add `skills/webmcp-workflow-creator/playbook-template.md` — copy-paste template with placeholder comments per section.
- [ ] Write one **reference playbook** for an existing example workflow (recommended: `.examples/workflows/mobifone/theo_doi_dau_thau_v2.json` — read-only risk, rich probe knowledge already documented in the creator skill §1).
- [ ] Write one **outward-facing reference playbook** (Zalo send workflow in `webmcp-workflow-store/library/zalo/`) exercising Hard identifiers + Never-do.

Acceptance:

- [ ] Both reference playbooks pass the spec's mandatory-section checklist.
- [ ] The outward-facing playbook demonstrably prevents the known trap (two similar chat targets) via Hard identifiers.

## Phase 2 — Schema and Pipeline Plumbing

- [ ] `src/runner/pipeline/workflow-validator.js`
  - [ ] Accept optional top-level `playbook` (must be a non-empty string when present; wrong type = validation error).
  - [ ] Do **not** check file existence here (validator is path-agnostic; existence is registry/executor concern).
- [ ] `src/workflow-registry.js`
  - [ ] After resolving the workflow file, resolve `playbook`: explicit field (relative to workflow file dir) → else convention sibling `<basename>.playbook.md` → else null.
  - [ ] Return `{ playbookPath, playbookSource }` in the resolved descriptor.
- [ ] `src/executor.js`
  - [ ] Persist `summary.playbook = { path, exists, source }` (fs check at run start).
  - [ ] Append `playbook: <boolean>` to the `index.jsonl` entry.
- [ ] `validate` / `dry-run` output
  - [ ] `dry-run` report includes playbook path + found/not-found.
  - [ ] `validate` prints a **warning** (not error) when the `playbook` field points to a missing file.
- [ ] `src/config-loader.js`: accept + shape-validate reserved `defaults.agentFallback` (documented as reserved, unused).

Acceptance:

- [ ] Workflow with no playbook: `validate`, `dry-run`, `run` behave exactly as today (no warnings for convention-miss).
- [ ] Workflow with `playbook` field pointing at a missing file: `validate` warns, exit code still `0`.
- [ ] Failed run's `summary.json` contains the resolved absolute playbook path.
- [ ] `workflow.normalized.json` retains the `playbook` field (already guaranteed by `...source` spread — covered by a regression test).

## Phase 3 — `handoff` Command

- [ ] Create `src/handoff.js` (builder, no I/O side effects beyond reads):
  - [ ] `resolveRun(runIdOrLatest, { historyDir, cwd })` — `latest` = last line of `index.jsonl`; explicit id = directory lookup. Errors with exit code `2` semantics when absent.
  - [ ] `buildHandoffPackage({ runDir })` — reads `summary.json` + `workflow.normalized.json` (+ playbook file), computes remaining steps from `lastStepId` against the normalized step order (accounting for `stepsCompleted`/statuses in `context.steps`), applies redaction (`src/redaction.js`) to variable previews, and returns the structured object.
  - [ ] `renderHandoffMarkdown(pkg)` — the markdown layout from Design.
- [ ] Create `src/commands/handoff-command.js` — thin wrapper: parse positional, call builder, print markdown or `--json`.
- [ ] `src/cli.js`
  - [ ] Register `handoff` in `COMMANDS`.
  - [ ] Add to root help: `handoff <runId|latest>   Print an AI-readable recovery package for a failed run`.
  - [ ] Reuse existing `--history-dir`, `--json` options (already parsed).
- [ ] `run --json` failure output: include `handoff: { hint: "webmcp-workflow handoff <runId>", playbookFound: <bool> }` so an agent discovers the next move from the failure itself.

Acceptance:

- [ ] `handoff latest` after a (fixture) failed run prints all package sections in order.
- [ ] Missing playbook → package still prints with explicit `NO PLAYBOOK FOUND` marker, exit `0`.
- [ ] Unknown run id / empty history → exit `2` with actionable message.
- [ ] Secrets in captured variables (per `redactKeys`) never appear in package output.
- [ ] `handoff <id> --json` round-trips: every markdown section derivable from the JSON payload.

## Phase 4 — Skill Updates

- [ ] `skills/webmcp-workflow-creator/SKILL.md`
  - [ ] New section "§ Playbook — every workflow ships with one": JSON and playbook are authored **together**; probe-phase knowledge that doesn't fit a step (API shapes, alternate paths, traps, timing rationale) goes in the playbook, not in comments or nowhere.
  - [ ] Embed the template (or reference `playbook-template.md`) + the mandatory-section rules, incl. the outward-facing rule (Hard identifiers + Never-do required).
  - [ ] Update the authoring checklist (§8): add "write/refresh the sibling playbook; set `playbook` field or rely on convention naming".
  - [ ] Update the golden path: design → **playbook** → `validate` → `dry-run` → `run`.
- [ ] `skills/webmcp-workflow-cli/SKILL.md`
  - [ ] New section "§ Recovery loop (when a run fails)":
    1. `webmcp-workflow handoff latest` (or the runId from the failure output).
    2. Read the package; **Hard identifiers and Never-do are binding**.
    3. Continue the remaining steps live via the `webmcp-browser-automation` skill against the same gateway/profile.
    4. Verify per the playbook's Verification section — never declare success without it.
    5. Patch the workflow JSON with the durable fix; `validate` + `dry-run`; update the playbook's `updated`/version.
    6. If the playbook forbids proceeding (e.g. `zalo_login_required`, unconfirmable target) → stop and report; do not improvise around a Never-do.
- [ ] Re-run provider installs in dev flow docs (`npm run install:local` etc. — no installer code change expected; verify skill copy includes the new template file).

Acceptance:

- [ ] Creator skill, followed literally, produces a JSON + playbook pair for a new workflow.
- [ ] CLI skill, followed literally on a fixture failure, leads an agent through handoff → recovery → verification → JSON patch without extra guessing.

## Phase 5 — Store and Examples Alignment

- [ ] `webmcp-workflow-store/library/`: add playbooks next to existing workflows (zalo, mobifone) using the Phase 1 references.
- [ ] `.examples/workflows/`: add at least the mobifone reference playbook so the shipped examples demonstrate the pair convention.
- [ ] Add `playbook` field to those JSONs (explicit field preferred over convention in published examples, for discoverability).

Acceptance:

- [ ] `webmcp-workflow dry-run` on each updated example reports its playbook as found.

## Phase 6 — Tests and Docs

- [ ] Unit tests (`node:test`, no live gateway — follow existing fake-transport patterns):
  - [ ] Validator: `playbook` type check (string ok, non-string error, absent ok).
  - [ ] Registry: field vs. convention vs. none resolution; relative-path anchoring to the workflow file dir.
  - [ ] Normalizer regression: `playbook` survives into normalized output.
  - [ ] Executor: `summary.playbook` written on success and on failure; `index.jsonl` flag.
  - [ ] Handoff builder: remaining-step computation (failure at first/middle/last step; skipped steps), redaction, missing-playbook marker, `latest` resolution, unknown id.
  - [ ] CLI: `handoff` arg parsing, help text, exit codes.
- [ ] Fixtures: a failed-run history directory (pre-baked `summary.json` + `workflow.normalized.json` + playbook) under `tests/fixtures/`.
- [ ] `README.md`: new "Playbooks & agentic recovery" section — the two-tier model, file convention, `handoff` reference, the Phase A flow diagram, and the security note (playbooks are agent instructions: review them like code, they steer an agent holding a logged-in browser).
- [ ] `CHANGELOG.md` entry.

Acceptance:

- [ ] `npm test` passes without a real gateway; no writes outside temp dirs.
- [ ] A new user can go failure → `handoff` → understand the recovery contract from README alone.

## Phase 7 (Future — separate plan) — Headless Agent Fallback

Not implemented in this plan; recorded for continuity:

- `run --agent-fallback` spawns the configured agent CLI (`claude -p` / `codex exec` / `gemini -p`) with the handoff package as prompt when a run fails.
- Requires: permission strategy per provider (e.g. `--allowedTools`), spend/turn caps, overall timeout, non-interactive exit-code contract (agent success ⇒ run reported `completed_via_agent`), and a lock so agent recovery respects the existing gateway/profile lock keys.
- Everything above (package builder, playbook spec, summary fields) is reused as-is; only the spawn/supervise layer is new.

## Implementation Order

1. Playbook spec + template + two reference playbooks (Phase 1) — unblocks skill writing and fixtures.
2. Pipeline plumbing: validator, registry, executor summary (Phase 2).
3. `handoff` builder + command + run-failure hint (Phase 3).
4. Skill updates for creator and CLI (Phase 4).
5. Store/example alignment (Phase 5).
6. Tests + README + changelog (Phase 6).

## Definition of Done

- [ ] Every shipped example workflow has a sibling playbook that passes the spec checklist.
- [ ] A failed `run --json` tells the agent exactly what to do next (`handoff` hint + playbook flag).
- [ ] `webmcp-workflow handoff latest` produces a single package containing failure context, remaining steps, and the playbook, fully redacted.
- [ ] `webmcp-workflow-creator` skill generates JSON + playbook together; `webmcp-workflow-cli` skill defines the binding recovery loop (hard identifiers / never-do / mandatory verification).
- [ ] Workflows without playbooks run exactly as before; the feature is fully opt-in.
- [ ] `npm test` covers resolution, persistence, package building, and CLI behavior without a live browser.
- [ ] Reserved `agentFallback` config validates but is inert, keeping Phase B purely additive.

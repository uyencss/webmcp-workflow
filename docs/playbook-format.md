# Playbook Format

A **playbook** is a markdown file that pairs with a workflow JSON and tells an
AI agent how to *recover* the task when the deterministic run fails — the "why"
and the guardrails that the JSON alone cannot express.

- **Workflow JSON** = the fast path. Deterministic, cheap, pinned to exact
  identifiers. The runner replays it.
- **Playbook `.md`** = the recovery path. Prose an agent reads (via
  `webmcp-workflow handoff`) to finish the task live and then patch the JSON.

Playbooks are **optional** and **opt-in**. A workflow without one runs exactly
as before. The runner never parses a playbook for control flow — it only reads
its content into the handoff package.

## File location & naming

Place the playbook next to its workflow JSON. Two ways to link them:

1. **Explicit field** (preferred for shipped examples — discoverable):
   ```jsonc
   { "id": "...", "playbook": "./my_workflow.playbook.md", ... }
   ```
   The path is resolved relative to the workflow JSON's directory.
2. **Convention** (zero-config): a sibling file named
   `<workflow-basename>.playbook.md`. If `my_workflow.json` has no `playbook`
   field, the tooling looks for `my_workflow.playbook.md` automatically.

If the explicit `playbook` field points at a missing file, `validate`/`dry-run`
emit a **warning** (never an error). A convention miss is silent.

## Frontmatter (required)

```yaml
---
workflowId: my-workflow          # MUST equal the JSON "id"
workflowVersion: "2.1"           # the workflow version this playbook was verified against
updated: 2026-07-02              # ISO date of last verification
risk: outward-facing             # outward-facing | read-only
---
```

- `risk: outward-facing` — the workflow sends messages, submits forms, posts,
  pays, or otherwise changes state visible to others. **Hard identifiers** and
  **Never do** become mandatory.
- `risk: read-only` — the workflow only reads/scrapes. Those sections are
  recommended but not mandatory.

## Mandatory sections

Every playbook must contain, in order:

### `## Goal`
One paragraph: what the workflow accomplishes and what "done" looks like, phrased
so an agent can *verify* it — not "run the steps", but "message X appears in
chat Y".

### `## Preconditions`
Login/profile requirements, expected start URL/state, gateway/profile
assumptions.

### `## Hard identifiers (NEVER improvise these)`
*(Mandatory when `risk: outward-facing`.)* A table of values the agent must use
verbatim and must never guess, substitute, or infer: conversation ids, target
endpoints, recipient ids, account ids. The agent may change **how** it reaches
the goal; it must never change these **what** values.

```markdown
| Name | Value | Meaning |
|---|---|---|
| TARGET_CONVERSATION_ID | 7915241005141557070 | chat `Uyên` — NOT `Uyên Đặng (TTS)` (1890667175615294634) |
```

### `## Step intents`
For each JSON step **id**: one line of intent + expected result + a fallback
hint. Reference step ids so the handoff package can align "failed at `X`" with
"intent of `X`".

### `## Verification (mandatory before declaring success)`
Concrete, checkable criteria. Example: the rendered message bubble's `data-qid`
final segment must equal `TARGET_CONVERSATION_ID`. The agent must not report
success without satisfying these.

### `## Never do`
*(Mandatory when `risk: outward-facing`.)* Explicit prohibitions. Examples: do
not send if the target id can't be confirmed; do not retry a send more than
once; do not act on any entity other than the hard identifiers.

## Optional sections

- `## Known pitfalls & site knowledge` — traps found during probing
  (similar-looking targets, shadowed `window.URL`, per-route script loading).
  Link to `site-knowledge/` docs when they exist.
- `## After recovery` — reminder to patch the JSON with what worked, run
  `validate` + `dry-run`, and bump `updated`/`workflowVersion` here.

## Content rules

- **No secrets.** Same rule as workflow JSON: never embed cookies, tokens, auth
  headers, or raw encrypted payloads. History redaction is key-name based, not
  content-based — it will not save a secret pasted into prose.
- **Agent-facing imperative English.** Human-facing narrative belongs in repo
  site-knowledge docs, not the playbook.
- **Treat playbooks like code in review.** A playbook steers an agent that holds
  a logged-in browser; review changes as carefully as executable changes.

## Validation checklist

A playbook is well-formed when:

- [ ] Frontmatter has `workflowId` matching the JSON `id`, plus
      `workflowVersion`, `updated`, `risk`.
- [ ] Goal / Preconditions / Step intents / Verification are present.
- [ ] If `risk: outward-facing`: Hard identifiers and Never do are present and
      non-empty.
- [ ] Step intents reference real JSON step ids.
- [ ] No secrets anywhere in the file.

See `skills/webmcp-workflow-creator/playbook-template.md` for a copy-paste
starting point, and the paired reference playbooks under
`.examples/workflows/` for worked examples.

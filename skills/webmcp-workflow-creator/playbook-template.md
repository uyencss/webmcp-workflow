---
workflowId: REPLACE-with-json-id        # MUST equal the workflow JSON "id"
workflowVersion: "1.0"                   # version this playbook was verified against
updated: YYYY-MM-DD                       # ISO date of last verification
risk: read-only                           # outward-facing | read-only
---

# <Human Workflow Name> — Playbook

<!--
This playbook is the RECOVERY reference for an AI agent when the deterministic
workflow JSON fails. Keep it agent-facing and imperative. Never embed secrets.
Sections marked (required) must be present; Hard identifiers + Never do are
MANDATORY when risk: outward-facing.
-->

## Goal
<!-- (required) One paragraph. What the workflow accomplishes and what "done"
looks like, phrased so an agent can VERIFY it (an observable end state), not
just "run the steps". -->

## Preconditions
<!-- (required) Logged-in profile requirements, expected start URL/state,
gateway/profile assumptions. -->

## Hard identifiers (NEVER improvise these)
<!-- (MANDATORY for outward-facing) Values the agent must use verbatim and must
never guess/substitute. The agent may change HOW it reaches the goal, never
these WHAT values. Delete this section only for pure read-only workflows. -->

| Name | Value | Meaning |
|---|---|---|
| EXAMPLE_TARGET_ID | 1234567890 | the exact target — NOT a similar-looking one |

## Step intents
<!-- (required) One line per JSON step id: intent + expected result + fallback
hint. Use the real step ids so handoff can align failures to intents. -->

- `step-id-1` — <intent>. Expect <result>. Fallback: <hint / STOP condition>.
- `step-id-2` — <intent>. Expect <result>. Fallback: <hint>.

## Verification (mandatory before declaring success)
<!-- (required) Concrete, checkable criteria. The agent must NOT report success
without satisfying these. -->

- <checkable criterion, e.g. "rendered bubble data-qid ends with TARGET_ID">

## Never do
<!-- (MANDATORY for outward-facing) Explicit prohibitions. Delete only for pure
read-only workflows. -->

- Do not <prohibited action> unless <precondition> is confirmed.
- Do not retry <outward-facing action> more than once.
- Do not act on any entity other than the Hard identifiers above.

## Known pitfalls & site knowledge
<!-- (optional) Traps found while probing: similar-looking targets, shadowed
globals, per-route script loading. Link site-knowledge docs if any. -->

## After recovery
<!-- (optional but recommended) Patch the workflow JSON with what actually
worked, run validate + dry-run, then bump `updated` / `workflowVersion` above. -->

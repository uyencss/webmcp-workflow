---
name: webmcp-pipeline-creator
description: Author WebMCP pipeline JSON (`*.pipeline.json`) that chains multiple existing, already-verified workflows into one durable run through `webmcp-workflow pipeline`. Use when composing a multi-step automation across sites/tools (e.g. Gemini → Suno, news → summarize → video → publish) with state handoff between stages, per-stage verify gates, checkpoint/resume, and a human approval gate before outward-facing (post/send/upload) steps. Covers the stages/`with`/`verify`/`captureAs`/`risk`/`gate`/`idempotencyKey` schema and the compose-not-monolith rule. Does NOT teach browser/DOM authoring — that is `webmcp-workflow-creator`.
---

# WebMCP Pipeline Creator

This skill teaches you to **compose existing workflows into a pipeline** — a
durable chain that runs through `webmcp-workflow pipeline run`. It is the layer
*above* a single workflow.

> **Altitude check.** If your task needs *new* browser interaction on a site,
> stop and use **`webmcp-workflow-creator`** first to build and verify that
> workflow. This skill only **wires already-existing, verified workflows
> together**. It teaches zero DOM/`evaluateJS`.

A pipeline gets its stability from **deterministic gates between stages**, not
from the AI: verify-as-gate, checkpoint/resume, idempotency, and a human gate.
See `docs/20260703_pipeline_orchestration_layer.md` for the full design.

---

## 0. The one rule: compose, do NOT inline (no monoliths)

A pipeline stage **points at a workflow file that already exists** in the store
(with its own `.verify.json` + playbook). Never paste site logic into the
pipeline. Composition is what lets each stage self-heal independently and be
reused. The old `_cross-site/gemini-to-suno-create-song.json` is the
**anti-pattern** (one flat 11-step blob); the migrated
`_cross-site/pipelines/gemini-to-suno.pipeline.json` + the two child workflows
(`sites/gemini/workflows/create-song-content.json`,
`sites/suno/workflows/create-song.json`) are the pattern to copy.

---

## 1. Where files live

```
webmcp-workflow-store/
  sites/<site>/workflows/<name>.json          # child workflows (built by workflow-creator)
  sites/<site>/workflows/<name>.verify.json   # each child's signals (the gate)
  _cross-site/pipelines/<name>.pipeline.json  # the pipeline manifest (this skill)
```

Stage `workflow` / `verify` paths are **relative to the store root**. To draft a
new pipeline before it lands, author it as a `drafts/pipelines/<id>/` pack and
promote it with `webmcp-store-curator`.

---

## 2. Manifest anatomy

```jsonc
{
  "id": "gemini-to-suno",
  "version": "1.0",
  "description": "One-line what/why.",
  "variables": { "SONG_BRIEF": "…", "LYRICS_LANGUAGE": "tiếng Việt" }, // pipeline inputs
  "settings": {
    "onStageFail": "stop",                 // stop | skip | alert
    "checkpointDir": "~/.webmcp/pipelines"
  },
  "stages": [
    {
      "id": "content",
      "workflow": "sites/gemini/workflows/create-song-content.json",
      "with":     { "SONG_BRIEF": "{{PIPELINE.SONG_BRIEF}}" },       // state → child variables
      "verify":   "sites/gemini/workflows/create-song-content.verify.json",
      "captureAs":"CONTENT",                                          // child FINAL_REPORT → state
      "risk":     "generate"
    },
    {
      "id": "song",
      "workflow": "sites/suno/workflows/create-song.json",
      "with":     { "content": "{{CONTENT}}" },                       // inter-workflow handoff
      "verify":   "sites/suno/workflows/create-song.verify.json",
      "captureAs":"SONG",
      "risk":     "generate"
    }
  ]
}
```

### Stage fields

| Field | Meaning |
|---|---|
| `workflow` | store-relative path to an existing workflow JSON. |
| `with` | maps state → the child's `variables`. Values are interpolated (§3). |
| `verify` | the gate. Either a path to a `*.verify.json` (grades the run's `summary` via signals) or an inline `{ "type":"artifact", "path":"$.filePath", "exists":true }` (checks the child's `FINAL_REPORT`). Non-green → `onStageFail`. |
| `captureAs` | stores the child's `FINAL_REPORT` (or all outputs) under this name in pipeline state. |
| `profile` | optional browser profile ID or configured alias for this stage. It overrides the pipeline CLI `--profile`, allowing one pipeline to safely compose sites authenticated in different profiles. |
| `risk` | `read-only` \| `generate` \| `outward-facing` \| `destructive` — drives the safety policy (§4). |
| `gate` | `"human"` on an outward-facing stage → the pipeline pauses for approval. |
| `idempotencyKey` | an interpolated string; a resume/re-scan never re-runs a stage whose key is already recorded as done. Set it on outward-facing stages. |

---

## 3. State & `{{ }}` interpolation

- Pipeline state starts as `{ PIPELINE: <manifest.variables> }`.
- After a stage, `captureAs` adds `{ <NAME>: <that stage's FINAL_REPORT> }`.
- In `with`, reference state with dotted paths: `{{PIPELINE.keywords}}`,
  `{{CONTENT.title}}`, `{{VIDEO.filePath}}`.
- A value that is **only** `{{X}}` returns the real value (object/array preserved),
  so `"content": "{{CONTENT}}"` passes the whole object. An embedded ref does
  string interpolation (objects are JSON-stringified).
- The child workflow then interpolates those variables into its own steps exactly
  as `webmcp-workflow-creator` describes (e.g. `const c = {{content}};`). Prefer
  passing **one object variable** over many string variables when the child needs
  multi-line text (lyrics, scripts) — JSON interpolation avoids escaping bugs.

---

## 4. Risk tiers — protect the account, not just the workflow

| tier | auto-run | verify depth | gate |
|---|---|---|---|
| `read-only` | yes | signals (`*.verify.json`) | none |
| `generate` | yes | "artifact produced + right shape" | none (gate if it spends money/credits and that needs sign-off) |
| `outward-facing` (post/send/upload/DM) | **up to the gate** | — | **`gate: "human"` always** + `idempotencyKey` |
| `destructive` | never | — | human |

**Any stage that posts, sends, DMs, or uploads to an audience is
`outward-facing` and MUST have `gate: "human"` + an `idempotencyKey`.** The gate
pauses the run; a human approves; a resume publishes exactly once. Self-healing
never touches outward-facing stages — a banned account cannot be healed.

---

## 5. Run lifecycle (what the author should expect)

```
webmcp-workflow pipeline run <manifest> --profile <id>
  → runs stages; on an outward-facing gate it writes a pending-approval and STOPS.
webmcp-workflow pipeline status
webmcp-workflow pipeline approve <runId>     # you reviewed the artifact
webmcp-workflow pipeline scan                # resumes every approved run (publishes)
webmcp-workflow pipeline resume <runId>      # or resume one directly
```

Checkpoints are written after every stage, so a failure/pause resumes from the
exact stage without re-running earlier (credit-spending / already-published) ones.

---

## 6. Authoring checklist

1. **Every stage's `workflow` already exists and has a `.verify.json`.** If not,
   go build it with `webmcp-workflow-creator` first.
2. Map inputs with `with`; use `{{PIPELINE.x}}` for pipeline inputs and
   `{{PRIOR.path}}` for handoffs.
3. Give each meaningful stage a `verify` gate so garbage cannot flow downstream.
4. Tag `risk` honestly. Mark posting/sending stages `outward-facing` + `gate:
   "human"` + `idempotencyKey`.
5. `pipeline run` it once against one profile; confirm the gate pauses and
   `approve` → `scan` completes.
6. Keep the manifest thin — no site logic. If you are tempted to inline a step,
   that belongs in a child workflow.

---

## 7. Common pitfalls

- **Inlining logic** (rebuilding a monolith). Compose child workflows instead.
- **Forgetting the gate** on a publish stage → the account auto-posts unsupervised.
- **No `idempotencyKey`** on outward-facing → a resume double-posts.
- **Passing multi-line text as a string variable** and hitting escaping bugs —
  pass an object and let the child JSON-interpolate it.
- **A stage with no `verify`** in a chain where its output feeds a later stage —
  you lose the gate that stops cascade failures.

# Pipeline Orchestration Layer — Design & Implementation Plan

> **Date**: 2026-07-03
> **Status**: P0–P4b implemented (2026-07-03). Safety hardening tracked in
> `20260703_pipeline_orchestration_hardening_plan.md`; P5 pending.
> **Scope**: `webmcp-workflow-cli/src/` (new pipeline runner + relocated grading engine); pipeline manifests stored as data in `webmcp-workflow-store/_cross-site/pipelines/`
> **Depends on**: `20260701_workflow_dispatcher_cli_implementation_plan.md` (single-workflow runner), `20260702_playbook_agentic_recovery_implementation_plan.md` (resume/handoff), store `2026-07-03-knowledge-versioning-and-verification.md` (verify `signals`, store-doctor)

---

## 1. Goal & context

The WebMCP trinity — **browser-kit** (hands/eyes: gateway + extension), **workflow-cli**
(single-workflow executor), **store** (knowledge + workflows + verify specs + self-healing)
— forms an *AI-native* automation platform. The differentiator vs n8n/Zapier is **not**
"AI runs everything" (non-deterministic = fragile), but the **split**:

> **AI at the edges (authoring workflows + self-healing when they break), determinism at
> the core (running + verifying).** AI rarely touches the hot path; 99% of runs are the
> deterministic runner + `signals` grading against a semantic contract.

The missing piece to complete the "n8n but AI-native" thesis is **not more sites**, but a
**durable orchestration layer** to chain multiple workflows (e.g. Gemini→Suno→video→upload)
with: state handoff between stages, per-stage verify as a gate, pipeline-level
checkpoint/resume, and a human gate for outward-facing steps.

**Stability principle (project framing):** stability comes not from "smarter AI" but from
**deterministic gates between stages** — verify-gate, checkpoint, idempotency, human-gate.

---

## 2. What the single-workflow engine already provides (do not rebuild)

A survey of `src/runner/` shows a single workflow is already a small orchestrator:

| Capability | Existing mechanism |
|---|---|
| Per-step retry | `settings.defaultRetryPolicy {maxAttempts, backoffMs, maxBackoffMs, retryOn}` + per-step override |
| Skip / continue-on-error | `settings.continueOnNonCriticalFailure` + per-step `critical` flag |
| State between steps | `captureAs` → `workflow-context.js`, interpolated as `{{VAR}}`, `{{VAR.path}}` |
| Resume after failure | `handoff.js: resolveResumeIndex(summary, steps)` |
| Cancel / timeout | `transport.js` abort signal + retryable-error classification |
| Artifact output | `summary.json` (per-step status, `context.outputs`) |

`_cross-site/gemini-to-suno-create-song.json` proves 11 steps across 2 sites run and pass
state via `{{GEMINI_RESULT}}`.

**Conclusion:** no need to rewrite retry/state/resume. The gap is **one level up**.

---

## 3. The actual gap

The `gemini-to-suno` seed is a **single flat monolithic JSON** (both Gemini and Suno logic
crammed into one file with huge `evaluateJS` blobs). Consequences:

1. **No reuse** of the individual Gemini / Suno workflows, no benefit from their
   `.verify.json` + per-site self-healing → the whole pipeline rots as one block.
2. **Resume is only within one workflow.** A chain A→B→C where B dies → re-run from the
   start = wasted Suno credits / double posting.
3. **Verify is an offline process** (store-doctor grades *after the fact*), not a gate
   between stages → garbage from A still flows into B.
4. **No `--stop-before`** → cannot stop-before-publish.

→ The gap = a **thin** "compose already-verified workflows" layer + 3 mechanisms:
**verify-as-gate**, **pipeline-level checkpoint**, and a **human gate** for outward-facing.

---

## 4. Architecture decisions

### 4.1. Where the pipeline runner lives: **extend workflow-cli** (not the store, not a 4th package)

| Criterion | Extend workflow-cli ✅ | 4th package | In the store |
|---|---|---|---|
| Reuse primitives (retry/state/resume/transport) | High — a pipeline is "a workflow of workflows" | Must call it as a lib | — |
| Verify-gate needs the `signals` grading engine | Comes home (executor = judge) | Duplicate / cross-dep | Violates "store only stores" |
| Parts to maintain | Keep the **trinity** | Becomes a quartet (drift) | — |
| Mental model | One command family `webmcp-workflow …` | Two tools both running via the gateway | — |

**The project's guiding rule: the store ONLY stores information, it does not run anything.**
That rule pushes grading/verify out of the store toward the executor. Therefore:

- **Pipeline manifest = DATA** → lives in the store: `_cross-site/pipelines/<name>.pipeline.json`.
- **Pipeline runner = EXECUTION** → lives in workflow-cli.
- **The `signals` grading engine (`gradeSummary`) migrates** from `store-doctor.mjs` into
  `webmcp-workflow-cli/src/` (shared by the pipeline verify-gate and single-workflow grading).

### 4.2. Trinity roles after this work

```
browser-kit   = hands & eyes        (gateway + extension)
workflow-cli  = executor + judge + orchestrator     ← pipeline lives here
store         = pure memory: knowledge · workflows · verify specs · pipeline manifests (DATA only)
```

### 4.3. Note on store-doctor (no immediate refactor)

`store-doctor` + `doctor-cron` currently run *inside the store* — a mild conflict with the
"store only stores" rule. **Not urgent:** the doctor works today, leave it. The long-term
consistent state is that the probe/grade/rerun/scheduler engine also migrates to the runner
side. The first step of that migration is moving `gradeSummary` into workflow-cli (§4.1) —
done here because the pipeline needs it. Merging the rest of the doctor is a later, separate
refactor.

### 4.4. Authoring skill: a separate `webmcp-pipeline-creator` (do NOT extend workflow-creator)

Authoring a pipeline is a different altitude and a different body of knowledge than
authoring a workflow, so it gets its own skill rather than bloating `webmcp-workflow-creator`.

| | `webmcp-workflow-creator` (exists) | `webmcp-pipeline-creator` (new) |
|---|---|---|
| Question it answers | "How do I make Chrome do X on site Y" | "How do I chain workflows A→B→C safely" |
| Knowledge required | DOM/API/`evaluateJS`/`forEach`/selectors | manifest schema, state handoff, verify-gate, risk tiers, idempotency, human-gate |
| Needs browser knowledge? | **Yes** (core) | **No** — only wiring existing pieces |
| Precondition | — | child workflows already exist + are verified |

Rationale:

- **One skill = one job.** `webmcp-workflow-creator` already delineates itself from siblings
  ("the sibling skill `webmcp-workflow-cli` covers running; this covers designing"). A
  pipeline skill is the natural third sibling. Merging would blur that boundary and bloat a
  498-line skill.
- **Progressive-disclosure triggering.** Skills auto-load by `description`. A composition task
  ("chain Gemini→Suno→upload with an approval gate") should trigger the pipeline skill, not
  the workflow skill. Separate descriptions keep the right one firing.
- **A 4th skill is cheap; a 4th package is not.** Unlike the runner-placement decision (§4.1,
  reject a 4th package), a skill is just one markdown file installed by the same installer.

**Skill map after this work** (mirrors the existing discover → author → run chain):

```
webmcp-browser-automation  → discover/probe (live)               [browser-kit]
webmcp-workflow-creator    → author ONE workflow JSON            [workflow-cli]
webmcp-pipeline-creator    → COMPOSE workflows into a pipeline    [workflow-cli]  ← NEW
webmcp-workflow-cli        → run/debug workflows & pipelines      [workflow-cli]
```

**Placement:** `webmcp-workflow-cli/skills/webmcp-pipeline-creator/` (next to
`webmcp-workflow-creator` — it teaches the pipeline schema that the workflow-cli runner
defines, same as workflow-creator teaches the workflow schema).

**Scope of the new skill:**
- The `*.pipeline.json` schema (§5): `stages`, `with`, `verify`, `captureAs`, `risk`, `gate`,
  `idempotencyKey`, `onStageFail`.
- Inter-stage state handoff rules (`{{PIPELINE.x}}`, `{{<captureAs>.path}}`).
- When to gate: any `outward-facing` stage → `gate: human`; protect the account over the workflow.
- Verify-as-gate choice: point at a `*.verify.json` vs an inline `artifact` check.
- Checkpoint/resume + idempotency implications for the author.
- **Decision rule it teaches:** if the task needs new browser interaction on a site → use
  `webmcp-workflow-creator` first to build (and verify) that workflow; if all the pieces
  already exist and you are only wiring them → use `webmcp-pipeline-creator`.
- **It actively steers away from the monolith pattern** (e.g. the current
  `gemini-to-suno-create-song.json`): compose verified workflows, do not inline site logic.
- It does **not** teach browser/DOM authoring — it delegates that to `webmcp-workflow-creator`.

---

## 5. `*.pipeline.json` schema

```jsonc
{
  "id": "news-to-video-daily",
  "version": "1.0",
  "description": "Pull news → AI summarize → render video → (await approval) publish to YouTube.",

  "variables": {                       // pipeline inputs (like workflow.variables)
    "keywords": "economy, technology"
  },

  "settings": {
    "onStageFail": "stop",             // stop | skip | alert   (pipeline-wide default)
    "checkpointDir": "~/.webmcp/pipelines",
    "notify": null                     // future: telegram/zalo channel
  },

  "stages": [
    {
      "id": "pull-news",
      "workflow": "sites/vnexpress/workflows/pull-headlines.json",  // path within the store
      "with":     { "keywords": "{{PIPELINE.keywords}}" },          // pipeline/prior state → workflow.variables
      "verify":   "sites/vnexpress/workflows/pull-headlines.verify.json", // GATE: grade signals after the run
      "captureAs":"NEWS",              // the stage's FINAL_REPORT → pipeline state
      "risk":     "read-only"
    },
    {
      "id": "summarize",
      "workflow": "sites/gemini/workflows/summarize.json",
      "with":     { "articles": "{{NEWS.items}}" },                 // inter-workflow handoff
      "captureAs":"SCRIPT",
      "risk":     "generate"
    },
    {
      "id": "make-video",
      "workflow": "sites/capcut/workflows/render.json",
      "with":     { "script": "{{SCRIPT.text}}" },
      "captureAs":"VIDEO",
      "verify":   { "type": "artifact", "path": "$.filePath", "exists": true }, // checks this stage's FINAL_REPORT
      "risk":     "generate"
    },
    {
      "id": "publish-youtube",
      "workflow": "sites/youtube/workflows/upload.json",
      "with":     { "file": "{{VIDEO.filePath}}", "title": "{{SCRIPT.title}}" },
      "risk":     "outward-facing",
      "gate":     "human",             // STOP here, await approval
      "idempotencyKey": "{{VIDEO.hash}}"   // resume does NOT re-publish what is already done
    }
  ]
}
```

### Field semantics

- **`stages[].workflow`** — a relative path within the store to an *existing* workflow that
  *already has a `.verify.json` + playbook*. The pipeline **composes**, it does not inline logic.
- **`with`** — maps pipeline state / prior-stage output into the child workflow's
  `variables`. Interpolates `{{PIPELINE.x}}`, `{{<captureAs>.path}}`. This is the missing
  **inter-workflow state bridge**.
- **`verify`** — two forms: (a) a path to a `*.verify.json` → grade the run's `summary.json`
  with `gradeSummary` (signals); (b) inline `{ type:"artifact", path, exists }` for a light
  check against that child workflow's `FINAL_REPORT`, e.g. `path: "$.filePath"`. Verdict != green → apply `onStageFail`. **Verify-as-gate.**
- **`captureAs`** — store the stage's `FINAL_REPORT` into pipeline state for later stages.
- **`risk`** — `read-only | generate | outward-facing | destructive`. Drives the risk-tier
  policy (§6). `outward-facing` is always gated regardless of settings.
- **`gate: "human"`** — the pipeline stops before the stage, writes a pending-approval, exits.
- **`idempotencyKey`** — key so resume/scanner never re-executes an already-done action.

---

## 6. Risk-tier execution model

The runner **enforces** this policy regardless of pipeline settings — protect the
**account (the real asset)** over the workflow:

| tier | auto-run | auto-heal (Tier 3) | gate | rate-limit |
|---|---|---|---|---|
| `read-only` | yes | yes (freely) | none | generous |
| `generate` | yes | limited (verify = produced + correct format) | none | credit-aware |
| `outward-facing` | up to the gate | **never** | **human approval** | strict + backup account |
| `destructive` | never | never | human | — |

---

## 7. Run lifecycle & commands

```
webmcp-workflow pipeline run <manifest> [--profile <id>]
webmcp-workflow pipeline resume <runId>
webmcp-workflow pipeline approve <runId>        # flip pending status → approved
webmcp-workflow pipeline status [<runId>]
webmcp-workflow pipeline scan                   # scan pending, resume approved ones
```

### `run`
```
for stage in stages:
  hydrate stage.with from pipeline state (+ PIPELINE.variables)
  if stage.risk == outward-facing and stage.gate == human and not-yet-approved:
      write pending/<runId>@<stage>.json { checkpointRef, artifacts, idempotencyKey, status:"awaiting-approval" }
      write checkpoint, EXIT (0)          # stop-before-publish
  run the workflow via the existing runner  →  summary.json
  if stage.verify:
      verdict = gradeSummary(verify, summary)
      if verdict != green:  apply onStageFail (stop | skip | alert)
  state[stage.captureAs] = summary.context.outputs.FINAL_REPORT
  write checkpoint (state + stageIndex + status) after EACH stage
write pipeline-summary.json
```

### Checkpoint & resume
- Checkpoint = `{ runId, manifestRef, manifestHash, storeGitSha, stageAnchors, completedStages, state, status }`
  written to `<checkpointDir>/<runId>/checkpoint.json` after each stage.
- `resume <runId>` = load the checkpoint → continue from the next `stageIndex` (prior-stage
  state intact → **do not re-run expensive / already-done outward-facing stages**).
- `manifestHash` + `storeGitSha` anchor the checkpoint; if the manifest changed mid-run → warn.

### Human gate: pending-file + scanner (option 1 — no server required)
```
Outward-facing stage hits the gate
  └─ pending/<runId>@<stage>.json { status:"awaiting-approval", artifacts, checkpointRef, idempotencyKey }
  └─ pipeline STOPS, exits.

You approve: set status → "approved"  (or `pipeline approve <runId>`)

Scanner (`pipeline scan`, runs on a schedule — reuses the doctor-cron scheduler)
  ├─ status "approved" → resume from that stage → execute (publish) → status "done"
  ├─ status "awaiting" → skip
  └─ status "rejected" → archive, do not publish.
idempotencyKey ensures repeated scans do NOT re-publish an already-done action.
```

**Option 2 (future):** approve via Telegram/Zalo. The architecture leaves room — just
replace "you set status" with "the bot pushes a callback that sets status", same pending
file, same scanner. Requires a webhook to receive callbacks or long-polling to keep a
server alive → deferred as a **future improvement**, not in the first phase.

---

## 8. Why this = more stability

- **Verify-as-gate** → a stage-A failure does not cascade into a stage-D disaster.
- **Pipeline-level checkpoint/resume** → a 2am failure does not re-burn credits / re-post
  (prevents duplicate side effects).
- **Composing already-verified workflows** → each stage is an independently self-healing
  unit → the pipeline *inherits the immune system* instead of rotting as a monolith.
- **Human gate + idempotencyKey** → the account never auto-acts before approval; retry/resume
  never doubles an outward-facing action.

---

## 9. Implementation plan (phased)

| Phase | Work | Notes |
|---|---|---|
| **P0 ✅** | `gradeSummary` (+ signals helpers) as a side-effect-free grader at `src/grade/grade-summary.js`. store-doctor still has its own copy for now (later imports this). | Done |
| **P1 ✅** | `pipeline run`: `src/pipeline/pipeline-runner.js` reads the manifest, runs stages via the existing runner, `with`-hydrates + `captureAs` state, checkpoints after each stage. | Done |
| **P2 ✅** | Verify-gate: `gradeStage` grades a stage's `summary` against `*.verify.json` (signals) or an inline `{type:"artifact", path, exists}`; non-green → `onStageFail`. | Done |
| **P3 ✅** | Human gate + pending-file + `resume`/`approve`/`reject`/`scan`/`status` + idempotency (`done.json`). Verified: outward-facing stage pauses, approve→scan resumes, re-scan is idempotent. | Done. Wiring `scan` into doctor-cron is still pending. |
| **P4 ✅** | Migrate the `gemini-to-suno` monolith → a 2-stage pipeline (gemini-workflow → suno-workflow), splitting the blobs into child workflows with `.verify.json`. | Reference pipeline lives in the store. |
| **P4b ✅** | Write the `webmcp-pipeline-creator` skill (§4.4) at `webmcp-workflow-cli/skills/webmcp-pipeline-creator/`; wire it into the skill installer alongside `webmcp-workflow-creator`. | Done; hardening pass added package/Cursor coverage. |
| **P5 (future)** | Approve via Telegram/Zalo (webhook/long-poll); notify on failure; wire `scan` into doctor-cron; merge the rest of store-doctor into the runner. | — |

**Start:** P0 + P1 to prove the chain + checkpoint run, then P2/P3 add the gates.

---

## 10. Open questions

1. `with` interpolation: support only `{{VAR.path}}` (like the current runner) or expressions
   (map/filter)? Recommendation: keep path-only in P1, add later if needed.
2. Verify for `generate` stages (creative content): stop at "artifact exists + correct
   format"? Content quality has no semantic contract — accept shallow verify for this branch.
3. Parallel stages (DAG) or sequential only? Recommendation: sequential for P1–P4; DAG is future.
4. Does `scan` run inside doctor-cron (one scheduler) or a separate process? Recommendation:
   reuse doctor-cron — add a "scan pending pipelines" step to the existing pipeline.
```

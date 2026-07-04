# Batch Command — Workflow CLI Integration Plan

> **Date:** 2026-07-04
> **Status:** Proposal (reviewed against runner source, not theoretical)
> **Depends on:** `webmcp-browser-kit/docs/extension/20260704_implementation_plan_batch_command.md` — the gateway/extension `batch` primitive. This plan assumes that lands first (or in tandem).
> **Affects:** `src/runner/catalog/command-catalog.js` (required), `src/runner/core/workflow-runner.js` (active-tab tracking), `src/runner/pipeline/workflow-normalizer.js` (timeout scaling — recommended), `src/runner/pipeline/workflow-validator.js` (deep validation — optional), skill `skills/webmcp-workflow-creator/SKILL.md`, `.examples/workflows/gemini/`.

---

## Goal

The gateway is gaining a `batch` primitive: run several gateway commands in **one HTTP round-trip**, handled inside the extension. The workflow runner **already sequences steps**, so `batch` is **not** a replacement for the step loop. Its value inside a workflow is narrow but real:

> Collapse a **tightly-coupled, deterministic micro-sequence** (e.g. `typeByRef → clickByRef → delay → getPageText`) into **one** gateway round-trip — cutting HTTP overhead, latency, and event-log noise — while the batch as a whole still gets step-level `guard`/`retry`/`captureAs`.

This plan makes `batch` a first-class runner command, wires up the pieces that would otherwise break (active-tab tracking, timeout), and documents the **honest trade-off**: per-action `guard`/`retry`/`captureAs`/routing are **not** available inside a batch — use real steps when you need those.

---

## Verified findings (what the runner does today)

Read before writing. Everything below is confirmed in source.

| Area | Behaviour today | Impact on `batch` |
|---|---|---|
| **Runner has its own catalog** (`src/runner/catalog/command-catalog.js`) — a *duplicate* of the gateway's | `validateWorkflow` → `validateCommandUsage` → `hasCommand()` rejects any `step.command` not in it | **Must add `batch`** or every batch step fails validation (unless `--allow-unknown-command`). §Change 1 |
| **Generic passthrough** (`workflow-runner.js:842-849`) | Any non-strategy, non-`wait`/`delay` command → `sendGatewayCommand(step.command, params, step.timeoutMs)` | `command:"batch"` already flows to the gateway **once the catalog accepts it** — no dispatch change needed |
| **Active-tab injection** (`sendGatewayCommand`, `COMMANDS_WITHOUT_ACTIVE_TAB`) | Injects `activeTabId` into `params.tabId` for commands **not** in the exempt set | `batch` stays OUT of the set → runner injects a **batch-level default `tabId`**, which the extension handler applies to every sub-action (matches extension-plan D3). ✅ Desirable — keep as-is. §Change 5 |
| **Active-tab *update*** (`updateActiveTab`, `workflow-runner.js:1088`) | Reads `result.tabId` and updates `activeTabId` | Batch envelope is `{total,executed,success,errors,results}` — **no top-level `tabId`** → active tab is **not** updated after a batch that navigated/opened a tab → later steps target the wrong tab. **GAP.** §Change 2 |
| **captureAs extraction** (`extractCaptureValue`, `workflow-runner.js:170`) | `parseWebMcpPayload` (looks for `result.result.content`) → `result.result` → raw | Batch has neither `.content` nor `.result` (it has `.results`), so `captureAs` stores the **whole envelope**. Works, but ergonomics are poor. §captureAs |
| **Dot-path resolution** (`getPathValue`, `workflow-context.js:81`) | Splits on `.`, traverses; string keys index arrays (`arr['4'] === arr[4]`) | `{{BATCH.results.4.result.text}}` **resolves** — numeric array index via dot-path works. ✅ |
| **Interpolation recursion** (`interpolate`, `workflow-context.js:311-321`) | Recurses arrays + plain objects | `{{VAR}}` inside `actions[].params` **is** interpolated; `validateTemplateRefs` also scans them. ✅ No change needed |
| **Timeout** (`normalizeStep` → `step.timeoutMs`, default `settings.defaultTimeout` = 30000) | `sendGatewayCommand(cmd, params, step.timeoutMs)`; transport arms a timer only if `timeoutMs>0` | A multi-action batch may exceed 30s. §Change 3 (scale) — the gateway also now grants a proportional timeout |

**Net:** the runner will run a `batch` step almost for free once the catalog accepts it. The one real correctness bug is **active-tab tracking (Change 2)**; the rest are ergonomics/robustness.

---

## Proposed Changes

### Change 1 — Register `batch` in the runner catalog **[REQUIRED]**

#### [MODIFY] `src/runner/catalog/command-catalog.js`

Mirror the gateway catalog exactly (the two catalogs are duplicated today).

```diff
 const COMMAND_GROUPS = [
   { id: 'tabs', label: 'Tab management' },
   { id: 'page', label: 'Page interaction' },
+  { id: 'orchestration', label: 'Multi-action orchestration' },
   { id: 'cdp', label: 'Chrome DevTools Protocol' },
   ...
   { id: 'runner', label: 'Runner pseudo commands' },
 ];
```

```diff
 const COMMAND_DEFINITIONS = [
   ...
+  /* ── Multi-action orchestration ──────────────────────── */
+  ['batch', {
+    group: 'orchestration',
+    description:
+      'Run several gateway commands sequentially in one round-trip (handled ' +
+      'inside the extension). params.actions is [{ method, params }]. Threads ' +
+      'tabId across actions; onError "continue" (default) or "stop-on-error"; ' +
+      'screenshotAfter captures after each action. NOTE: per-action guard/retry/' +
+      'captureAs are NOT available — use real steps when you need those.',
+    requiredParams: ['actions'],
+    optionalParams: ['onError', 'screenshotAfter', 'tabId', 'actionTimeoutMs'],
+  }],
   ...
 ];
```

**Consequences (all automatic once added):**
- `validateWorkflow` accepts `command:"batch"` and checks `actions` is present.
- `dry-run` / `list` show `batch` under the new *orchestration* group (`getCommandGroups`).
- Generic passthrough forwards the step to the gateway unchanged.

> ⚠️ **Catalog duplication.** This file duplicates `webmcp-browser-kit/catalog/command-catalog.js`. Both must be edited together. Deduplicating them into a shared module is worthwhile but out of scope here — see §Deferred.

> ⚠️ `hasParam(params,'actions')` treats a non-empty array as present, but an **empty** `actions: []` also passes required-param validation (it isn't `undefined`/`null`/`''`). The extension rejects empty batches at runtime; add Change 4 to catch it at validate-time.

---

### Change 2 — Track the active tab after a batch **[REQUIRED — correctness]**

Without this, a batch that navigates/opens a tab leaves the runner pointing at the old tab, so the next step targets the wrong tab.

#### [MODIFY] `src/runner/core/workflow-runner.js` — `updateActiveTab`

```diff
   updateActiveTab(result) {
-    if (!result || typeof result !== 'object' || result.tabId === undefined || result.tabId === null) return;
-    this.activeTabId = result.tabId;
-    this.context.setBuiltin('__ACTIVE_TAB_ID__', result.tabId);
+    if (!result || typeof result !== 'object') return;
+    let tabId = result.tabId;
+    // Batch envelope carries no top-level tabId; adopt the last tab any
+    // sub-action resolved so later steps target the right tab.
+    if ((tabId === undefined || tabId === null) && Array.isArray(result.results)) {
+      for (let i = result.results.length - 1; i >= 0; i--) {
+        const t = result.results[i]?.result?.tabId;
+        if (typeof t === 'number') { tabId = t; break; }
+      }
+    }
+    if (tabId === undefined || tabId === null) return;
+    this.activeTabId = tabId;
+    this.context.setBuiltin('__ACTIVE_TAB_ID__', tabId);
   }
```

> This is **self-contained** — it works whether or not the extension envelope adds its own `tabId`. If the extension plan also surfaces `tabId` at the envelope top level (a cheap addition on that side), the first branch handles it and the scan is skipped. Either way the runner is correct.

---

### Change 3 — Scale the default timeout for batch steps **[RECOMMENDED]**

A batch of N actions under the flat 30s default can time out. Scale it (mirrors the gateway's proportional timeout) **only when the author didn't set one explicitly**.

#### [MODIFY] `src/runner/pipeline/workflow-normalizer.js` — `normalizeStep`

```diff
 function normalizeStep(step, index, settings) {
+  let timeoutMs = Math.max(1, toNumber(step.timeoutMs, settings.defaultTimeout));
+  // Batch runs several commands under one step timeout — scale it by the
+  // action count when the author left timeoutMs unset (cap at 5 min).
+  if (step.timeoutMs === undefined && step.command === 'batch' && Array.isArray(step.params?.actions)) {
+    timeoutMs = Math.min(timeoutMs * step.params.actions.length, 300000);
+  }
   const normalized = {
     ...step,
     index,
     type: step.type || (step.forEach ? 'forEach' : 'command'),
     critical: step.critical !== false,
-    timeoutMs: Math.max(1, toNumber(step.timeoutMs, settings.defaultTimeout)),
+    timeoutMs,
     retryPolicy: normalizeRetryPolicy(step.retryPolicy, settings.defaultRetryPolicy),
   };
   ...
```

> Authors can still override with an explicit `timeoutMs`. The gateway independently grants `min(COMMAND_TIMEOUT_MS × actionCount, 300000)`, so the two layers agree.

---

### Change 4 — Deep-validate `batch.actions` **[OPTIONAL — high value]**

Today the validator only checks that `actions` exists. A typo in an inner `method`, a missing inner required param, or an empty `actions` array is caught only at runtime. Add a shallow deep-check reusing the existing catalog helpers.

#### [MODIFY] `src/runner/pipeline/workflow-validator.js`

In `validateCommandUsage`, after the existing checks, special-case batch:

```diff
   errors.push(...validateCommandParams(commandName, params || {}).map((message) => `${label}: ${message}`));
+
+  // Deep-validate batch sub-actions against the same catalog.
+  if (commandName === 'batch' && Array.isArray(params?.actions)) {
+    if (params.actions.length === 0) {
+      errors.push(`${label}: batch "actions" must be a non-empty array`);
+    }
+    params.actions.forEach((action, i) => {
+      const sub = `${label} action[${i}]`;
+      if (!isObject(action) || typeof action.method !== 'string') {
+        errors.push(`${sub}: each action needs a string "method"`);
+        return;
+      }
+      if (action.method === 'batch') {
+        errors.push(`${sub}: nested batch is not allowed`);
+        return;
+      }
+      if (action.method === 'delay' || action.method === 'wait') return; // pseudo
+      if (!hasCommand(action.method)) {
+        const msg = `${sub}: unknown command "${action.method}"`;
+        options.allowUnknownCommand ? warnings.push(`${msg}; passthrough enabled`) : errors.push(msg);
+        return;
+      }
+      errors.push(...validateCommandParams(action.method, action.params || {}).map((m) => `${sub}: ${m}`));
+    });
+  }
```

> Reuses `hasCommand` / `validateCommandParams` (already imported). `validateTemplateRefs` already scans `actions[].params` for `{{ }}` refs, so template validation needs no change. Empty-array and nested-batch are now caught before a run.

---

### Change 5 — Keep `batch` OUT of `COMMANDS_WITHOUT_ACTIVE_TAB` **[decision, non-change]**

`workflow-runner.js:44` lists commands that must NOT get `activeTabId` injected. **Do not add `batch`.** We *want* the runner to inject `activeTabId` into the batch's top-level `params.tabId` so it becomes the default tab for every sub-action (extension-plan D3). Documented here so a future edit doesn't "helpfully" exempt it.

---

## captureAs & interpolation ergonomics

`captureAs` on a batch step stores the **whole envelope**. Downstream reads use array-index dot-paths (supported):

```jsonc
{ "id": "chat", "command": "batch", "captureAs": "CHAT",
  "params": { "actions": [
    { "method": "typeByRef",  "params": { "ref": "r32", "text": "{{PROMPT}}" } },
    { "method": "clickByRef", "params": { "ref": "r37" } },
    { "method": "delay",      "params": { "ms": 4000 } },
    { "method": "getPageText","params": { "maxLength": 1200 } }
  ] } }
// later:  "{{CHAT.results.3.result.text}}"   ← 4th action's getPageText text
```

**Caveat — sub-results are not auto-unwrapped.** `parseWebMcpPayload` runs only on the *top-level* capture, so a `webmcp.invokeTool` **inside** a batch is stored raw as `results[N].result.result.content[0].text` (a JSON string). If you need that value cleanly downstream, prefer one of:
- Make the read a **real step** (`getPageText`/`evaluateJS`) after the batch, or
- Add a final `evaluateJS` merge step that parses `{{CHAT}}`, or
- (cross-package, optional) have the extension batch handler pre-normalize sub-results — see the extension plan's optional item.

Because of this friction, **batch is best for the *action* part of a micro-sequence** (type/click/wait), with the *value you actually consume* captured by a normal following step — unless a single trailing `getPageText`/`screenshot` inside the batch is all you need.

---

## When to use `batch` vs. real steps (author decision rule)

| Use **real steps** (not batch) when you need… | Use **batch** when… |
|---|---|
| per-action `guard` (skip/fail on precondition) | the sequence is deterministic with no per-action branching |
| per-action `retry`/`retryPolicy` | actions are tightly coupled (`type → click → wait → read`) |
| per-action `captureAs` feeding a later step | you want to cut N round-trips to 1 (latency / event noise) |
| `onSuccess`/`onFailure` routing, or `forEach` | the whole group can share one guard/retry/capture |

**Never:** nest `batch` inside `batch`, or put a `forEach` body inside a `batch` (and vice-versa). Batch is a flat, one-shot sequence.

---

## Skill updates

### [MODIFY] `skills/webmcp-workflow-creator/SKILL.md`

1. **§2 Step fields / command list** — add `batch` to the command enumeration and a row to the step-fields table pointing to the new section.
2. **New subsection "`batch`: collapse a micro-sequence"** — schema (`actions:[{method,params}]`, `onError`, `screenshotAfter`, `tabId`, `actionTimeoutMs`), the decision rule table above, the captureAs path (`{{VAR.results.N.result...}}`), and the hard limitation (no per-action guard/retry/capture; sub-results not auto-unwrapped).
3. **§9 Common pitfalls** — add rows:
   - "Used `batch` but needed a value from a middle action downstream" → sub-results aren't auto-unwrapped; capture with a following real step.
   - "Used `batch` but needed per-action retry/guard" → batch is all-or-nothing at step level; split into steps.
   - "Batch step times out" → set an explicit `timeoutMs` (or rely on action-count scaling); keep batches short.

### [NEW] `.examples/workflows/gemini/chat_batch.json` (+ `.playbook.md`)

Canonical demonstration and E2E acceptance artifact: open Gemini, then **one batch** doing `getAriaSnapshot → typeByRef → clickByRef → delay → getPageText`, capturing the reply. This is exactly the live scenario that motivated the primitive (the Gemini `type → send → read` test).

### `skills/webmcp-workflow-cli/SKILL.md` / `webmcp-pipeline-creator/SKILL.md`

No command surface is enumerated in these two — **no change required** beyond an optional one-liner in workflow-cli that batch validation is shallow unless deep-validation (Change 4) ships.

---

## Verification Plan

### validate / dry-run
```bash
# batch is a known command now
webmcp-workflow validate .examples/workflows/gemini/chat_batch.json
# shows under "Multi-action orchestration"
webmcp-workflow dry-run .examples/workflows/gemini/chat_batch.json --json | jq '.commands // .catalog'
# (with Change 4) unknown inner method / empty actions → validation error
```

### Unit tests (`tests/`)
- **updateActiveTab**: batch envelope with `results:[…,{result:{tabId:99}}]` → `activeTabId === 99`; envelope with a top-level `tabId` → that wins; envelope with no tab anywhere → unchanged.
- **normalizer**: `command:"batch"`, 5 actions, no `timeoutMs` → scaled (`5 × defaultTimeout`, capped 300000); explicit `timeoutMs` → untouched.
- **validator (Change 4)**: unknown inner method → error; empty `actions` → error; nested batch → error; valid actions → no error; `{{VAR}}` in `actions[].params` still template-validated.
- **capture/interpolate**: capture a fake batch envelope; `{{X.results.3.result.text}}` resolves via numeric index.

### E2E (mirrors the motivating test)
- Run `chat_batch.json` against a logged-in Gemini profile → `{{CHAT.results.<last>.result.text}}` contains Gemini's reply.
- A workflow whose batch does `newTab` then a **later step** reads the page → confirms the later step targets the batch-opened tab (Change 2).
- Latency: batch(5) vs. 5 separate steps — fewer gateway round-trips, lower wall-clock, fewer `step` events in the run log.

---

## Deferred / rejected

- **Auto-batching** (runner silently coalesces consecutive simple steps into a gateway batch): **rejected for now.** It would have to preserve per-step `captureAs`/`guard`/`retry`/routing semantics, which is exactly what batch gives up — the mapping is lossy and the complexity high. Authors opt in explicitly with a `batch` step instead.
- **Dedup the two command catalogs** (`webmcp-workflow-cli` ↔ `webmcp-browser-kit`) into one shared module: worthwhile (this plan adds a 2nd place to keep in sync) but a separate refactor with its own packaging concerns. Track separately.
- **Nested batch / batch-of-forEach / forEach-of-batch**: rejected — recursion and unclear guard/capture semantics. Batch stays flat and one-shot.
- **Per-action captureAs inside a batch**: rejected — that is precisely the boundary between "batch" (one round-trip, one capture) and "steps" (granular). Use steps when you need it.
```
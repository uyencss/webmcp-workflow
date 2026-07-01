# RFC: `type` Field + `forEach` Step (body-1-step) for Workflow JSON

> **Date**: 2026-07-01 (rev. 2)
> **Status**: Proposal
> **Scope**: `type` field + a single-body `forEach` loop step
> **Affects**: `workflow-normalizer.js`, `workflow-validator.js`, `workflow-runner.js`, `workflow-context.js`, `event-logger.js`, `executor.js`

> **What changed in rev. 2**
> - `forEach` body is now **one step** (the loop step carries its own `command`/`params`/`captureAs`), **not** a nested `steps: [...]` sub-workflow. This reuses the existing `executeStep` path (retry/guard/wait/capture come for free) and avoids the routing / nested-id / recursion landmines of a sub-workflow.
> - Added **§4 Loop math & timeout** — the real architectural constraint at large N.
> - Added **§7 Skill guidance** as a shipped deliverable (the loop feature is useless if the workflow generator still copy-pastes steps).
> - Nested multi-step body and `if`/`while`/`parallel` moved to **§9 Deferred / rejected** with honest trade-offs.
> - Corrected inflated figures (the original MobiFone file is **149 lines**, not "~500").

---

## 1. Problem

The MobiFone bidding tracker ([`theo_doi_dau_thau.json`](../.examples/workflows/mobifone/theo_doi_dau_thau.json), 149 lines) repeats the same 3 `evaluateJS` steps (search → filter → extract) once per keyword. 5 keywords = **15 near-identical steps**. Adding a keyword = paste 3 more; fixing extraction = edit 5 places.

This is real but bounded. Two facts shape the right fix:

1. **Workflow JSON is usually authored by an AI model** (see `skills/workflow-dispatcher-cli/`), so the fix that matters is not "less typing" but **not forcing the model to emit N copies of a body it must keep consistent**, and **keeping each unit of work inside one command timeout with its own retry/observability**.
2. **Every meaningful step is already `evaluateJS`** — arbitrary page-JS. The loop body is therefore almost always expressible as page-JS, which is exactly the case a single-body loop covers.

The workflow JSON needs a loop construct — the *smallest* one that covers the all-`evaluateJS` case cleanly.

---

## 2. Two changes

### 2.1 Add a `type` field to steps

Every step gets an explicit `type`:

```json
{ "id": "open",  "type": "command", "command": "newTab", "params": { "url": "..." } }
{ "id": "loop",  "type": "forEach", "forEach": { ... }, "command": "evaluateJS", "params": { "code": "..." } }
```

Today the runner infers step kind implicitly (`command` vs `strategy`). `type` makes it explicit.

**Backward compatibility**: a step with no `type` is normalized to `type: "command"`. All existing workflows run unchanged. This part is worth doing on its own — cheap, low-risk, forward-compatible.

### 2.2 Add `type: "forEach"` — a **single-body** loop

A `forEach` step is a normal command/strategy step **plus** a `forEach` block. The runner runs the step's own body once per item in `forEach.items`, with the current item bound to a scope variable. There is **no nested `steps` array**.

---

## 3. `forEach` schema (body-1-step)

```json
{
  "id": "search-each-keyword",
  "type": "forEach",
  "forEach": {
    "items": "{{KEYWORDS}}",
    "as": "keyword",
    "indexAs": "i",
    "collectAs": "ALL_RESULTS"
  },
  "command": "evaluateJS",
  "params": { "code": "... uses {{keyword}} ..." },
  "captureAs": "KW_RESULT",
  "timeoutMs": 90000,
  "retryPolicy": { "maxAttempts": 2, "backoffMs": 3000 }
}
```

The iteration body is the step's own `command` + `params` (or `strategy` + `instruction`). Per item, the runner executes that body through the **existing `executeStep`** path — so `guard`, `wait`, `retryPolicy`, `timeoutMs`, and `captureAs` all behave exactly as on a normal step, per iteration.

### `forEach` config

| Property | Type | Required | Description |
|---|---|---|---|
| `items` | `array \| string` | ✅ | Array to iterate. Literal `["a","b"]`, or a template `"{{VAR}}"` that resolves to an array at runtime. |
| `as` | `string` | ✅ | Scope-variable name for the current item. Referenced as `{{keyword}}` inside the body. |
| `indexAs` | `string` | ❌ | Scope-variable name for the 0-based index. Default `"__INDEX__"`. |
| `collectAs` | `string` | ❌ | If set (and the step has `captureAs`), each iteration's `captureAs` value is pushed into an array published under this name after the loop. |

### Item types

- **Strings** `["viễn thông","máy chủ"]` → `{{keyword}}` = `"viễn thông"`
- **Numbers** `[0,1,2]` → `{{page}}` = `0`
- **Objects** `[{ "kw":"viễn thông","size":50 }]` → `{{item.kw}}` (bind `as:"item"`, use dot-path)
- **Dynamic** `"items": "{{PAGE_LIST}}"` where `PAGE_LIST` was captured by an earlier step

### Capture modes

`captureAs` and `collectAs` are both optional:

| Mode | Config | Behavior | Use case |
|---|---|---|---|
| **Fire-and-forget** | neither | Loop only, keep nothing. | Repeated action: click like, delete, navigate. |
| **Overwrite** | `captureAs` only | Each iteration overwrites the var; only the **last** value survives. | Only the final state matters. |
| **Collect** | `captureAs` + `collectAs` | Each iteration's value is appended into an **array**. | Scraping / aggregation across items. |

> **Skill-author note:** for AI-generated workflows, **fire-and-forget** is the most common. Use `collectAs` only when a later step aggregates across iterations (merge / sort / dedupe).

---

## 4. Loop math & timeout (the real constraint)

A `forEach` iteration is executed as **one gateway command** and must finish inside the step's `timeoutMs` (default 30 000 ms). This dictates how to size the body:

- **Keep one iteration under ~30–40 s.** If the body is a paginated API fetch loop, bound pages per call (`MAX_PAGES`) rather than fetching everything in one shot.
- **Do not collapse a large N into one giant `evaluateJS`.** N keywords × pages in a single call risks a multi-minute command that blows the timeout and is all-or-nothing on failure.
- **Do not explode a large N into a runner-level loop of trivial steps** (e.g. one step per pagination click). That is thousands of gateway round-trips. In-page work belongs in page-JS.
- **The right unit of iteration is "one item = one command that fits the timeout."** For MobiFone that is *one keyword = one `evaluateJS`* that internally paginates the search API.

### Worked example (measured against the live site)

The muasamcong search UI is backed by a server-side-paginated XHR:

```
POST /o/egp-portal-contractor-selection-v2/services/smart/search?token=<recaptcha>
body: [{ "pageSize": 50, "pageNumber": "0", "query": [{ "index":"es-contractor-selection",
        "keyWord":"máy chủ", "matchType":"all-1", "matchFields":["notifyNo","bidName"],
        "filters":[ {"fieldName":"type","searchType":"in","fieldValues":["es-notify-contractor"]},
                    {"fieldName":"caseKHKQ","searchType":"not_in","fieldValues":["1"]} ] }] }]
```

- `pageNumber` is an **addressable cursor**; `pageSize` is server-capped at **50**.
- Response is clean JSON (`page.content[]`, `page.totalPages`, `page.last`, `page.totalElements`).
- `"máy chủ"` returns **2 094 results = 42 API pages**. A fresh reCAPTCHA token per call is minted from the page via `grecaptcha.execute(siteKey, {action})`.

So "click 1 000 pages per keyword" collapses to **~42 `fetch` calls (~12–15 s) inside one `evaluateJS`** — well within a 90 s `timeoutMs`. This is why the body-1-step loop is the right layer: **pagination stays in page-JS; the runner loops keywords, not pages.**

If a keyword ever exceeds the per-call page budget, resume is trivial because `pageNumber` is addressable — re-run the keyword with a start cursor. (Contrast with click-only pagination, which is not resumable and should be avoided by increasing page size or calling the API directly.)

---

## 5. MobiFone: before vs after

### Before — 149 lines, 3 steps duplicated per keyword

```
open → [search → click-tab → extract] × 5 keywords → process
```

Each `search`/`extract` is bespoke DOM scraping; each keyword shows only the first page of the "Chưa đóng thầu" tab.

### After — API + `forEach`, 3 steps total

Full file: [`theo_doi_dau_thau_v2.json`](../.examples/workflows/mobifone/theo_doi_dau_thau_v2.json).

```json
{
  "id": "mobifone-theo-doi-dau-thau-v2",
  "variables": {
    "TARGET_URL": "https://muasamcong.mpi.gov.vn/",
    "KEYWORDS": ["thiết bị viễn thông","hạ tầng mạng","thiết bị mạng",
                 "trung tâm dữ liệu","máy chủ","dịch vụ viễn thông"]
  },
  "steps": [
    { "id": "open-homepage", "type": "command", "command": "newTab",
      "params": { "url": "{{TARGET_URL}}" }, "wait": { "type": "delay", "ms": 6000 } },

    { "id": "search-each-keyword", "type": "forEach",
      "forEach": { "items": "{{KEYWORDS}}", "as": "keyword", "collectAs": "ALL_RESULTS" },
      "command": "evaluateJS", "captureAs": "KW_RESULT", "timeoutMs": 90000,
      "params": { "code": "/* mint reCAPTCHA token, loop pageNumber until page.last, map page.content, return { keyword, totalElements, items } */" } },

    { "id": "merge-and-sort", "type": "command", "command": "evaluateJS",
      "captureAs": "FINAL_REPORT",
      "params": { "code": "const groups = {{ALL_RESULTS}}; /* flatten, dedupe by notifyNoStand, sort by publicDate */" } }
  ]
}
```

- No DOM scraping, no tab switching, **all search results** (not just page 1 / not just "Chưa đóng thầu").
- Adding a keyword = add 1 string. Fixing extraction = edit 1 place.
- Each keyword is its own step: independent retry, its own timeout, its own event/history record, partial progress preserved across keywords.

---

## 6. Implementation

Because the body is a single step, this reuses `executeStep` and needs **no recursion** anywhere.

### 6.1 Normalizer (`workflow-normalizer.js`)

```javascript
function normalizeStep(step, index, settings) {
  const normalized = { ...step, index, /* ...existing critical/timeout/retry/wait... */ };
  if (!normalized.type) normalized.type = normalized.forEach ? 'forEach' : 'command';
  return normalized; // no nested steps array to recurse into
}
```

### 6.2 Validator (`workflow-validator.js`)

```javascript
if (step.type === 'forEach') {
  if (step.forEach?.items === undefined) errors.push(`${label}: forEach requires "items"`);
  if (typeof step.forEach?.as !== 'string' || !step.forEach.as)
    errors.push(`${label}: forEach requires "as" (string)`);
  if (step.forEach?.collectAs && !step.captureAs)
    errors.push(`${label}: forEach.collectAs needs the step to set "captureAs"`);
  // The body is this step's own command/strategy → validate it with the SAME
  // command/strategy path used for a normal step (unchanged logic).
}
```

The `as` / `indexAs` names are added to `knownVariables` before checking template refs on the step, so `{{keyword}}` inside the body resolves.

### 6.3 Context (`workflow-context.js`)

```javascript
pushScope(vars) {
  const snapshot = {};
  for (const k of Object.keys(vars)) snapshot[k] = this.variables[k];
  this._scopeStack.push(snapshot);
  Object.assign(this.variables, vars);
}
popScope() {
  const snap = this._scopeStack.pop(); if (!snap) return;
  for (const [k, prev] of Object.entries(snap))
    prev === undefined ? delete this.variables[k] : (this.variables[k] = prev);
}
```

Only loop variables are scoped. `captureAs`/`collectAs` publish through the normal `setCaptured` (intentionally visible after the loop).

### 6.4 Runner (`workflow-runner.js`)

Dispatch in `run()`:

```javascript
const record = step.type === 'forEach'
  ? await this.executeForEachStep(step, currentIndex, steps.length)
  : await this.executeStep(step, currentIndex, steps.length);
```

```javascript
async executeForEachStep(step, stepIndex, totalSteps) {
  const startedAt = Date.now();
  const cfg = this.context.interpolate(step.forEach);
  let items = typeof cfg.items === 'string' ? this.context.get(cfg.items) : cfg.items;
  if (!Array.isArray(items))
    throw new RunnerError('forEach.items must resolve to an array', { code: 'VALIDATION_ERROR' });

  this.emitRunnerEvent('step', { type: 'started', stepId: step.id, stepIndex, totalSteps,
    forEach: { totalIterations: items.length, as: cfg.as } });

  const collected = [];
  const body = { ...step }; delete body.forEach; // the per-item body is a plain step

  for (let i = 0; i < items.length; i++) {
    this.checkAborted();
    this.context.pushScope({ [cfg.as]: items[i], [cfg.indexAs || '__INDEX__']: i });
    try {
      const iterStep = { ...body, id: `${step.id}[${i}]` }; // suffix for events/logs only
      const rec = await this.executeStep(iterStep, stepIndex, totalSteps);
      this.state.results.push(rec);
      if (rec.status === 'failed' && step.critical !== false) { this.context.popScope(); return rec; }
      if (cfg.collectAs && step.captureAs) collected.push(this.context.get(step.captureAs));
    } finally {
      this.context.popScope();
    }
  }

  if (cfg.collectAs) this.context.setCaptured(cfg.collectAs, collected);

  const record = { status: 'success', stepId: step.id, duration: Date.now() - startedAt, iterations: items.length };
  this.context.setStepResult(step.id, record);
  this.emitRunnerEvent('step', { type: 'completed', stepId: step.id, stepIndex, totalSteps,
    duration: record.duration, forEach: { iterations: items.length } });
  return record;
}
```

Notes:
- The forEach step remains a single top-level step, so `onSuccess`/`onFailure` and `pickRouteIndex` keep working with **no change**. Routing into/out of a loop body is impossible by construction — which is the point.
- Iteration ids `stepId[i]` are for event/log/history display; `{{steps.<id>}}` still resolves to the forEach step's own result, and within the loop `{{keyword}}`/`captureAs` cover the needs.

### 6.5 Event logger (`event-logger.js`)

```
[1/3] open-homepage (command:newTab) completed in 6012ms
[2/3] search-each-keyword (forEach, 6 items) started
  [1/6] keyword="thiết bị viễn thông" → evaluateJS ok (14s, 12 pages, 573 items)
  [2/6] keyword="hạ tầng mạng"        → evaluateJS ok (9s, 6 pages, 288 items)
  ...
[2/3] search-each-keyword completed (6 iterations, 71s) — collected ALL_RESULTS
[3/3] merge-and-sort completed in 22ms — captured FINAL_REPORT
```

### 6.6 Executor (`executor.js`)

`buildDryRunReport()` / `buildUsedCommands()` treat a forEach step as its single body command annotated with `×N iterations`. No nested-tree walk needed.

---

## 7. Skill guidance (shipped with the feature)

The loop construct is worthless if the workflow generator keeps copy-pasting. `skills/workflow-dispatcher-cli/SKILL.md` must teach the decision explicitly:

1. **Prefer the API over the DOM.** Open DevTools → Network (or WebMCP `start_network_capture`), find the XHR/JSON endpoint behind the UI, and call it from `evaluateJS` with `fetch`. Raise `pageSize` and iterate the page cursor instead of clicking pages. This removes most loops entirely.
2. **All-`evaluateJS` body → body-1-step `forEach`.** One item = one `evaluateJS`; put waits/polling **inside** the JS (`await`), not as runner `wait` between sub-steps.
3. **Pagination stays in page-JS.** Loop the page cursor inside the item's `evaluateJS`, bounded by a `MAX_PAGES` budget and a `finished` flag. Never make one runner step per page.
4. **Respect the timeout.** If one item's body may exceed ~30–40 s, shrink the unit (smaller page budget, resume via cursor).
5. **Mixed gateway commands per item** (e.g. `navigate` + `screenshot`) can't live in one `evaluateJS` — for now, generate explicit repeated steps or wait for the deferred nested-body extension (§9).

---

## 8. Error handling

| Scenario | Behavior |
|---|---|
| Empty `items` `[]` | No-op. `collectAs` → `[]`. |
| Iteration body fails, step `critical: true` (default) | Stop the loop, bubble up as failure (partial `state.results` retained). |
| Iteration body fails, step `critical: false` | Record the failure, continue to the next item; that item contributes nothing to `collectAs`. |
| `items` does not resolve to an array | `VALIDATION_ERROR`. |
| `collectAs` set but no `captureAs` | Validation error (nothing to collect). |

Per-iteration `retryPolicy` applies inside `executeStep`, so a flaky item is retried before the loop decides to stop.

---

## 9. Deferred / rejected

### Nested multi-step body (`steps: [...]`) — deferred, not rejected

A body of several **different** gateway commands per item (`navigate` → `screenshot`, or `newTab` → `aria-ref click` → `evaluateJS`) genuinely needs a nested body, which body-1-step cannot express. It is deferred because it reintroduces real cost that must be solved before it ships:

- nested step ids must be collected/validated and de-duplicated;
- `onSuccess`/`onFailure` inside a body must be forbidden (no routing into/out of a loop) and validated;
- `{{steps.<id>}}` addressing of body steps must be defined;
- normalizer/validator/executor must recurse.

The single-body schema is a strict subset, so adding `steps: [...]` later is backward-compatible: a step has **either** an inline body **or** a `steps` array.

### `if` / `while` / `parallel` — rejected for now

- `while` (stop-condition loop) overlaps pagination, which we've shown belongs in page-JS; a runner-level `while` would still round-trip a condition check per iteration.
- `if` reintroduces a condition language that `evaluateJS` guards already cover.
- `parallel` conflicts with the runner's **single mutable `activeTabId`** — concurrent steps would race on the active tab and gateway. It is unsafe under the current one-tab model.

`evaluateJS` remains the escape hatch for genuinely complex per-item logic. Turning workflow JSON into a general control-flow language is explicitly a non-goal for a CLI dispatcher whose security model treats workflow JSON as executable input.

---

## 10. Files to modify

| File | Change |
|---|---|
| [`workflow-normalizer.js`](../src/runner/pipeline/workflow-normalizer.js) | Auto-detect `type` (`forEach` if `forEach` present, else `command`). |
| [`workflow-validator.js`](../src/runner/pipeline/workflow-validator.js) | `forEach` branch: validate `items`/`as`/`collectAs`↔`captureAs`; register `as`/`indexAs` as known vars; validate the body via the existing command/strategy path. |
| [`workflow-context.js`](../src/runner/pipeline/workflow-context.js) | Add `pushScope()` / `popScope()`. |
| [`workflow-runner.js`](../src/runner/core/workflow-runner.js) | Add `executeForEachStep()`; dispatch by `step.type` in `run()`. |
| [`event-logger.js`](../src/event-logger.js) | Render forEach iteration lines. |
| [`executor.js`](../src/executor.js) | Annotate a forEach step's single body command with iteration count in dry-run/used-commands. |
| `skills/workflow-dispatcher-cli/SKILL.md` | Add §7 decision guidance. |

### New files

| File | Purpose |
|---|---|
| `tests/fixtures/foreach-strings.json` | forEach over string items (collect mode). |
| `tests/fixtures/foreach-fire-and-forget.json` | forEach with no capture. |
| `tests/foreach.test.js` | Unit tests: scoping, collect/overwrite/fire-and-forget, empty items, critical vs non-critical failure, per-iteration retry. |
| [`.examples/workflows/mobifone/theo_doi_dau_thau_v2.json`](../.examples/workflows/mobifone/theo_doi_dau_thau_v2.json) | API + forEach rewrite (already added). |

---

## 11. Estimated effort

| Task | Hours |
|---|---|
| Context `pushScope`/`popScope` | 0.5h |
| Normalizer (`type` auto-detect) | 0.5h |
| Validator (`forEach` branch, no recursion) | 1h |
| Runner `executeForEachStep` (reuses `executeStep`) | 1.5–2h |
| Event logger | 1h |
| Executor dry-run annotation | 0.5h |
| Tests | 2h |
| Skill guidance (§7) | 0.5h |
| **Total** | **~7–8h** |

Lower than the nested design and with a far smaller permanent maintenance surface (no recursion in normalizer/validator/executor, no routing/id-scoping special cases).

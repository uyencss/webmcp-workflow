---
name: webmcp-workflow-creator
description: Author WebMCP workflow JSON that runs through `webmcp-workflow` (the webmcp-workflow-cli runner). Use when creating, designing, or debugging a workflow file — scraping, form-filling, multi-step browser automation, looping over keywords/pages/items, extracting structured data, or choosing between DOM interaction and calling a site's underlying API. Covers the `type`/`command`/`strategy`/`guard`/`wait`/`captureAs`/`forEach`/`batch` schema, template interpolation, the API-first + `forEach` + pagination decision rules, batching a micro-sequence into one round-trip, and fast reading with `getPageText`.
---

# WebMCP Workflow Creator

This skill teaches you to **write workflow JSON** for the WebMCP workflow runner
(`webmcp-workflow`). The sibling skill `webmcp-workflow-cli` covers *running*
files; this one covers *designing* them.

A workflow drives a real logged-in Chrome tab through the WebMCP gateway. Steps
run **sequentially**; each step is one gateway command (or one strategy, or a
`forEach` loop). Output of one step feeds later steps via `{{templates}}`.

> **Golden path:** design → write the **playbook** → `validate` → `dry-run` →
> `run` against one profile. Never ship a workflow you have not at least
> `dry-run`, and never ship one without a paired playbook (see §11).

---

## 0. Pair this with the `webmcp-browser-automation` skill

Authoring a good workflow is a **two-phase** job, and the two phases use
different tools:

1. **Discover / probe (live, interactive)** — use the **`webmcp-browser-automation`**
   skill's tools directly on a real tab to figure out *what to automate*:
   - `start_network_capture` → trigger the action → `get_captured_requests`
     (`include_bodies: true`) to find the **XHR/JSON API** (§1).
   - `evaluateJS` to test a `fetch`, confirm an async global is present
     (`window.grecaptcha`), inspect selectors, read the JSON shape.
   - `getAriaSnapshot` / `getPageText` to understand structure before you commit.
   Everything you plan to put in a step should be **verified live first**.
2. **Author (this skill)** — bake the *verified* logic into a repeatable
   workflow JSON that the runner replays via its own command set.

**Critical distinction — not every browser tool is a workflow step.** A workflow
step's `command` must be in the runner's command catalog: `newTab`, `navigate`,
`evaluateJS`, `getPageText`, `readPage`, `getAriaSnapshot`,
`clickByRef`/`typeByRef`/`hoverByRef`/`selectByRef`, `waitForSelector`,
`waitForStable`, `screenshot`, `scroll`, `pressKey`, etc. The **page-registered
tools** (`start_network_capture`, `wait_for_network_response`,
`query_selector_all`, `extract_table_data`, `fill_form_field`, …) are
**discovery-only** — they are invoked interactively via `webmcp.invokeTool` and
are **not** valid workflow step commands. In a workflow, reproduce their effect
with `evaluateJS`:

| Interactive (browser-automation skill) | In a workflow step |
|---|---|
| `start_network_capture` + `get_captured_requests` (find API) | `evaluateJS` → `fetch(endpoint)` (call the API you found) |
| `query_selector_all` (inspect DOM) | `evaluateJS` → `[...document.querySelectorAll(...)].map(...)` |
| `extract_table_data` | `evaluateJS` over the table rows |
| `fill_form_field` / `click_element` | `evaluateJS`, or `strategy: "aria-ref"` |

So: **probe with the browser-automation tools, ship with `evaluateJS` +
runner commands.**

---

## 1. The decision that matters most: DOM vs API

Most automation people write scrapes the **DOM** (click, read elements). That is
slow, brittle, and explodes into loops (pagination, tabs). **Before writing any
steps, look for the site's underlying API.**

**Decision order (top wins):**

1. **Call the site's own XHR/JSON API from `evaluateJS`.** Almost every modern
   SPA loads data via `fetch`/XHR that returns clean JSON with *server-side
   pagination*. Calling it directly removes DOM scraping, tab switching, and
   next-page clicking entirely. **This is the preferred approach.**
2. **All-`evaluateJS` DOM body → `forEach` (body-1-step).** If you must touch the
   DOM and the per-item body is expressible as page-JS, loop with `forEach`.
3. **Pagination stays inside page-JS**, bounded by a page budget (see §5).
4. **Mixed different gateway commands per item** (e.g. `navigate` + `screenshot`)
   → generate explicit repeated steps (nested loop bodies are not yet supported).

### How to find the API (do this first for any data-heavy site)

Using the WebMCP browser tools (see the `webmcp-browser-automation` skill):

1. `start_network_capture` with a broad substring (e.g. `"api"`, `"search"`).
2. Trigger the UI action (type + click search, load the list).
3. `get_captured_requests` (`include_bodies: true`) and find the `XHR`/`Fetch`
   request with `mimeType: "application/json"`. Read its URL, method, and
   `requestBody`.
4. Reproduce it from `evaluateJS` with `fetch`. Raise `pageSize`, iterate the
   page cursor.

### Worked reference: muasamcong.mpi.gov.vn

The bidding portal's search UI is backed by:

```
POST /o/egp-portal-contractor-selection-v2/services/smart/search?token=<recaptcha>
body: [{ "pageSize": 50, "pageNumber": "0",
         "query": [{ "index":"es-contractor-selection", "keyWord":"máy chủ",
           "matchType":"all-1", "matchFields":["notifyNo","bidName"],
           "filters":[ {"fieldName":"type","searchType":"in","fieldValues":["es-notify-contractor"]},
                       {"fieldName":"caseKHKQ","searchType":"not_in","fieldValues":["1"]} ] }] }]
```

- `pageNumber` is an addressable cursor; `pageSize` is server-capped at **50**.
- The endpoint needs a fresh reCAPTCHA v3 token per call — minted in-page with
  `grecaptcha.execute(siteKey, { action })`.
- One keyword ("máy chủ") = 2 094 results = 42 API pages, fetched in **one**
  `evaluateJS` in ~15 s. See the full file:
  [`theo_doi_dau_thau_v2.json`](../../.examples/workflows/mobifone/theo_doi_dau_thau_v2.json).

This is why "click 1 000 pages per keyword" is the **wrong** design — the same
result is ~42 `fetch` calls inside page-JS.

---

## 2. Workflow file anatomy

```jsonc
{
  "id": "my-workflow",               // required, unique
  "name": "Human name",              // required
  "version": "2.0",
  "description": "...",
  "settings": {
    "defaultTimeout": 60000,          // ms per command
    "defaultRetryPolicy": { "maxAttempts": 2, "backoffMs": 2000 },
    "continueOnNonCriticalFailure": true
  },
  "variables": { "TARGET_URL": "https://...", "KEYWORDS": ["a","b"] },
  "steps": [ /* ... */ ]
}
```

### Step fields

| Field | Meaning |
|---|---|
| `id` | Unique step id (referenced by routes and `{{steps.<id>}}`). |
| `type` | `"command"` (default) or `"forEach"`. Auto-detected if omitted. |
| `command` + `params` | A WebMCP command (`newTab`, `navigate`, `evaluateJS`, `getPageText`, `screenshot`, `waitForSelector`, `clickByRef`, `batch`, ...). |
| `command: "batch"` | Run several commands in ONE round-trip (§5A). No **per-action** guard/retry/capture. |
| `strategy` | `"ai-vision"` or `"aria-ref"` for semantic click/type without selectors. |
| `guard` | Precondition; skip (non-critical) or fail if unmet. Types: `element-exists`, `element-absent`, `url-matches`, `expression`. |
| `wait` | Post-step delay: `{ "type": "delay", "ms": 2000 }` (or a bare number). |
| `captureAs` | Store this step's result under a variable name. |
| `retryPolicy` | `{ maxAttempts, backoffMs, maxBackoffMs, retryOn: [codes] }`. |
| `critical` | Default `true`. If `false`, failure is non-fatal (run continues). |
| `timeoutMs` | Per-step timeout override. |
| `onSuccess` / `onFailure` | Jump to another step id (branching / recovery). |

---

## 3. Template interpolation `{{ }}`

- `"{{VAR}}"` **exact match** preserves the resolved **type** — `"{{KEYWORDS}}"`
  yields the actual array, `"{{count}}"` yields the number.
- `"prefix {{VAR}} suffix"` **inline** stringifies (objects/arrays → JSON).
- Namespaces: plain variables, `{{steps.<id>.result...}}`, `{{last.result}}`,
  `{{outputs.<name>}}`.
- Builtins: `{{__RUN_ID__}}`, `{{__DATE__}}`, `{{__TIMESTAMP__}}`,
  `{{__WORKFLOW_ID__}}`, `{{__ACTIVE_TAB_ID__}}`.
- Inside a `forEach` body, the loop var (`as`) and index (`indexAs`) are in scope.

**Gotchas**
- `"{{n}}"` where `n` is a number injects a *number* — `input.value = {{n}}`
  becomes `input.value = 3` (fine) but if you need a string wrap it:
  `"n={{n}}"` or `'"{{keyword}}"'`.
- `{{ }}` only matches **double** braces, so JS object literals (`{ ... }`) are
  safe. Avoid accidental `{{` in code (e.g. `map(x => ({{...}}))`).

---

## 4. `evaluateJS`: your main tool

Steps in real workflows are mostly `evaluateJS` — arbitrary page-JS. Rules:

- Code runs inside an async IIFE: `await` works.
- A **single expression** auto-returns. A **multi-statement body needs an
  explicit top-level `return`** — otherwise you get `undefined`.
- Return clean structured data (arrays of plain objects), not DOM nodes.

Reusable helpers (paste into the code string):

```js
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitFor = (pred, tries = 30, iv = 400) => new Promise((res, rej) => {
  let n = 0; const c = () => pred() ? res() : (++n >= tries ? rej(new Error('timeout')) : setTimeout(c, iv)); c();
});
// Wait for an async global (e.g. reCAPTCHA) to load:
const waitG = async () => { for (let i=0;i<40;i++){ if (window.grecaptcha && grecaptcha.execute) return; await sleep(250);} throw new Error('grecaptcha not loaded'); };
```

reCAPTCHA v3 token (when a call needs `?token=`):

```js
const getTok = () => new Promise((res, rej) =>
  grecaptcha.ready(() => grecaptcha.execute(SITE_KEY, { action: 'search' }).then(res).catch(rej)));
```

---

## 5. `forEach` (body-1-step)

A `forEach` step is a normal command step **plus** a `forEach` block. Its own
`command`/`params` are the loop body, run once per item. There is **no nested
`steps` array**.

```json
{
  "id": "search-each-keyword",
  "type": "forEach",
  "forEach": { "items": "{{KEYWORDS}}", "as": "keyword", "indexAs": "i", "collectAs": "ALL_RESULTS" },
  "command": "evaluateJS",
  "captureAs": "KW_RESULT",
  "timeoutMs": 90000,
  "params": { "code": "return (async () => { /* uses {{keyword}}; loop pages via API; return { keyword, items } */ })();" }
}
```

**`forEach` config**

| Prop | Req | Meaning |
|---|---|---|
| `items` | ✅ | Array literal or `"{{VAR}}"` resolving to an array. |
| `as` | ✅ | Scope var for the current item (`{{keyword}}`). |
| `indexAs` | ❌ | Scope var for the 0-based index (default `__INDEX__`). |
| `collectAs` | ❌ | Append each iteration's `captureAs` into an array under this name. Requires `captureAs`. |

**Capture modes:** fire-and-forget (no capture), overwrite (`captureAs` only,
keeps last), collect (`captureAs` + `collectAs`, builds an array).

**Error handling:** critical iteration failure stops the loop; `critical:false`
continues and only successful iterations feed `collectAs`. Per-iteration
`retryPolicy` still applies.

### Loop math & timeout (critical)

One iteration is **one gateway command** and must finish inside `timeoutMs`.

- Keep one iteration under ~30–40 s.
- **Pagination:** loop the page cursor **inside** the item's `evaluateJS`,
  bounded by `MAX_PAGES`; return a `finished` flag. Never make one runner step
  per page.
- If a keyword may exceed the page budget, resume via the addressable page
  cursor (re-run with a start page). Prefer raising `pageSize` / calling the API.
- **Do not** collapse a huge N into one giant `evaluateJS` (multi-minute call =
  timeout + all-or-nothing).
- **Do not** copy-paste N steps.

Pagination-in-JS skeleton:

```js
const items = []; let page = 0, meta = null;
do { meta = await fetchPage(page); items.push(...meta.content.map(map)); page++; }
while (!meta.last && page < MAX_PAGES);
return { key: kw, total: meta.totalElements, pagesFetched: page, finished: meta.last, items };
```

### Unknown iteration count — the "while" case (do NOT add a runner `while`)

When you don't know how many pages/items exist up front ("loop until there are
no more"), that is semantically a `while`. **The runner has no `while`, and you
don't need one.** Handle it two ways, together:

1. **Discover the bound, then feed `forEach` dynamically.** `forEach.items`
   accepts `"{{VAR}}"` that resolves **at runtime** from an earlier step's
   `captureAs`. So add a *discovery* step that reads the real bound (the
   last-page link, an API `totalPages`/`totalElements`, a result count),
   computes the item/chunk list, and captures it — then `forEach` iterates that
   computed list. **Never hardcode a page count.**
2. **Add a page-JS sentinel.** Inside the loop body, stop when a page comes back
   empty (`items.length === 0` / no "next"). Overshooting the discovered bound is
   then harmless, and slow growth between discovery and fetch self-corrects.

Why not a runner-level `while`: the bound is usually *discoverable* (fix it with
step 1), and "loop until empty" belongs in **page-JS** (fix it with step 2). A
runner `while` would only add a condition round-trip per iteration and duplicate
what JS already does. `parallel` is also rejected (the runner has a single
mutable active tab).

```json
{ "id": "discover", "type": "command", "command": "evaluateJS", "captureAs": "DISCOVERY",
  "params": { "code": "return (async () => { const r = await fetch('/list?page=1'); const doc = new DOMParser().parseFromString(await r.text(), 'text/html'); const nums = [...doc.querySelectorAll('a[href*=\"page=\"]')].map(a => { const m = (a.getAttribute('href')||'').match(/page=(\\d+)/); return m ? +m[1] : 0; }); const lastPage = Math.min(Math.max(1, ...nums), 2000); const CHUNK = 20, starts = []; for (let s = 1; s <= lastPage; s += CHUNK) starts.push(s); return { lastPage, chunkSize: CHUNK, chunkStarts: starts }; })();" } },
{ "id": "each-chunk", "type": "forEach",
  "forEach": { "items": "{{DISCOVERY.chunkStarts}}", "as": "startPage", "collectAs": "ALL" },
  "command": "evaluateJS", "captureAs": "CHUNK", "timeoutMs": 60000,
  "params": { "code": "return (async () => { const start = {{startPage}}, PAGES = {{DISCOVERY.chunkSize}}; const items = []; for (let p = start; p < start + PAGES; p++) { const r = await fetch('/list?page=' + p); const doc = new DOMParser().parseFromString(await r.text(), 'text/html'); const rows = doc.querySelectorAll('.item'); if (rows.length === 0) break; /* sentinel: past the end */ for (const el of rows) items.push(/* parse(el) */); } return { start, count: items.length, items }; })();" } }
```

> `forEach.items` may be a dot-path template (`"{{DISCOVERY.chunkStarts}}"`) —
> the validator accepts it as long as `DISCOVERY` is captured by an **earlier**
> step.

### Server-rendered sites (no JSON API)

If the list is server-rendered HTML paginated by `?page=N` (classic ASP.NET/PHP),
you still stay in page-JS: `fetch('/list?page=N')` returns **HTML**, so parse it
with `new DOMParser().parseFromString(html, 'text/html')` and query the parsed
document. This keeps pagination in one `evaluateJS` (no tab navigation per page).
Gotcha: some sites **shadow `window.URL`** — parse page numbers with a regex on
the `href` string, not `new URL(...)`. Full example:
[`thongtin_doanhnghiep_hue.json`](../../.examples/workflows/mobifone/thongtin_doanhnghiep_hue.json).

---

## 5A. `batch`: collapse a micro-sequence into one round-trip

A `batch` step runs several gateway commands **in one round-trip**, executed
inside the extension. Use it to fuse a tightly-coupled, deterministic
micro-sequence — `type → click → settle → read` — that has **no per-action
branching**. It cuts HTTP round-trips, latency, and run-log noise. The runner
already sequences steps, so batch is only worth it for these tight clusters, not
as a general replacement for steps.

```json
{
  "id": "type-and-send",
  "command": "batch",
  "params": {
    "onError": "stop-on-error",
    "actions": [
      { "method": "evaluateJS", "params": { "code": "/* insert {{PROMPT}} into the composer */ return { ok: true };" } },
      { "method": "delay", "params": { "ms": 500 } },
      { "method": "evaluateJS", "params": { "code": "/* click the send button */ return { ok: true };" } },
      { "method": "delay", "params": { "ms": 1000 } }
    ]
  }
}
```

**`params`**

| Prop | Meaning |
|---|---|
| `actions` ✅ | Ordered `[{ method, params }]`. `method` is any workflow command; `params` may use `{{templates}}`. |
| `onError` | `"continue"` (default, run all) or `"stop-on-error"` (halt on first failure; partial results still returned). |
| `screenshotAfter` | Screenshot after every action (default `false`; costly — leave off unless debugging). |
| `tabId` | Default tab for every action (the runner injects the active tab automatically). |
| `actionTimeoutMs` | Per-action timeout inside the extension (default 60000). One hung action fails on its own instead of stalling the whole batch. |

`delay`/`wait` are valid pseudo-actions inside `actions`
(`{ "method": "delay", "params": { "ms": 500 } }`).

**batch vs. real steps — the decision that matters:**

| If you need per-action `guard` / `retry` / `captureAs` / `onSuccess` / `forEach` | If it's a deterministic `type→click→wait→read` with no branching |
|---|---|
| Use **real steps** (one per action) | Use **batch** (one round-trip) |

The batch **as a whole** still gets step-level `guard`, `retry`, `captureAs`, and
routing — you just cannot attach them to *individual* actions.

**Reading a value back.** `captureAs` on a batch stores the whole envelope;
index into `results` (0-based):

```jsonc
"captureAs": "CHAT"
// later:  "{{CHAT.results.3.result.text}}"   // the 4th action's result
```

Sub-action results are **not** auto-unwrapped like a top-level capture, so a
page-tool / `webmcp.invokeTool` result inside a batch stays raw JSON text.
Rule of thumb: **batch the *action* part; capture the *value you consume* with a
normal following step** (a `getPageText`/`evaluateJS` after the batch). Runnable
example: [`.examples/workflows/gemini/chat_batch.json`](../../.examples/workflows/gemini/chat_batch.json).

**Never** nest a `batch` in a `batch`, or mix `forEach` with `batch`. `validate`
rejects an unknown inner `method`, a missing inner required param, and an empty
`actions` array.

---

## 6. Reading pages fast: prefer `getPageText`

When a step needs to **read text** (an article, a post, a profile, a
description) — not click — use **`getPageText`**, the same fast path Claude uses.
It returns clean readable text with nav/ads/boilerplate stripped, in far fewer
tokens than an ARIA snapshot.

**Tool-to-goal mapping (choose deliberately):**

| Goal | Use |
|---|---|
| Read / answer from a text page | **`getPageText`** (or `readPage` to navigate+read in one call) |
| Bulk structured data (rows, tables, lists, API JSON) | `evaluateJS` (fetch/`querySelectorAll`) |
| Understand structure to click/type on an SPA | `getAriaSnapshot` → `clickByRef`/`typeByRef` |
| Click/type without brittle selectors | `strategy: "aria-ref"` or `"ai-vision"` |

### Facebook specifically

Facebook's DOM is deeply nested, obfuscated, and hostile to CSS selectors, and an
ARIA snapshot of a feed is huge and noisy. **For reading posts/comments/profile
text on Facebook, use `getPageText` instead of `getAriaSnapshot`** — it is much
faster and cheaper and yields the actual post text. Reserve `getAriaSnapshot` +
`clickByRef` for the *interaction* you can't avoid (open a post, click "See
more", submit). For extracting many posts at once, `evaluateJS` over the feed
containers still beats a snapshot.

```json
{ "id": "read-page", "type": "command", "command": "getPageText",
  "params": {}, "captureAs": "PAGE_TEXT" }
```

---

## 7. Guards, waits, routing

- **Guard** to make a step conditional:
  `{ "type": "expression", "expression": "document.querySelector('.next') !== null" }`
  or `element-exists` / `url-matches`. Non-critical guarded steps are *skipped*
  when unmet; critical ones *fail*.
- **Wait** for SPA settle after an action that has no natural readiness signal.
  Prefer polling inside `evaluateJS` (`waitFor`) over fixed `wait` delays.
- **Routing:** `onSuccess`/`onFailure` jump to a step id (recovery flows). Keep
  the graph acyclic (the validator rejects `onSuccess` cycles).

---

## 8. Authoring checklist (make the skill work best)

1. **Hunt the API first** (§1). Prefer `fetch` over DOM. Raise `pageSize`.
2. **Right tool per goal** (§6): `getPageText` to read, `evaluateJS` for bulk
   data, `aria-ref` to interact. Facebook → `getPageText`.
3. **Size the loop unit** (§5): one item = one command that fits `timeoutMs`;
   pagination inside page-JS with `MAX_PAGES`.
4. **Unknown count?** (§5) Don't hardcode the bound and don't reach for a
   runner `while`: a discovery step reads the real bound → `forEach.items` via
   `{{VAR}}`, plus an empty-page sentinel in the body.
5. **Return clean data**: arrays of plain objects; dedupe (`Set` on a stable id)
   and sort in a final `merge` step.
6. **Interpolation types** (§3): exact `{{ }}` for arrays/numbers; wrap strings
   in quotes inside code.
7. **evaluateJS returns** (§4): explicit `return` in multi-statement bodies.
8. **Robustness**: wait for async globals (`waitG`); set per-step `timeoutMs`
   and `retryPolicy` on network-bound steps; make the target URL the page that
   actually loads what you need (e.g. the search page, not the homepage — some
   globals like `grecaptcha` load per-route).
9. **Verify before run**: `validate` → `dry-run --json` → `run --profile <id>`.
   When >1 Chrome profile is connected, `--profile` is required.
10. **Security**: workflow JSON is **executable input** — it runs arbitrary JS in
   a real logged-in browser. Only author/run files you trust; never embed
   secrets in `code` (history redaction is key-name based, not content-based).
11. **Ship a playbook** (§11): author the sibling `<name>.playbook.md` alongside
   the JSON and set the `playbook` field (or rely on convention naming). Capture
   the probe-phase knowledge that doesn't fit a step — API shapes, alternate
   paths, traps, hard identifiers, verification criteria.

---

## 9. Common pitfalls

| Symptom | Cause / fix |
|---|---|
| `Uncaught ... grecaptcha not loaded` | Global not present on that route. Open the page that loads it; add `waitG`. |
| Step returns only `{ tabId }` | Multi-statement `evaluateJS` without top-level `return`. |
| `forEach.items must resolve to an array` | `items` template resolved to a non-array. Check the source variable. |
| Loop var leaks / wrong value | Use the `as`/`indexAs` names; they are scoped per iteration only. |
| `template references unknown variable` | Reference a var/`captureAs`/`collectAs` that is defined *earlier* (order matters). |
| One giant `evaluateJS` times out | Split by item; paginate with `MAX_PAGES`; raise `timeoutMs`. |
| Selector breaks on SPA | Use `getAriaSnapshot` + `clickByRef`, or the site API. |
| Hardcoded page/item count misses new data as the site grows | Don't hardcode the bound. Add a discovery step that reads the real bound and feed `forEach.items` via `{{VAR}}`; add an empty-page sentinel (§5). |
| `URL is not a constructor` inside `evaluateJS` | The site shadows `window.URL`. Parse page numbers with a regex on the `href` string instead of `new URL(...)`. |
| Needed a value from a *middle* batch action downstream | Batch sub-results aren't auto-unwrapped. Capture the value with a real step after the batch, or read `{{VAR.results.<i>.result}}` and parse it. |
| Needed per-action retry/guard but used `batch` | Batch is all-or-nothing at the step level. Split the actions into real steps (§5A). |
| `batch "actions" must be a non-empty array` / `unknown command` in an action | `validate` deep-checks batch actions. Fix the inner `method`/params or remove the empty batch. |

---

## 10. Starter templates

**Scrape via API + forEach + merge** (the canonical shape):

```json
{
  "id": "scrape-via-api",
  "name": "Scrape via API",
  "variables": { "TARGET_URL": "https://site/search", "TERMS": ["a", "b"] },
  "steps": [
    { "id": "open", "type": "command", "command": "newTab",
      "params": { "url": "{{TARGET_URL}}" }, "wait": { "type": "delay", "ms": 6000 } },
    { "id": "each-term", "type": "forEach",
      "forEach": { "items": "{{TERMS}}", "as": "term", "collectAs": "ALL" },
      "command": "evaluateJS", "captureAs": "ONE", "timeoutMs": 90000,
      "params": { "code": "return (async () => { const t = '{{term}}'; /* fetch pages, map, return {term, items} */ })();" } },
    { "id": "merge", "type": "command", "command": "evaluateJS", "captureAs": "REPORT",
      "params": { "code": "const g = {{ALL}}; const all = g.flatMap(x => x.items); /* dedupe + sort */ return all;" } }
  ]
}
```

**Read text pages (e.g. Facebook)**:

```json
{
  "id": "read-posts",
  "name": "Read posts",
  "variables": { "URLS": ["https://facebook.com/...", "https://facebook.com/..."] },
  "steps": [
    { "id": "each-url", "type": "forEach",
      "forEach": { "items": "{{URLS}}", "as": "url", "collectAs": "TEXTS" },
      "command": "readPage", "captureAs": "TEXT",
      "params": { "url": "{{url}}" } }
  ]
}
```

See runnable examples under
[`.examples/workflows/`](../../.examples/workflows/) (facebook, gemini) and their
paired playbooks (`post_text.playbook.md`, `generate_image.playbook.md`).

---

## 11. Every workflow ships with a playbook

The JSON is the **fast, deterministic path** — but it goes static and brittle:
selectors drift, popups appear, module ids change. The **playbook** is the
recovery path: a sibling markdown file an AI agent reads (via
`webmcp-workflow handoff`) to finish the task live when the JSON fails, then
patch the JSON so the next run is deterministic again.

**Author the JSON and the playbook together.** During the probe phase you learn
things that don't fit a JSON step — the API shape, alternate selectors, the
"two similar targets" trap, why a wait is 6s, which id is the real target.
Today that knowledge is thrown away after you write the JSON. The playbook is
where it persists.

### File convention

Place `<workflow-basename>.playbook.md` next to the JSON, and either set the
`playbook` field (preferred — discoverable) or rely on the convention name:

```jsonc
{ "id": "my-workflow", "playbook": "./my_workflow.playbook.md", ... }
```

The runner never executes a playbook; it only reads it into the handoff package.
A workflow without a playbook still runs — but ship one anyway.

### What the playbook must contain

Start from [`playbook-template.md`](./playbook-template.md). Full spec:
[`docs/playbook-format.md`](../../docs/playbook-format.md). Mandatory sections:

- **Frontmatter**: `workflowId` (== JSON `id`), `workflowVersion`, `updated`,
  `risk` (`outward-facing` | `read-only`).
- **Goal** — what "done" looks like, phrased so an agent can *verify* it.
- **Preconditions** — login/profile/URL assumptions.
- **Step intents** — one line per JSON step **id**: intent + expected result +
  fallback hint.
- **Verification** — concrete, checkable success criteria (the agent must not
  claim success without them).

For `risk: outward-facing` workflows (sending, posting, submitting, paying) two
more sections are **mandatory**:

- **Hard identifiers** — values the agent must use verbatim and never guess
  (conversation ids, endpoints, recipient ids). The agent may change *how* it
  reaches the goal, never these *what* values. This is the guardrail against
  acting on the wrong target (e.g. two similarly-named chats).
- **Never do** — explicit prohibitions (don't send unconfirmed, don't retry a
  send more than once, don't touch any entity outside the hard identifiers).

### Rules

- No secrets in the playbook (same as JSON — redaction is key-name based).
- Reference real JSON step ids in Step intents so handoff aligns failures to
  intents.
- After any recovery, patch the JSON with what worked and bump the playbook's
  `updated`/`workflowVersion`.

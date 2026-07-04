# Activate Tab — Workflow CLI Catalog Sync Plan

Date: 2026-07-04

## Goal

Keep `webmcp-workflow-cli` in sync with the new `activateTab` command shipped in
`webmcp-browser-kit`, so workflow JSON can use `activateTab` as a step without
being rejected by the runner's validator.

Related upstream plan:
`webmcp-browser-kit/docs/extension/20260704_implementation_plan_activate_tab.md`
(that change consolidated the initial `activateTab`/`selectTab`/`focusTab` draft
down to a single `activateTab` command).

## Why this is needed

The runner validates every workflow step against
`src/runner/catalog/command-catalog.js`. A step whose `command` is not in the
catalog fails validation ("unknown command"). The extension now advertises
`activateTab`, but the workflow-cli catalog does not list it, so a workflow that
tries to bring an existing tab to the foreground cannot be authored.

## Command contract (mirrors browser-kit)

- Command: `activateTab`
- Group: `tabs`
- Params: `{ tabId }` — required. Author picks the `tabId` from a prior
  `listTabs` step. Marking it required matches the browser-kit catalog and
  gives a clear validation error when omitted.
- Behavior (extension side): focus the tab's window, then set the tab active.
- Result carries `tabId`, so the runner's `updateActiveTab` adopts it and later
  steps target the newly activated tab automatically.

## Scope Decision: catalog + skill only

- `src/runner/catalog/command-catalog.js` — **add** the `activateTab` entry.
  This is the validation gate and the essential sync point.
- `skills/webmcp-workflow-creator/SKILL.md` — add `activateTab` to the
  illustrative command list so authors know it exists.

### Explicitly NOT changed

- `COMMANDS_WITHOUT_ACTIVE_TAB` in `src/runner/core/workflow-runner.js` is left
  alone. Active-tab injection only fires when `resolvedParams.tabId === undefined`
  (workflow-runner.js:1066). Because `activateTab` marks `tabId` as required, a
  valid step always carries `tabId`, so injection can never override the target.
  Adding it to that set would be a speculative change with no behavioral effect.
- `README.md` only contains a single `getActiveTab` example snippet, not a
  command list, so it needs no change.

## Files To Change

1. `src/runner/catalog/command-catalog.js`
   - Under the "Tab management" group, add:
     `['activateTab', { group: 'tabs', description: '...', requiredParams: ['tabId'] }]`
2. `skills/webmcp-workflow-creator/SKILL.md`
   - Add `activateTab` to the catalog command list (line ~40).

## Verification

1. `npm test` (workflow-cli) → all suites pass; catalog change does not break
   `batch.test.js` / `cli-smoke.test.js`.
2. Author-check: a workflow step `{ "type": "command", "command": "activateTab",
   "params": { "tabId": 123 } }` validates (no "unknown command"); omitting
   `tabId` reports a missing-required-param error.
3. Grep: `activateTab` present in catalog + skill; no stray `selectTab` /
   `focusTab` anywhere in the package.

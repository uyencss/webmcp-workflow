# Reorganize Runner Code with Documentation & Section Separation

> Follow-up: after the CLI package was implemented, this reorganized runner tree
> was moved under `src/runner/` so all runtime code lives inside `src/`.
> The structure below describes the logical runner layout; prepend `src/` for
> current paths.

The `runner/` directory contains 9 flat files (927-line `workflow-runner.js`, 460-line `run.js`, 331-line `workflow-validator.js`, etc.) with zero JSDoc comments, zero section banners, and no structural grouping. The goal is to **add documentation and reorganize without changing any code logic**.

## Proposed Changes

### 1. Restructure into subdirectories

Move the 9 flat files into logical subdirectories that group by concern:

```
runner/
├── index.js                        [NEW]  — Public re-export barrel
├── run.js                          [KEEP] — CLI entrypoint (stays at root)
│
├── core/                           [NEW]  — Core execution engine
│   ├── workflow-runner.js          [MOVE] — Main runner class
│   ├── runner-events.js            [MOVE] — Event factory
│   └── transport.js                [MOVE] — Gateway HTTP transport
│
├── strategies/                     [NEW]  — Step execution strategies
│   ├── ai-vision.js                [NEW]  — Extracted from workflow-runner.js
│   └── aria-ref.js                 [NEW]  — Extracted from workflow-runner.js
│
├── pipeline/                       [NEW]  — Workflow processing pipeline
│   ├── workflow-normalizer.js      [MOVE] — Step/settings normalization
│   ├── workflow-validator.js       [MOVE] — Pre-run validation
│   └── workflow-context.js         [MOVE] — Variable interpolation & state
│
├── catalog/                        [NEW]  — Command registry
│   └── command-catalog.js          [MOVE] — Command definitions & lookup
│
└── shared/                         [NEW]  — Shared utilities
    └── errors.js                   [MOVE] — Error types & helpers
```

> [!IMPORTANT]
> **"No code logic changes"** means: every function body stays byte-identical. What changes are:
> 1. `require()` paths are updated to reflect new file locations.
> 2. JSDoc comments and section banners are added above every function/class/constant.
> 3. Module-level docblock headers are added to every file.
> 4. Two strategy methods (`executeAiVisionStep`, `executeAriaRefStep`) plus their helper functions are **moved** into separate files under `strategies/`, then imported back into `workflow-runner.js`. The function bodies don't change.

---

### 2. Add file-level documentation headers

Every `.js` file gets a module-level docblock. Example for `workflow-runner.js`:

```js
/**
 * @module core/workflow-runner
 * @description Orchestrates workflow execution: validates, iterates steps,
 *   delegates to strategies, manages retries/guards/routing, and emits events.
 *
 * Entry point: `WorkflowRunner.run()` or the convenience `runWorkflow()`.
 */
```

---

### 3. Add JSDoc to all exported functions, classes, and constants

Every exported symbol gets a `@param` / `@returns` / `@throws` JSDoc block. Internal helpers get a concise one-liner. Example:

```js
/**
 * Score an interactive element against a natural-language instruction.
 * Higher score = better match. Used by the ai-vision strategy.
 *
 * @param {Object} element  - Interactive element from getInteractiveElements.
 * @param {string} instruction - The user's natural-language instruction.
 * @param {string[]} tokens  - Pre-tokenized keywords from the instruction.
 * @returns {number} Match score (0 = no match).
 */
function scoreInteractiveElement(element, instruction, tokens) { ... }
```

---

### 4. Add section banners inside larger files

For files that remain large (workflow-runner, workflow-validator, run.js), add comment banners:

```js
/* ═══════════════════════════════════════════════════════════
 *  SECTION: Retry & Backoff
 * ═══════════════════════════════════════════════════════════ */
```

Proposed sections for `workflow-runner.js` (after strategy extraction):
- **Constants** — `COMMANDS_WITHOUT_ACTIVE_TAB`, `AI_STOPWORDS`, `ARIA_ACTION_COMMANDS`
- **Run ID & Builtins** — `generateRunId`, `makeBuiltins`
- **Timing & Retry** — `sleep`, `calculateBackoff`, `shouldRetry`
- **Result Extraction** — `extractCaptureValue`, `parseWebMcpPayload`
- **Routing** — `pickRouteIndex`
- **Guard Evaluation** — `targetPresenceExpression`
- **WorkflowRunner Class** — constructor, `validate`, `abort`, `getState`, `run`, step execution, gateway communication

Proposed sections for `workflow-validator.js`:
- **Constants** — Supported strategies, guards, builtins
- **Helpers** — `isObject`, `hasTemplate`, `routeTargets`
- **Sub-validators** — command, retry, wait, guard, template refs
- **Cycle Detection** — `detectOnSuccessCycles`
- **Main Entry** — `validateWorkflow`

---

### 5. Extract strategy methods into `strategies/`

#### [NEW] [ai-vision.js](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/workflow-dispatcher/runner/strategies/ai-vision.js)
Contains (moved from `workflow-runner.js`, bodies unchanged):
- `keywordTokens(instruction)` — NLP tokenizer
- `scoreInteractiveElement(element, instruction, tokens)` — Element scoring
- `executeAiVisionStep(step, context, sendCommand, timeoutMs)` — Strategy entry point

#### [NEW] [aria-ref.js](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/workflow-dispatcher/runner/strategies/aria-ref.js)
Contains (moved from `workflow-runner.js`, bodies unchanged):
- `ARIA_ACTION_COMMANDS` — Action → command mapping constant
- `parseAriaSnapshot(snapshot)` — Snapshot parser
- `scoreAriaEntry(entry, instruction, tokens)` — Ref scoring
- `buildAriaActionParams(command, params)` — Param builder
- `executeAriaRefStep(step, context, sendCommand, timeoutMs)` — Strategy entry point

#### [MODIFY] [workflow-runner.js](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/workflow-dispatcher/runner/core/workflow-runner.js)
- Remove the extracted functions
- Add `require('../strategies/ai-vision')` and `require('../strategies/aria-ref')`
- The `executeStepAttempt` method calls the imported strategy functions instead of `this.executeAiVisionStep` / `this.executeAriaRefStep`

---

### 6. Add `index.js` barrel export

#### [NEW] [index.js](file:///Users/ttcenter/Desktop/VIBE_CODE/webmcp-automation-kit/workflow-dispatcher/runner/index.js)

```js
/**
 * @module runner
 * @description Public API for the WebMCP workflow runner.
 * Re-exports the core runner, transport, context, catalog, and errors.
 */
module.exports = {
  ...require('./core/workflow-runner'),
  ...require('./core/transport'),
  ...require('./pipeline/workflow-context'),
  ...require('./pipeline/workflow-normalizer'),
  ...require('./pipeline/workflow-validator'),
  ...require('./catalog/command-catalog'),
  ...require('./shared/errors'),
  ...require('./core/runner-events'),
};
```

---

## Summary of file moves

| Current path | New path | Subdirectory |
|---|---|---|
| `errors.js` | `shared/errors.js` | shared |
| `runner-events.js` | `core/runner-events.js` | core |
| `transport.js` | `core/transport.js` | core |
| `workflow-runner.js` | `core/workflow-runner.js` | core |
| `workflow-context.js` | `pipeline/workflow-context.js` | pipeline |
| `workflow-normalizer.js` | `pipeline/workflow-normalizer.js` | pipeline |
| `workflow-validator.js` | `pipeline/workflow-validator.js` | pipeline |
| `command-catalog.js` | `catalog/command-catalog.js` | catalog |
| `run.js` | `run.js` (stays) | root |

---

## User Review Required

> [!IMPORTANT]
> **Strategy extraction trade-off**: Extracting `executeAiVisionStep` and `executeAriaRefStep` into separate files requires them to accept explicit parameters (context, sendCommand) instead of using `this`. The function bodies stay identical, but their signatures change from methods to standalone functions. This is the minimal code change needed to make the split work. If you prefer to keep them as methods inside the class and only add comments/banners without splitting, let me know.

> [!IMPORTANT]
> **Barrel `index.js`**: If the runner is currently consumed by `require('./runner/workflow-runner')` paths (it is — only from `run.js`), adding `index.js` is purely additive and won't break anything. But it does set a convention. Let me know if you want it.

## Open Questions

1. **Strategy extraction**: Should I extract the two strategies into separate files (involves changing method signatures to standalone functions), or just add section banners + JSDoc inside `workflow-runner.js` without splitting?
2. **Naming preference**: Do you prefer the subdirectory names as proposed (`core/`, `strategies/`, `pipeline/`, `catalog/`, `shared/`), or would you like different groupings?
3. **`index.js` barrel**: Include it, or skip?

## Verification Plan

### Automated Tests
- No existing tests to break. After reorganization:
  ```bash
  node runner/run.js workflows/gemini/chat.json --dry-run
  ```
  Should produce identical dry-run output as before.

### Manual Verification
- Diff every moved function body against the original to confirm zero logic changes.
- Verify all `require()` paths resolve correctly by running the CLI.

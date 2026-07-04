/**
 * @module catalog/command-catalog
 * @description Registry of all WebMCP gateway commands with their metadata.
 *
 * The catalog serves two purposes:
 * 1. **Validation** — the workflow validator checks that every step references
 *    a known command and provides all required params.
 * 2. **Documentation** — the `description` field and command groups power the
 *    dry-run report and the `--help` output.
 *
 * Commands are organised into groups that map to functional areas of the
 * WebMCP Chrome extension (tab management, page interaction, ARIA snapshots,
 * CDP low-level access, etc.).
 */

/* ═══════════════════════════════════════════════════════════
 *  Command groups
 * ═══════════════════════════════════════════════════════════ */

/**
 * Ordered list of command groups.  Each group has a human-readable label
 * used in CLI output and documentation.
 *
 * @type {Array<{ id: string, label: string }>}
 */
const COMMAND_GROUPS = [
  { id: 'tabs', label: 'Tab management' },
  { id: 'page', label: 'Page interaction' },
  { id: 'orchestration', label: 'Multi-action orchestration' },
  { id: 'cdp', label: 'Chrome DevTools Protocol' },
  { id: 'webmcp', label: 'Page WebMCP tools' },
  { id: 'vision', label: 'AI observation' },
  { id: 'observability', label: 'Runtime observability' },
  { id: 'aria', label: 'ARIA snapshot interaction' },
  { id: 'input', label: 'CDP input' },
  { id: 'control', label: 'Full browser control' },
  { id: 'runner', label: 'Runner pseudo commands' },
];

/* ═══════════════════════════════════════════════════════════
 *  Command definitions
 *
 *  Each entry is a tuple: [commandName, metadata].
 *  Metadata fields:
 *    group          — the command group id (see COMMAND_GROUPS)
 *    requiredParams — params that must be present (validation error if missing)
 *    optionalParams — params that are accepted but not required
 *    description    — human-readable documentation for dry-run / help output
 * ═══════════════════════════════════════════════════════════ */

/**
 * @type {Array<[string, { group: string, requiredParams?: string[], optionalParams?: string[], description?: string }]>}
 */
const COMMAND_DEFINITIONS = [
  /* ── Tab management ──────────────────────────────────── */
  ['listTabs', { group: 'tabs' }],
  ['navigate', { group: 'tabs', requiredParams: ['url'] }],
  ['newTab', { group: 'tabs', optionalParams: ['url'] }],
  ['closeTab', { group: 'tabs', optionalParams: ['tabId'] }],
  ['getActiveTab', { group: 'tabs' }],
  ['listFrames', { group: 'page', description: 'List the frame tree for a tab, returning CDP frame IDs, Chrome frame IDs when available, URLs, names, and parent relationships. Use this before targeting iframe commands.', optionalParams: ['flat', 'force'] }],

  /* ── Page interaction ────────────────────────────────── */
  ['click', { group: 'page', requiredParams: ['selector'], optionalParams: ['frame'] }],
  ['type', { group: 'page', requiredParams: ['selector', 'text'], optionalParams: ['frame'] }],
  ['waitForSelector', { group: 'page', requiredParams: ['selector'], optionalParams: ['timeout', 'frame'] }],
  ['getPageContent', { group: 'page', description: 'Get page title/url plus text and/or HTML. Supports pagination for large pages and optional iframe targeting via frame.', optionalParams: ['format', 'maxLength', 'offset', 'frame'] }],
  ['getPageText', { group: 'page', description: 'Get clean, readable article-style text in one call. Probes semantic content containers (article, main, [role=main], common post/entry-content patterns), picks the one with the most text, normalizes whitespace, and falls back to <body> for SPAs/feeds. Returns the matched source plus offset/maxLength pagination. Prefer this over getPageContent for "read the page" tasks; use querySelectorAll/evaluateJS for structured bulk extraction. Supports optional iframe targeting via frame.', optionalParams: ['maxLength', 'offset', 'frame'] }],
  ['readPage', { group: 'page', description: 'One-shot "open and read": optionally navigate to url, wait for the page to load and settle, then return smart readable text (same extraction as getPageText). Collapses navigate -> waitForStable -> getPageText into a single call.', optionalParams: ['url', 'maxLength', 'offset', 'frame'] }],
  ['querySelectorAll', { group: 'page', description: 'Extract all elements matching a CSS selector as structured records, with limit/offset pagination. Pierces open Shadow DOM by default (pierceShadow). Supports optional iframe targeting via frame.', requiredParams: ['selector'], optionalParams: ['limit', 'offset', 'fields', 'textMaxLength', 'pierceShadow', 'frame'] }],
  ['getWindowVariable', { group: 'page', description: 'Read a named window variable by dot-notation path (e.g. ytInitialData, __NEXT_DATA__, __NUXT__). Supports pagination and optional iframe targeting via frame.', requiredParams: ['path'], optionalParams: ['maxLength', 'offset', 'frame'] }],
  ['findByText', { group: 'page', description: 'Find elements by visible text content using TreeWalker — no CSS class dependency. Pierces open Shadow DOM by default (pierceShadow). Supports optional iframe targeting via frame.', requiredParams: ['text'], optionalParams: ['exact', 'selector', 'maxResults', 'pierceShadow', 'frame'] }],
  ['pageFetch', { group: 'page', description: 'Run fetch() inside the page or target iframe so it inherits the cookies/origin/session for that frame. Returns a structured, size-bounded result.', requiredParams: ['url'], optionalParams: ['method', 'headers', 'body', 'responseType', 'credentials', 'maxLength', 'offset', 'frame'] }],

  /* ── Chrome DevTools Protocol ────────────────────────── */
  ['evaluateJS', { group: 'cdp', description: 'Run JavaScript in the page (MAIN world) and get the result back. Your code runs inside an async IIFE, so `await` works and a single expression is auto-returned — `document.title`, `[...document.querySelectorAll("table tr")].map(tr => tr.innerText)`, or a nested `(() => {...})()` all resolve to their value without needing an explicit `return`. Multi-statement bodies (declarations, loops, control flow) still need an explicit top-level `return`. Prefer this (or querySelectorAll) over ARIA snapshots for bulk row/table/data extraction, since ARIA snapshots target interactive controls and may omit dense tabular rows, tooltips, or chart internals. Supports optional iframe targeting via frame.', requiredParams: ['code'], optionalParams: ['frame'] }],
  ['executeCDP', { group: 'cdp', requiredParams: ['method'], optionalParams: ['params'] }],
  ['screenshot', { group: 'cdp', optionalParams: ['fullPage'] }],

  /* ── Multi-action orchestration ──────────────────────── */
  ['batch', {
    group: 'orchestration',
    description: 'Run several gateway commands sequentially in one round-trip (handled inside the extension). params.actions is an array of { method, params }. Threads the active tab across actions; onError "continue" (default) or "stop-on-error"; screenshotAfter captures after each action. NOTE: per-action guard/retry/captureAs are NOT available — use real steps when you need those.',
    requiredParams: ['actions'],
    optionalParams: ['onError', 'screenshotAfter', 'tabId', 'actionTimeoutMs'],
  }],

  /* ── Page WebMCP tools ───────────────────────────────── */
  ['webmcp.listTools', { group: 'webmcp', optionalParams: ['frame'] }],
  ['webmcp.invokeTool', { group: 'webmcp', requiredParams: ['toolName'], optionalParams: ['input', 'frame'] }],

  /* ── AI observation ──────────────────────────────────── */
  ['getAccessibilityTree', { group: 'vision', optionalParams: ['depth', 'interestingOnly'] }],
  ['getDOMSnapshot', { group: 'vision', optionalParams: ['computedStyles'] }],
  ['getElementBounds', { group: 'vision', requiredParams: ['selector'], optionalParams: ['pierceShadow', 'frame'] }],
  ['getInteractiveElements', { group: 'vision', optionalParams: ['pierceShadow', 'frame'] }],

  /* ── ARIA snapshot interaction ───────────────────────── */
  ['getAriaSnapshot', { group: 'aria', description: 'Capture an accessibility snapshot with ref IDs. Defaults to a fast content-script, viewport-first snapshot with compact persistent refs like ref=r1 or ref=f3r1; use mode="native" for the CDP Accessibility fallback with refs like ref=S1. Depth counts accessibility levels (wrapper <div>s are free) with default maxDepth=15. Set includeText=true to also surface role-less text (post bodies, captions) as text "..." lines, and waitStable=true to let lazy-hydrated feeds settle before snapshotting.', optionalParams: ['maxDepth', 'mode', 'scope', 'maxNodes', 'maxChars', 'includeOptions', 'maxOptions', 'includeText', 'maxTextLength', 'waitStable', 'refFormat', 'viewportMargin', 'frameId'] }],
  ['clickByRef', { group: 'aria', description: 'Click an element using an ARIA snapshot ref (e.g. ref=r1, ref=f3r1, legacy ref=F0:R1, or native ref=S1). Run getAriaSnapshot first to get refs.', requiredParams: ['ref'], optionalParams: ['element', 'frameId'] }],
  ['typeByRef', { group: 'aria', description: 'Type text into an element using an ARIA snapshot ref. Run getAriaSnapshot first. Supports optional submit (press Enter after typing).', requiredParams: ['ref', 'text'], optionalParams: ['submit', 'frameId'] }],
  ['hoverByRef', { group: 'aria', description: 'Hover over an element using its ARIA snapshot ref.', requiredParams: ['ref'], optionalParams: ['frameId'] }],
  ['selectByRef', { group: 'aria', description: 'Select option(s) in a dropdown using its ARIA snapshot ref.', requiredParams: ['ref', 'values'], optionalParams: ['frameId'] }],

  /* ── Full browser control ────────────────────────────── */
  ['waitForStable', { group: 'control', description: 'Wait for the page to stabilize (no DOM mutations for a quiet period). Useful after navigation or clicking dynamic elements. Use watchSelector to scope to a subtree, ignoreSelectors to exclude noisy elements (e.g. video player), and ignoreCharacterData to suppress text-node tick mutations on video/live pages.', optionalParams: ['minStableMs', 'maxWaitMs', 'maxMutations', 'watchSelector', 'ignoreSelectors', 'ignoreCharacterData'] }],

  /* ── Runtime observability ───────────────────────────── */
  ['startConsoleCapture', { group: 'observability', description: 'Start capturing Runtime console API calls and uncaught exceptions for a tab. Uses CDP Runtime events and a bounded per-tab buffer.', optionalParams: ['tabId'] }],
  ['stopConsoleCapture', { group: 'observability', description: 'Stop console capture for a tab and clear its buffered messages.', optionalParams: ['tabId'] }],
  ['readConsoleMessages', { group: 'observability', description: 'Read captured console messages with optional level, substring pattern, timestamp, limit, and consume-on-read filtering.', optionalParams: ['level', 'pattern', 'limit', 'since', 'clear', 'tabId'] }],
  ['clearConsoleMessages', { group: 'observability', description: 'Clear the captured console message buffer while keeping capture active.', optionalParams: ['tabId'] }],

  /* ── CDP input ───────────────────────────────────────── */
  ['dispatchClick', { group: 'input', requiredParams: ['x', 'y'], optionalParams: ['button', 'clickCount', 'frame'] }],
  ['moveMouse', { group: 'input', requiredParams: ['x', 'y'], optionalParams: ['fromX', 'fromY', 'steps', 'frame'] }],
  ['pressKey', { group: 'input', requiredParams: ['key'], optionalParams: ['text', 'modifiers'] }],
  ['typeText', { group: 'input', requiredParams: ['text'] }],
  ['scroll', { group: 'input', optionalParams: ['x', 'y', 'deltaX', 'deltaY'] }],
  ['hover', { group: 'input', requiredParams: ['selector'], optionalParams: ['frame'] }],
  ['selectOption', { group: 'input', requiredParams: ['selector'], optionalParams: ['value', 'index', 'text', 'frame'] }],

  /* ── Full browser control (continued) ────────────────── */
  ['getCookies', { group: 'control' }],
  ['setCookie', { group: 'control', requiredParams: ['name', 'value'], optionalParams: ['domain', 'path'] }],
  ['deleteCookies', { group: 'control', requiredParams: ['name'], optionalParams: ['domain', 'url'] }],
  ['getLocalStorage', { group: 'control' }],
  ['setLocalStorage', { group: 'control', requiredParams: ['key'], optionalParams: ['value'] }],
  ['listWindows', { group: 'control' }],
  ['createWindow', { group: 'control', optionalParams: ['url', 'width', 'height', 'type'] }],
  ['setViewport', { group: 'control', requiredParams: ['width', 'height'], optionalParams: ['deviceScaleFactor', 'mobile'] }],
  ['resetViewport', { group: 'control' }],
  ['ping', { group: 'control' }],
  ['getExtensionInfo', { group: 'control', description: 'Return extension manifest version, attached debugger tabs, and gateway WebSocket URL.' }],

  /* ── Runner pseudo commands ──────────────────────────── */
  ['wait', { group: 'runner', optionalParams: ['ms', 'timeout'] }],
  ['delay', { group: 'runner', optionalParams: ['ms', 'timeout'] }],
];

/* ═══════════════════════════════════════════════════════════
 *  Unsupported commands
 *
 *  Commands listed here are recognized but rejected during validation
 *  with a human-readable reason.
 * ═══════════════════════════════════════════════════════════ */

/** @type {Object<string, string>} Map of command name → unsupported reason. */
const UNSUPPORTED_COMMANDS = {};

/* ═══════════════════════════════════════════════════════════
 *  Command map (built from definitions)
 * ═══════════════════════════════════════════════════════════ */

/**
 * Immutable Map of command name → normalized command metadata.
 * Built once at module load from {@link COMMAND_DEFINITIONS}.
 *
 * @type {Map<string, { name: string, group: string, requiredParams: string[], optionalParams: string[], description: string }>}
 */
const COMMANDS = new Map(
  COMMAND_DEFINITIONS.map(([name, definition]) => [
    name,
    {
      name,
      group: definition.group,
      requiredParams: definition.requiredParams || [],
      optionalParams: definition.optionalParams || [],
      description: definition.description || '',
    },
  ]),
);

/* ═══════════════════════════════════════════════════════════
 *  Lookup functions
 * ═══════════════════════════════════════════════════════════ */

/**
 * Retrieve the metadata object for a command by name.
 * @param {string} name - Command name (e.g. `'clickByRef'`).
 * @returns {{ name: string, group: string, requiredParams: string[], optionalParams: string[], description: string }|undefined}
 */
function getCommand(name) {
  return COMMANDS.get(name);
}

/**
 * Check whether a command name exists in the catalog.
 * @param {string} name
 * @returns {boolean}
 */
function hasCommand(name) {
  return COMMANDS.has(name);
}

/**
 * Check whether a command is explicitly marked as unsupported.
 * @param {string} name
 * @returns {boolean}
 */
function isUnsupportedCommand(name) {
  return Object.prototype.hasOwnProperty.call(UNSUPPORTED_COMMANDS, name);
}

/**
 * Get the human-readable reason a command is unsupported.
 * @param {string} name
 * @returns {string|undefined}
 */
function getUnsupportedReason(name) {
  return UNSUPPORTED_COMMANDS[name];
}

/**
 * Return all commands sorted alphabetically by name.
 * @returns {Array<{ name: string, group: string, requiredParams: string[], optionalParams: string[], description: string }>}
 */
function listCommands() {
  return Array.from(COMMANDS.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Return command groups with their commands populated, omitting empty groups.
 * @returns {Array<{ id: string, label: string, commands: Array }>}
 */
function getCommandGroups() {
  return COMMAND_GROUPS.map((group) => ({
    ...group,
    commands: listCommands().filter((command) => command.group === group.id),
  })).filter((group) => group.commands.length > 0);
}

/* ═══════════════════════════════════════════════════════════
 *  Parameter validation
 * ═══════════════════════════════════════════════════════════ */

/**
 * Check whether a params object contains a meaningful value for a given key.
 * Returns `false` for `undefined`, `null`, and empty strings.
 *
 * @param {Object} params - The params object.
 * @param {string} key    - The key to check.
 * @returns {boolean}
 */
function hasParam(params, key) {
  return (
    params &&
    Object.prototype.hasOwnProperty.call(params, key) &&
    params[key] !== undefined &&
    params[key] !== null &&
    params[key] !== ''
  );
}

/**
 * Validate that all required params are present for a command.
 *
 * @param {string} commandName - The command to validate against.
 * @param {Object} [params={}] - The provided params.
 * @returns {string[]} Array of validation error messages (empty = valid).
 */
function validateCommandParams(commandName, params = {}) {
  const command = getCommand(commandName);
  if (!command) return [];

  const errors = [];
  for (const paramName of command.requiredParams) {
    if (!hasParam(params, paramName)) {
      errors.push(`Command "${commandName}" is missing required param "${paramName}"`);
    }
  }
  return errors;
}

module.exports = {
  COMMAND_DEFINITIONS,
  COMMAND_GROUPS,
  UNSUPPORTED_COMMANDS,
  getCommand,
  hasCommand,
  isUnsupportedCommand,
  getUnsupportedReason,
  listCommands,
  getCommandGroups,
  validateCommandParams,
};

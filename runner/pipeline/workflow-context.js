/**
 * @module pipeline/workflow-context
 * @description Variable store and template interpolation engine for workflow runs.
 *
 * {@link WorkflowContext} holds the merged variable namespace (workflow defaults,
 * runtime overrides, builtins) and provides `{{ expression }}` template resolution
 * with dot-path traversal.  Step results and captured outputs are also tracked here
 * so later steps can reference earlier results via `{{ steps.<id>.result }}` or
 * `{{ last.result }}`.
 */

/* ═══════════════════════════════════════════════════════════
 *  Constants
 * ═══════════════════════════════════════════════════════════ */

/**
 * Regex pattern that matches `{{ path.to.variable }}` template expressions.
 * Used by both interpolation and static analysis (extractTemplatePaths).
 * @type {RegExp}
 */
const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

/* ═══════════════════════════════════════════════════════════
 *  Internal helpers
 * ═══════════════════════════════════════════════════════════ */

/**
 * Check whether a value is a plain (non-array) object.
 * @param {*} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Convert a resolved template value to a string for inline substitution.
 * Objects and arrays are JSON-stringified; primitives use String().
 *
 * @param {*} value - The resolved value.
 * @returns {string}
 */
function stringifyTemplateValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Build the root lookup object used by dot-path resolution.
 * Merges variables with special namespaces (steps, last, outputs).
 *
 * @param {WorkflowContext} context
 * @returns {Object}
 */
function makeRoot(context) {
  return {
    ...context.variables,
    steps: context.steps,
    last: context.last,
    outputs: context.outputs,
  };
}

/* ═══════════════════════════════════════════════════════════
 *  Dot-path accessors
 * ═══════════════════════════════════════════════════════════ */

/**
 * Resolve a dot-separated path against a root object.
 *
 * Supports shallow single-key lookup as well as deep traversal
 * (e.g. `"steps.open.result.url"`).  Returns `undefined` for
 * missing or intermediate-null paths.
 *
 * @param {Object} root - The lookup namespace.
 * @param {string} path - Dot-separated key path.
 * @returns {*} The resolved value, or `undefined`.
 */
function getPathValue(root, path) {
  if (!path) return undefined;
  if (Object.prototype.hasOwnProperty.call(root, path)) return root[path];

  const parts = path.split('.').map((part) => part.trim()).filter(Boolean);
  let current = root;

  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(Object(current), part)) return undefined;
    current = current[part];
  }

  return current;
}

/**
 * Set a value at a dot-separated path, creating intermediate objects as needed.
 *
 * @param {Object} root  - The target namespace.
 * @param {string} path  - Dot-separated key path.
 * @param {*}      value - Value to assign.
 */
function setPathValue(root, path, value) {
  const parts = path.split('.').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return;

  let current = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!isPlainObject(current[part])) current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

/* ═══════════════════════════════════════════════════════════
 *  Static template analysis
 * ═══════════════════════════════════════════════════════════ */

/**
 * Collect all `{{ expression }}` paths referenced in a value tree.
 *
 * Recursively walks strings, arrays, and plain objects.  Used by the
 * validator to check that every template reference points to a known
 * variable or step result.
 *
 * @param {*}      value         - The value tree to scan.
 * @param {Set}    [paths=new Set()] - Accumulator set (for recursion).
 * @returns {Set<string>} Set of unique template expression paths.
 */
function extractTemplatePaths(value, paths = new Set()) {
  if (typeof value === 'string') {
    let match;
    const pattern = new RegExp(TEMPLATE_PATTERN.source, 'g');
    while ((match = pattern.exec(value))) {
      paths.add(match[1].trim());
    }
    return paths;
  }

  if (Array.isArray(value)) {
    for (const item of value) extractTemplatePaths(item, paths);
    return paths;
  }

  if (isPlainObject(value)) {
    for (const item of Object.values(value)) extractTemplatePaths(item, paths);
  }

  return paths;
}

/* ═══════════════════════════════════════════════════════════
 *  WorkflowContext class
 * ═══════════════════════════════════════════════════════════ */

/**
 * Mutable variable store and template interpolation engine for a single run.
 *
 * Lifecycle:
 * 1. Constructed with workflow defaults + runtime overrides + builtins.
 * 2. Before each step, `interpolate()` resolves `{{ }}` tokens in params.
 * 3. After each step, `setStepResult()` records the outcome and `setCaptured()`
 *    stores any `captureAs` value.
 * 4. At run end, `serialize()` snapshots the full state for the run summary.
 */
class WorkflowContext {
  /**
   * @param {Object} [workflowVariables={}]  - Default variables from the workflow JSON.
   * @param {Object} [runtimeVariables={}]   - CLI / API overrides (take precedence).
   * @param {Object} [builtins={}]           - Auto-generated builtins (__TIMESTAMP__, etc.).
   */
  constructor(workflowVariables = {}, runtimeVariables = {}, builtins = {}) {
    this.variables = {
      ...workflowVariables,
      ...runtimeVariables,
      ...builtins,
    };
    this.outputs = {};
    this.steps = {};
    this.last = null;
    this.lastStepId = null;
  }

  /**
   * Resolve a dot-path against the full variable namespace.
   * @param {string} path - Dot-separated path (e.g. `"steps.login.result"`).
   * @returns {*}
   */
  get(path) {
    return getPathValue(makeRoot(this), path);
  }

  /**
   * Set a variable value by dot-path.
   * @param {string} path  - Dot-separated path.
   * @param {*}      value - Value to store.
   */
  set(path, value) {
    if (!path.includes('.')) {
      this.variables[path] = value;
      return;
    }
    setPathValue(this.variables, path, value);
  }

  /**
   * Update a builtin variable (e.g. `__ACTIVE_TAB_ID__`).
   * @param {string} name  - Variable name.
   * @param {*}      value - New value.
   */
  setBuiltin(name, value) {
    this.variables[name] = value;
  }

  /**
   * Store a captured output (from `captureAs`) — available as both a
   * top-level variable and under `outputs.<name>`.
   * @param {string} name  - The capture key.
   * @param {*}      value - The captured value.
   */
  setCaptured(name, value) {
    this.variables[name] = value;
    this.outputs[name] = value;
  }

  /**
   * Record the result of a completed (or failed) step.
   * @param {string} stepId - The step's unique id.
   * @param {Object} record - The step result record.
   */
  setStepResult(stepId, record) {
    this.steps[stepId] = record;
    this.last = record;
    this.lastStepId = stepId;
  }

  /**
   * Retrieve the result record for a previously executed step.
   * @param {string} stepId
   * @returns {Object|undefined}
   */
  getStepResult(stepId) {
    return this.steps[stepId];
  }

  /**
   * Get the most recently recorded step result.
   * @returns {Object|null}
   */
  getLastResult() {
    return this.last;
  }

  /**
   * Recursively resolve `{{ expression }}` templates in a value tree.
   *
   * - Strings: exact-match templates (`"{{ path }}"`) preserve the resolved
   *   type; partial templates are stringified and substituted inline.
   * - Arrays and plain objects: each element / value is recursively interpolated.
   * - Primitives: returned as-is.
   *
   * @param {*} value - The value tree to interpolate.
   * @returns {*} A new value tree with all templates resolved.
   */
  interpolate(value) {
    if (typeof value === 'string') {
      const exact = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
      if (exact) {
        const resolved = this.get(exact[1].trim());
        return resolved === undefined ? value : resolved;
      }

      return value.replace(TEMPLATE_PATTERN, (match, expression) => {
        const resolved = this.get(expression.trim());
        return resolved === undefined ? match : stringifyTemplateValue(resolved);
      });
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.interpolate(item));
    }

    if (isPlainObject(value)) {
      const output = {};
      for (const [key, item] of Object.entries(value)) {
        output[key] = this.interpolate(item);
      }
      return output;
    }

    return value;
  }

  /**
   * Snapshot the full context state for inclusion in the run summary.
   * @returns {{ variables: Object, outputs: Object, steps: Object, lastStepId: string|null }}
   */
  serialize() {
    return {
      variables: this.variables,
      outputs: this.outputs,
      steps: this.steps,
      lastStepId: this.lastStepId,
    };
  }
}

module.exports = {
  WorkflowContext,
  TEMPLATE_PATTERN,
  extractTemplatePaths,
  stringifyTemplateValue,
};

'use strict';

/**
 * grade-summary — pure signal grader (P0 of the pipeline orchestration plan).
 *
 * Migrated from the store's `store-doctor.mjs` so the executor owns verification.
 * This is the SIDE-EFFECT-FREE core: given a verify spec (`*.verify.json`) and a
 * runner `summary.json`, return `{ verdict, signals }`. It does NOT touch the
 * ledger, frontmatter, or flake/confirm-red history — that stays in store-doctor,
 * which can later import this module and layer its bookkeeping on top.
 *
 * Verdict: green (all signals pass) | red (a failing signal has onFail:'red') |
 *          amber (only onFail:'amber' signals failed).
 */

// $.a.b[0].c  — the subset used by verify specs.
function jsonPathGet(obj, path) {
  if (!path || path === '$') return obj;
  const parts = path.replace(/^\$\.?/, '').match(/[^.[\]]+/g) || [];
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[/^\d+$/.test(p) ? Number(p) : p];
  }
  return cur;
}

function compare(actual, op, value) {
  switch (op) {
    case '==': return actual === value || JSON.stringify(actual) === JSON.stringify(value);
    case '!=': return actual !== value;
    case '>=': return Number(actual) >= Number(value);
    case '>': return Number(actual) > Number(value);
    case '<=': return Number(actual) <= Number(value);
    case '<': return Number(actual) < Number(value);
    default: return false;
  }
}

// Resolve a signal's `from` against the run summary's captured context.
function sourceValue(summary, from) {
  if (!from) return summary;
  const ctx = summary.context || {};
  if (ctx.outputs && from in ctx.outputs) return ctx.outputs[from];
  if (ctx.variables && from in ctx.variables) return ctx.variables[from];
  return undefined;
}

function evalSignal(summary, sig) {
  if (sig.when) {
    const condVal = jsonPathGet(sourceValue(summary, sig.when.from), sig.when.path);
    if (!compare(condVal, sig.when.op || '==', sig.when.value)) {
      return { id: sig.id, pass: true, skipped: true, detail: 'when-guard false — skipped' };
    }
  }
  switch (sig.type) {
    case 'stepStatus': {
      const step = (summary.results || []).find((r) => r.stepId === sig.stepId);
      const actual = step ? step.status : '(step missing)';
      return { id: sig.id, pass: actual === sig.equals, detail: `step '${sig.stepId}' = ${actual}` };
    }
    case 'jsonPath': {
      const actual = jsonPathGet(sourceValue(summary, sig.from), sig.path);
      if ('exists' in sig) {
        const pass = sig.exists ? actual !== undefined : actual === undefined;
        return { id: sig.id, pass, detail: `${sig.from}${(sig.path || '').slice(1)} ${actual === undefined ? 'missing' : 'exists'}` };
      }
      return {
        id: sig.id,
        pass: compare(actual, sig.op || '==', sig.value),
        detail: `${sig.from}${(sig.path || '').slice(1)} = ${JSON.stringify(actual)} (want ${sig.op || '=='} ${JSON.stringify(sig.value)})`,
      };
    }
    case 'jsonShape': {
      const target = jsonPathGet(sourceValue(summary, sig.from), sig.path);
      if (target == null || typeof target !== 'object') {
        return { id: sig.id, pass: false, detail: `${sig.from}${(sig.path || '').slice(1)} is not an object` };
      }
      const missing = (sig.requiredKeys || []).filter((k) => !(k in target));
      return { id: sig.id, pass: !missing.length, detail: missing.length ? `missing keys: ${missing.join(', ')}` : 'all required keys present' };
    }
    default:
      return { id: sig.id, pass: true, skipped: true, detail: `unknown signal type '${sig.type}'` };
  }
}

/**
 * @param {{signals?: Array}} spec    parsed *.verify.json
 * @param {object} summary            runner summary.json
 * @returns {{ verdict: 'green'|'amber'|'red', signals: Array }}
 */
function gradeSummary(spec, summary) {
  const signals = (spec.signals || []).map((sig) => ({ ...evalSignal(summary, sig), onFail: sig.onFail || 'red' }));
  const failed = signals.filter((r) => !r.pass);
  const verdict = !failed.length ? 'green' : failed.some((r) => r.onFail === 'red') ? 'red' : 'amber';
  return { verdict, signals };
}

module.exports = { gradeSummary, evalSignal, jsonPathGet, compare, sourceValue };

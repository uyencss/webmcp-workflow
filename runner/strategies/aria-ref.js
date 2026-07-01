/**
 * @module strategies/aria-ref
 * @description ARIA Ref strategy — element targeting by accessibility snapshot.
 *
 * This strategy captures an ARIA snapshot of the page, parses it for
 * ref-addressable elements, scores them against the user's instruction,
 * and dispatches the appropriate action (click, type, hover, select)
 * via the matching `*ByRef` command.
 *
 * Exported helpers are pure functions (no `this` dependency) so they can
 * be tested in isolation.
 */

const { RunnerError } = require('../shared/errors');

/* ═══════════════════════════════════════════════════════════
 *  Constants
 * ═══════════════════════════════════════════════════════════ */

/**
 * Maps user-facing action names to their corresponding WebMCP `*ByRef`
 * command names.
 *
 * @type {Object<string, string>}
 */
const ARIA_ACTION_COMMANDS = {
  click: 'clickByRef',
  type: 'typeByRef',
  hover: 'hoverByRef',
  select: 'selectByRef',
};

/* ═══════════════════════════════════════════════════════════
 *  Snapshot parsing
 * ═══════════════════════════════════════════════════════════ */

/**
 * Parse a raw ARIA snapshot string into structured entries.
 *
 * Each line of the snapshot may contain a `ref=...` token.  Lines without
 * a ref are filtered out.  Each entry contains:
 * - `ref`  — the ref id (e.g. `"r1"`, `"f3r1"`, `"S1"`).
 * - `text` — the full line with leading `- ` stripped, for scoring.
 *
 * @param {string} snapshot - Raw snapshot text from `getAriaSnapshot`.
 * @returns {Array<{ ref: string, text: string }>}
 */
function parseAriaSnapshot(snapshot) {
  return String(snapshot || '')
    .split('\n')
    .map((line) => {
      const match = line.match(/\bref=([A-Za-z0-9:]+)\b/);
      if (!match) return null;
      return {
        ref: match[1],
        text: line.replace(/^\s*-\s*/, '').trim(),
      };
    })
    .filter(Boolean);
}

/* ═══════════════════════════════════════════════════════════
 *  Entry scoring
 * ═══════════════════════════════════════════════════════════ */

/**
 * Score an ARIA snapshot entry against a natural-language instruction.
 *
 * Scoring rules:
 * - +6 if the full lowered instruction appears as a substring of the entry text.
 * - +1 for each keyword token found in the entry text.
 * - +2 bonus when the instruction mentions a UI element type and the entry's
 *   role text matches (button, textbox/searchbox, link, combobox/option).
 *
 * @param {{ ref: string, text: string }} entry - Parsed ARIA snapshot entry.
 * @param {string}   instruction - The original instruction text.
 * @param {string[]} tokens      - Pre-computed keyword tokens (from ai-vision's keywordTokens).
 * @returns {number} Non-negative match score (0 = no match).
 */
function scoreAriaEntry(entry, instruction, tokens) {
  const text = String(entry?.text || '').toLowerCase();
  const loweredInstruction = String(instruction || '').toLowerCase();
  let score = 0;

  if (loweredInstruction && text.includes(loweredInstruction)) score += 6;
  for (const token of tokens) {
    if (text.includes(token)) score += 1;
  }

  if (loweredInstruction.includes('button') && text.includes('button')) score += 2;
  if (loweredInstruction.includes('input') && (text.includes('textbox') || text.includes('searchbox'))) score += 2;
  if (loweredInstruction.includes('link') && text.includes('link')) score += 2;
  if (loweredInstruction.includes('select') && (text.includes('combobox') || text.includes('option'))) score += 2;

  return score;
}

module.exports = {
  ARIA_ACTION_COMMANDS,
  parseAriaSnapshot,
  scoreAriaEntry,
};

/**
 * @module strategies/ai-vision
 * @description AI Vision strategy — element targeting by keyword matching.
 *
 * This strategy uses `getInteractiveElements` to enumerate all interactive
 * elements on the page, scores them against the user's natural-language
 * instruction, and dispatches a click at the best match's center coordinates.
 *
 * Exported helpers are pure functions (no `this` dependency) so they can be
 * tested in isolation and reused by other strategies if needed.
 */

const { RunnerError } = require('../shared/errors');

/* ═══════════════════════════════════════════════════════════
 *  Constants
 * ═══════════════════════════════════════════════════════════ */

/**
 * Common stopwords filtered out during keyword tokenization.
 * Includes English action verbs and Vietnamese filler words that
 * would cause false-positive matches.
 *
 * @type {Set<string>}
 */
const AI_STOPWORDS = new Set([
  'the',
  'and',
  'find',
  'click',
  'button',
  'that',
  'for',
  'with',
  'this',
  'input',
  'area',
  'text',
  'hay',
  'hoac',
  'hoặc',
  'dang',
  'đang',
]);

/* ═══════════════════════════════════════════════════════════
 *  Keyword tokenizer
 * ═══════════════════════════════════════════════════════════ */

/**
 * Tokenize a natural-language instruction into scoring keywords.
 *
 * Processing steps:
 * 1. Lowercase and strip diacritics (NFD + combining-char removal).
 * 2. Remove quote characters.
 * 3. Split on whitespace and drop tokens ≤ 2 chars or in {@link AI_STOPWORDS}.
 *
 * @param {string} instruction - The user's target instruction (e.g. "click the Sign In button").
 * @returns {string[]} Filtered keyword tokens.
 */
function keywordTokens(instruction) {
  return String(instruction || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['"`]/g, '')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !AI_STOPWORDS.has(word));
}

/* ═══════════════════════════════════════════════════════════
 *  Element scoring
 * ═══════════════════════════════════════════════════════════ */

/**
 * Score an interactive element against a natural-language instruction.
 *
 * Scoring rules:
 * - +1 for each keyword token found in the element's combined text
 *   (text, placeholder, ariaLabel, href, name, id, role).
 * - +2 bonus when the instruction mentions an element type (button, input,
 *   link, textbox) and the element's tag or role matches.
 *
 * @param {Object}   element     - An element record from `getInteractiveElements`.
 * @param {string}   instruction - The original instruction text.
 * @param {string[]} tokens      - Pre-computed keyword tokens.
 * @returns {number} Non-negative match score (0 = no match).
 */
function scoreInteractiveElement(element, instruction, tokens) {
  const combined = [
    element.text,
    element.placeholder,
    element.ariaLabel,
    element.href,
    element.name,
    element.id,
    element.role,
  ].filter(Boolean).join(' ').toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (combined.includes(token)) score += 1;
  }

  const loweredInstruction = String(instruction || '').toLowerCase();
  if (loweredInstruction.includes('button') && (element.tag === 'button' || element.role === 'button')) score += 2;
  if (loweredInstruction.includes('input') && element.tag === 'input') score += 2;
  if (loweredInstruction.includes('link') && element.tag === 'a') score += 2;
  if (loweredInstruction.includes('textbox') && (element.tag === 'textarea' || element.role === 'textbox')) score += 2;

  return score;
}

module.exports = {
  AI_STOPWORDS,
  keywordTokens,
  scoreInteractiveElement,
};

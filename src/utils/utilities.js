// ─────────────────────────────────────────────────────────────
// Shared Utilities — General-purpose helpers
// ─────────────────────────────────────────────────────────────

/**
 * Resolves after `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Format an estimated cost as a log-friendly tag string.
 * Returns `, cost: $0.001234` when cost is available, or empty string otherwise.
 *
 * @param {number|null} estimatedCost
 * @returns {string}
 */
export function formatCostTag(estimatedCost) {
  return estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : "";
}

/**
 * Round a floating-point seconds value to millisecond precision (3 decimals).
 * Standard precision for all timing metrics stored in the database.
 *
 * @param {number} sec
 * @returns {number}
 */
export function roundMs(sec) {
  return parseFloat(sec.toFixed(3));
}

/**
 * Parse JSON from an LLM response, handling markdown code blocks.
 * Many LLMs wrap JSON in ```json ... ``` — this strips that before parsing.
 *
 * @param {string} text - Raw LLM response text
 * @returns {object|Array|null} Parsed JSON, or null if parsing fails
 */
export function parseJsonFromLlmResponse(text) {
  if (!text) return null;
  let jsonText = text.trim();
  const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) jsonText = jsonMatch[1].trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

/**
 * Calculate whole days elapsed since an ISO 8601 timestamp.
 *
 * @param {string} isoDate - ISO date string
 * @returns {number} Non-negative integer days
 */
export function daysSinceIso(isoDate) {
  return Math.max(0, Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000));
}

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

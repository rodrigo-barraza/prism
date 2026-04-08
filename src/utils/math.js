// ─────────────────────────────────────────────────────────────
// Shared math utilities — single source of truth
// ─────────────────────────────────────────────────────────────

/** Cap — anything above this is a measurement artifact */
const MAX_TOKENS_PER_SEC = 10_000;

/**
 * Calculate tokens-per-second throughput (tok/s).
 *
 * Centralised formula used by every request logger in the codebase.
 * Pass a provider-reported value in `opts.providerReported` to prefer
 * it over manual computation, and `opts.fallbackSec` to use totalSec
 * when generationSec is unavailable.
 *
 * @param {number} tokens    - Token count (output or input depending on context)
 * @param {number|null} sec  - Generation duration in seconds
 * @param {object} [opts]
 * @param {number} [opts.providerReported] - Provider-supplied tok/s (e.g. from usage.tokensPerSec)
 * @param {number} [opts.fallbackSec]      - Fallback duration if `sec` is not usable (e.g. totalSec)
 * @returns {number|null} Rounded to 1 decimal, or null if not computable
 */
export function calculateTokensPerSec(tokens, sec, opts = {}) {
  // 1. Provider-reported value takes priority
  if (opts.providerReported != null && opts.providerReported > 0) {
    const val = parseFloat(opts.providerReported.toFixed(1));
    return val > MAX_TOKENS_PER_SEC ? null : val;
  }

  // 2. Determine effective duration
  const effectiveSec =
    sec && sec > 0.001 ? sec : opts.fallbackSec && opts.fallbackSec > 0 ? opts.fallbackSec : null;

  if (!effectiveSec || !tokens || tokens <= 0) return null;

  const val = parseFloat((tokens / effectiveSec).toFixed(1));
  return val > MAX_TOKENS_PER_SEC ? null : val;
}

/**
 * Compute cosine similarity between two vectors.
 *
 * @param {number[]} a - First vector
 * @param {number[]} b - Second vector
 * @returns {number} Similarity score between -1 and 1 (0 on invalid input)
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

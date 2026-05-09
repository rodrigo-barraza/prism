// ─────────────────────────────────────────────────────────────
// Shared math utilities — single source of truth
// ─────────────────────────────────────────────────────────────

// Re-export generic math from utilities-library so existing
// import paths within prism-service continue to work.
export { cosineSimilarity } from "@rodrigo-barraza/utilities-library";

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


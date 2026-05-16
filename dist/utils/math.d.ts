export { cosineSimilarity } from "@rodrigo-barraza/utilities-library";
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
export declare function calculateTokensPerSec(tokens: any, sec: any, opts?: {}): number | null;
//# sourceMappingURL=math.d.ts.map
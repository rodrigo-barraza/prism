// ============================================================
// CostCalculator — Pure cost estimation utilities
// ============================================================

/**
 * Calculate the estimated cost for a text-to-text request.
 *
 * @param {{ inputTokens: number, outputTokens: number }} usage
 * @param {{ inputPerMillion: number, outputPerMillion: number }} pricing
 * @returns {number|null} Cost in USD, or null if pricing is unavailable.
 */
export function calculateTextCost(usage, pricing) {
    if (!pricing || !usage) return null;
    return parseFloat(
        (
            (usage.inputTokens / 1_000_000) * (pricing.inputPerMillion || 0) +
            (usage.outputTokens / 1_000_000) * (pricing.outputPerMillion || 0)
        ).toFixed(8),
    );
}

/**
 * Calculate the estimated cost for an audio-to-text request.
 * Supports two strategies — per-minute pricing takes priority.
 *
 * @param {{ durationSeconds?: number, inputTokens?: number, outputTokens?: number }} usage
 * @param {{ perMinute?: number, audioInputPerMillion?: number, outputPerMillion?: number }} pricing
 * @returns {number|null} Cost in USD, or null if pricing is unavailable.
 */
export function calculateAudioCost(usage, pricing) {
    if (!pricing || !usage) return null;

    // Strategy 1: per-minute pricing
    if (pricing.perMinute && usage.durationSeconds) {
        return parseFloat(
            ((usage.durationSeconds / 60) * pricing.perMinute).toFixed(8),
        );
    }

    // Strategy 2: token-based pricing
    if (pricing.audioInputPerMillion && usage.inputTokens) {
        return parseFloat(
            (
                (usage.inputTokens / 1_000_000) * pricing.audioInputPerMillion +
                ((usage.outputTokens || 0) / 1_000_000) *
                (pricing.outputPerMillion || 0)
            ).toFixed(8),
        );
    }

    return null;
}

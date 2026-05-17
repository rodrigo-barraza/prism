/**
 * Rate Limit Header Extraction Utilities
 *
 * Extracts rate-limit metadata from provider HTTP response headers.
 * OpenAI and Anthropic expose these in standardized header formats.
 * Google does not expose rate-limit headers — static tier data is used instead.
 */
/**
 * Extract rate-limit headers from an OpenAI HTTP response.
 * Works for both Chat Completions and Responses API.
 *
 * Headers:
 *   x-ratelimit-limit-requests      → max RPM
 *   x-ratelimit-limit-tokens        → max TPM
 *   x-ratelimit-remaining-requests  → remaining RPM
 *   x-ratelimit-remaining-tokens    → remaining TPM
 *   x-ratelimit-reset-requests      → RPM reset time
 *   x-ratelimit-reset-tokens        → TPM reset time
 *
 * @param {Response|null} response - Fetch Response object from OpenAI SDK
 * @param {string} [model] - Model name for per-model rate-limit tracking
 * @returns {object|null} Parsed rate-limit data, or null if unavailable
 */
export declare function extractOpenAIRateLimits(response: any, model: any): {
    provider: string;
    requests: {
        limit: number;
        remaining: number;
        reset: any;
    };
    tokens: {
        limit: number;
        remaining: number;
        reset: any;
    };
};
/**
 * Extract rate-limit headers from an Anthropic HTTP response.
 *
 * Headers:
 *   anthropic-ratelimit-requests-limit      → max RPM
 *   anthropic-ratelimit-tokens-limit        → max TPM
 *   anthropic-ratelimit-input-tokens-limit  → max input TPM
 *   anthropic-ratelimit-output-tokens-limit → max output TPM
 *   anthropic-ratelimit-requests-remaining  → remaining RPM
 *   anthropic-ratelimit-tokens-remaining    → remaining TPM
 *   anthropic-ratelimit-requests-reset      → RPM reset time
 *   anthropic-ratelimit-tokens-reset        → TPM reset time
 *   retry-after                             → seconds to wait if 429
 *
 * @param {Response|null} response - Fetch Response object from Anthropic SDK
 * @param {string} [model] - Model name for per-model rate-limit tracking
 * @returns {object|null} Parsed rate-limit data, or null if unavailable
 */
export declare function extractAnthropicRateLimits(response: any, model: any): {
    provider: string;
    requests: {
        limit: number;
        remaining: number;
        reset: any;
    };
    tokens: {
        limit: number;
        remaining: number;
        reset: any;
    };
    inputTokens: {
        limit: number;
        remaining: number;
        reset: any;
    };
    outputTokens: {
        limit: number;
        remaining: number;
        reset: any;
    };
};
//# sourceMappingURL=rateLimits.d.ts.map
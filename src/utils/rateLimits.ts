/**
 * Rate Limit Header Extraction Utilities
 *
 * Extracts rate-limit metadata from provider HTTP response headers.
 * OpenAI and Anthropic expose these in standardized header formats.
 * Google does not expose rate-limit headers — static tier data is used instead.
 */

import rateLimitStore from "../services/RateLimitStore.js";

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
export function extractOpenAIRateLimits(response, model) {
  if (!response?.headers) return null;
  const h = response.headers;

  const limitRequests = h.get("x-ratelimit-limit-requests");
  const limitTokens = h.get("x-ratelimit-limit-tokens");

  // Only return if we actually got rate-limit headers
  if (!limitRequests && !limitTokens) return null;

  const result = {
    provider: "openai",
    requests: {
      limit: safeInt(limitRequests),
      remaining: safeInt(h.get("x-ratelimit-remaining-requests")),
      reset: h.get("x-ratelimit-reset-requests") || null,
    },
    tokens: {
      limit: safeInt(limitTokens),
      remaining: safeInt(h.get("x-ratelimit-remaining-tokens")),
      reset: h.get("x-ratelimit-reset-tokens") || null,
    },
  };

  // Update the global store with the latest per-model snapshot
  rateLimitStore.update("openai", model, result);

  return result;
}

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
export function extractAnthropicRateLimits(response, model) {
  if (!response?.headers) return null;
  const h = response.headers;

  const limitRequests = h.get("anthropic-ratelimit-requests-limit");
  const limitTokens = h.get("anthropic-ratelimit-tokens-limit");

  // Only return if we actually got rate-limit headers
  if (!limitRequests && !limitTokens) return null;

  const result = {
    provider: "anthropic",
    requests: {
      limit: safeInt(limitRequests),
      remaining: safeInt(h.get("anthropic-ratelimit-requests-remaining")),
      reset: h.get("anthropic-ratelimit-requests-reset") || null,
    },
    tokens: {
      limit: safeInt(limitTokens),
      remaining: safeInt(h.get("anthropic-ratelimit-tokens-remaining")),
      reset: h.get("anthropic-ratelimit-tokens-reset") || null,
    },
    inputTokens: {
      limit: safeInt(h.get("anthropic-ratelimit-input-tokens-limit")),
      remaining: safeInt(h.get("anthropic-ratelimit-input-tokens-remaining")),
      reset: h.get("anthropic-ratelimit-input-tokens-reset") || null,
    },
    outputTokens: {
      limit: safeInt(h.get("anthropic-ratelimit-output-tokens-limit")),
      remaining: safeInt(h.get("anthropic-ratelimit-output-tokens-remaining")),
      reset: h.get("anthropic-ratelimit-output-tokens-reset") || null,
    },
  };

  // Update the global store with the latest per-model snapshot
  rateLimitStore.update("anthropic", model, result);

  return result;
}

/**
 * Safely parse a string to an integer, returning null on failure.
 */
function safeInt(val) {
  if (val == null) return null;
  const parsed = parseInt(val, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

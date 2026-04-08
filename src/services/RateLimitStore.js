/**
 * RateLimitStore — In-memory cache of latest provider rate-limit data.
 *
 * Updated dynamically from each OpenAI/Anthropic API response.
 * Google tier limits are seeded statically (no response headers available).
 *
 * Call `.update(providerName, rateLimits)` after every API response.
 * Call `.getAll()` to get a snapshot of all providers.
 * Call `.get(providerName)` to get a single provider's limits.
 */

// Static Google Tier 2 limits — seeded on module load since Google
// doesn't expose rate-limit headers in their SDK responses.
const GOOGLE_STATIC_LIMITS = {
  provider: "google",
  note: "Static tier-2 limits from Google AI Studio. Not dynamically updated.",
  models: {
    "gemini-3-flash": {
      rpm: 2000, tpm: 3_000_000, rpd: 100_000,
    },
    "gemini-3.1-pro": {
      rpm: 1000, tpm: 5_000_000, rpd: 50_000,
    },
    "gemini-2.5-flash": {
      rpm: 2000, tpm: 3_000_000, rpd: 100_000,
    },
    "gemini-2.5-pro": {
      rpm: 1000, tpm: 5_000_000, rpd: 50_000,
    },
    "gemini-2-flash": {
      rpm: 10_000, tpm: 10_000_000, rpd: null,
    },
  },
};

class RateLimitStore {
  constructor() {
    /** @type {Map<string, { rateLimits: object, updatedAt: string }>} */
    this._store = new Map();

    // Seed Google static limits
    this._store.set("google", {
      rateLimits: GOOGLE_STATIC_LIMITS,
      updatedAt: new Date().toISOString(),
      dynamic: false,
    });
  }

  /**
   * Update the stored rate-limit snapshot for a provider.
   * Called after every API response that contains rate-limit headers.
   *
   * @param {string} providerName - e.g. "openai", "anthropic"
   * @param {object} rateLimits - Parsed rate-limit data from extractXxxRateLimits()
   */
  update(providerName, rateLimits) {
    if (!rateLimits || !providerName) return;

    this._store.set(providerName, {
      rateLimits,
      updatedAt: new Date().toISOString(),
      dynamic: true,
    });
  }

  /**
   * Get the latest rate-limit data for a single provider.
   * @param {string} providerName
   * @returns {object|null}
   */
  get(providerName) {
    return this._store.get(providerName) || null;
  }

  /**
   * Get a snapshot of all provider rate limits.
   * @returns {object} { [provider]: { rateLimits, updatedAt, dynamic } }
   */
  getAll() {
    const result = {};
    for (const [key, val] of this._store) {
      result[key] = val;
    }
    return result;
  }
}

// Singleton
const rateLimitStore = new RateLimitStore();
export default rateLimitStore;

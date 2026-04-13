import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import { COLLECTIONS } from "../constants.js";
import logger from "../utils/logger.js";

// ─── Default Settings ─────────────────────────────────────────────────────────

const DEFAULTS = {
  memory: {
    extractionProvider: "",
    extractionModel: "",
    consolidationProvider: "",
    consolidationModel: "",
    embeddingProvider: "",
    embeddingModel: "",
  },
};

// ─── In-memory cache ──────────────────────────────────────────────────────────
// Hot path: MemoryService + EmbeddingService read these on every call.
// Cache is invalidated on update() and lazily populated on first get().

let _cache = null;

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * SettingsService — server-side settings store backed by MongoDB.
 *
 * Stores a single document (keyed by `_key: "global"`) in the `settings`
 * collection. Uses an in-memory cache to avoid DB round-trips on the
 * hot path (embedding generation, memory extraction).
 */
const SettingsService = {
  /**
   * Get the current settings, merging with defaults for any missing keys.
   * @returns {Promise<object>}
   */
  async get() {
    if (_cache) return _cache;

    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.SETTINGS);
    if (!collection) return { ...DEFAULTS };

    const doc = await collection.findOne({ _key: "global" });
    if (!doc) {
      _cache = { ...DEFAULTS };
      return _cache;
    }

    // Deep merge: defaults ← stored
    _cache = deepMerge(DEFAULTS, doc.data || {});
    return _cache;
  },

  /**
   * Get a specific section of settings (e.g. "memory").
   * @param {string} section
   * @returns {Promise<object>}
   */
  async getSection(section) {
    const settings = await this.get();
    return settings[section] || DEFAULTS[section] || {};
  },

  /**
   * Update settings. Performs a deep merge with existing settings.
   * @param {object} data - Partial settings object to merge
   * @returns {Promise<object>} The full settings after merge
   */
  async update(data) {
    const collection = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.SETTINGS);
    if (!collection) throw new Error("Database not available");

    const current = await this.get();
    const merged = deepMerge(current, data);

    await collection.updateOne(
      { _key: "global" },
      {
        $set: {
          data: merged,
          updatedAt: new Date().toISOString(),
        },
        $setOnInsert: {
          _key: "global",
          createdAt: new Date().toISOString(),
        },
      },
      { upsert: true },
    );

    // Invalidate cache
    _cache = merged;
    logger.info("[SettingsService] Settings updated and cache refreshed");
    return merged;
  },

  /**
   * Clear the in-memory cache (useful for testing).
   */
  invalidateCache() {
    _cache = null;
  },

  /**
   * Return the compiled defaults for reference.
   */
  getDefaults() {
    return { ...DEFAULTS };
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Deep merge two plain objects. Source values override target values.
 * Arrays and non-plain-objects are replaced, not merged.
 */
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export default SettingsService;

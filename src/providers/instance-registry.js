// ============================================================
// Instance Registry — Multi-Instance Local Provider Support
// ============================================================
// Creates and registers provider instances from PROVIDER_* arrays
// in secrets.js. Each array entry is an instance: { url, concurrency }.
//
// Instances are auto-numbered per type:
//   PROVIDER_LM_STUDIO[0] → "lm-studio" (#1)
//   PROVIDER_LM_STUDIO[1] → "lm-studio-2" (#2)
//
// Usage:
//   getInstanceProvider("lm-studio")   → first LM Studio instance
//   getInstanceProvider("lm-studio-2") → second LM Studio instance
//   listInstances()                    → all registered instances
// ============================================================

import logger from "../utils/logger.js";
import {
  PROVIDER_LM_STUDIO,
  PROVIDER_VLLM,
  PROVIDER_OLLAMA,
  PROVIDER_LLAMA_CPP,
} from "../../secrets.js";

// Import factories
import { createLmStudioProvider } from "./lm-studio.js";
import { createOllamaProvider } from "./ollama.js";
import { createVllmProvider } from "./vllm.js";
import { createLlamaCppProvider } from "./llama-cpp.js";

// ── Factory map ─────────────────────────────────────────────
const FACTORIES = {
  "lm-studio": createLmStudioProvider,
  ollama: createOllamaProvider,
  vllm: createVllmProvider,
  "llama-cpp": createLlamaCppProvider,
};

// ── Provider arrays from secrets ────────────────────────────
const PROVIDER_ARRAYS = {
  "lm-studio": PROVIDER_LM_STUDIO || [],
  vllm: PROVIDER_VLLM || [],
  ollama: PROVIDER_OLLAMA || [],
  "llama-cpp": PROVIDER_LLAMA_CPP || [],
};

// ── Registry ────────────────────────────────────────────────

/**
 * @typedef {object} InstanceEntry
 * @property {string} id            - Unique instance ID (e.g. "lm-studio-2")
 * @property {string} type          - Provider type (e.g. "lm-studio")
 * @property {string} baseUrl       - Server URL
 * @property {number} concurrency   - Max concurrent requests for this instance
 * @property {number} instanceNumber - 1-based instance number within its type
 * @property {object} provider      - The instantiated provider object
 */

/** @type {Map<string, InstanceEntry>} */
const registry = new Map();

/**
 * Register all instances for a provider type from its array.
 * @param {string} type - Provider type key
 * @param {Array<{url: string, concurrency?: number}>} instances
 */
function registerType(type, instances) {
  const factory = FACTORIES[type];
  if (!factory) return;

  for (let i = 0; i < instances.length; i++) {
    const { url, concurrency = 1 } = instances[i];
    if (!url) continue;

    const instanceNumber = i + 1;
    const id = instanceNumber === 1 ? type : `${type}-${instanceNumber}`;
    const maxConcurrency = Math.max(1, parseInt(concurrency, 10) || 1);
    const provider = factory(url, id);

    registry.set(id, {
      id,
      type,
      baseUrl: url,
      concurrency: maxConcurrency,
      instanceNumber,
      provider,
    });

    logger.info(
      `[InstanceRegistry] ${id} → ${url} (concurrency: ${maxConcurrency})`,
    );
  }
}

// ── Register all instances from secrets ─────────────────────
for (const [type, instances] of Object.entries(PROVIDER_ARRAYS)) {
  registerType(type, instances);
}

// ── Public API ──────────────────────────────────────────────

/**
 * Get a provider instance by ID.
 * @param {string} id - Instance ID (e.g. "lm-studio", "lm-studio-2")
 * @returns {object|null} Provider object or null if not found
 */
export function getInstanceProvider(id) {
  return registry.get(id)?.provider || null;
}

/**
 * Get full instance entry by ID.
 * @param {string} id - Instance ID
 * @returns {InstanceEntry|null}
 */
export function getInstance(id) {
  return registry.get(id) || null;
}

/**
 * Check if an ID belongs to a registered instance.
 * @param {string} id
 * @returns {boolean}
 */
export function isInstance(id) {
  return registry.has(id);
}

/**
 * List all registered instances.
 * @returns {InstanceEntry[]}
 */
export function listInstances() {
  return [...registry.values()];
}

/**
 * List all registered instance IDs.
 * @returns {string[]}
 */
export function listInstanceIds() {
  return [...registry.keys()];
}

/**
 * Get all unique provider types that have at least one instance.
 * @returns {string[]}
 */
export function listInstanceTypes() {
  return [...new Set([...registry.values()].map((e) => e.type))];
}

/**
 * Get all instances of a given provider type.
 * @param {string} type - Provider type (e.g. "lm-studio")
 * @returns {InstanceEntry[]}
 */
export function getInstancesByType(type) {
  return [...registry.values()].filter((e) => e.type === type);
}

/**
 * Resolve the provider type from an instance ID.
 * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"
 * @param {string} id - Instance ID
 * @returns {string|null}
 */
export function getInstanceType(id) {
  return registry.get(id)?.type || null;
}

// ============================================================
// Instance Registry — Multi-Instance Local Provider Support
// ============================================================
// Creates and registers provider instances for local servers.
// Default instances come from the *_BASE_URL secrets (instance #1).
// Additional instances come from LOCAL_PROVIDER_INSTANCES in secrets.js.
//
// Each instance gets:
//   - Auto-numbered ID: "lm-studio" (#1), "lm-studio-2" (#2), etc.
//   - Its own provider object (via factory) targeting its baseUrl
//   - Its own concurrency setting for LocalModelQueue
//
// Usage:
//   getInstanceProvider("lm-studio")   → default LM Studio provider
//   getInstanceProvider("lm-studio-2") → second LM Studio instance
//   listInstances()                    → all registered instances
// ============================================================

import logger from "../utils/logger.js";
import {
  LM_STUDIO_BASE_URL,
  VLLM_BASE_URL,
  OLLAMA_BASE_URL,
  LLAMA_CPP_BASE_URL,
  LOCAL_MODEL_CONCURRENCY,
} from "../../secrets.js";

// Import factories
import { createLmStudioProvider } from "./lm-studio.js";
import { createOllamaProvider } from "./ollama.js";
import { createVllmProvider } from "./vllm.js";
import { createLlamaCppProvider } from "./llama-cpp.js";

// Dynamically import LOCAL_PROVIDER_INSTANCES (may not exist in older secrets.js)
let LOCAL_PROVIDER_INSTANCES = [];
try {
  const secrets = await import("../../secrets.js");
  LOCAL_PROVIDER_INSTANCES = secrets.LOCAL_PROVIDER_INSTANCES || [];
} catch {
  // No additional instances configured
}

// ── Factory map ─────────────────────────────────────────────
const FACTORIES = {
  "lm-studio": createLmStudioProvider,
  ollama: createOllamaProvider,
  vllm: createVllmProvider,
  "llama-cpp": createLlamaCppProvider,
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

/** Track how many instances of each type we've registered. */
const typeCounters = {};

/**
 * Register a local provider instance.
 * @param {object} config
 * @param {string} config.type       - Provider type
 * @param {string} config.baseUrl    - Server URL
 * @param {number} [config.concurrency] - Max concurrent GPU requests (default: LOCAL_MODEL_CONCURRENCY)
 */
function register({ type, baseUrl, concurrency }) {
  const factory = FACTORIES[type];
  if (!factory) {
    logger.warn(`[InstanceRegistry] Unknown provider type "${type}" — skipping`);
    return;
  }

  if (!baseUrl) {
    // Don't register instances with empty URLs
    return;
  }

  // Auto-number: first of this type = "lm-studio" (#1), second = "lm-studio-2" (#2), etc.
  typeCounters[type] = (typeCounters[type] || 0) + 1;
  const instanceNumber = typeCounters[type];
  const id = instanceNumber === 1 ? type : `${type}-${instanceNumber}`;

  const maxConcurrency = Math.max(1, parseInt(concurrency, 10) || parseInt(LOCAL_MODEL_CONCURRENCY, 10) || 1);
  const provider = factory(baseUrl, id);

  registry.set(id, {
    id,
    type,
    baseUrl,
    concurrency: maxConcurrency,
    instanceNumber,
    provider,
  });

  logger.info(
    `[InstanceRegistry] Registered ${id} → ${baseUrl} (concurrency: ${maxConcurrency})`,
  );
}

// ── Register default instances from legacy secrets ──────────
const DEFAULT_INSTANCES = [
  { type: "lm-studio", baseUrl: LM_STUDIO_BASE_URL },
  { type: "vllm", baseUrl: VLLM_BASE_URL },
  { type: "ollama", baseUrl: OLLAMA_BASE_URL },
  { type: "llama-cpp", baseUrl: LLAMA_CPP_BASE_URL },
];

for (const inst of DEFAULT_INSTANCES) {
  register(inst);
}

// ── Register additional instances ───────────────────────────
for (const inst of LOCAL_PROVIDER_INSTANCES) {
  register(inst);
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

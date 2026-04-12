// ============================================================
// LocalModelQueue — Process-level Counting Semaphore for Local GPU Models
// ============================================================
// Local inference servers (LM Studio, vLLM, Ollama, llama.cpp) can
// serve a limited number of concurrent requests depending on your
// GPU / VRAM headroom. This module provides a FIFO counting semaphore
// that serializes local model requests across the entire Prism
// process — whether they originate from concurrent benchmark runs,
// chat requests, or any other path.
//
// The maximum number of concurrent slots is configured via
// LOCAL_MODEL_CONCURRENCY in secrets.js (defaults to 1).
//
// Usage:
//   const release = await LocalModelQueue.acquire();
//   try { await doInference(); }
//   finally { release(); }

import logger from "../utils/logger.js";
import { LOCAL_MODEL_CONCURRENCY } from "../../secrets.js";

// Providers that hit the local GPU
const LOCAL_PROVIDERS = new Set(["lm-studio", "vllm", "ollama", "llama-cpp"]);

class LocalModelQueue {
  constructor() {
    /** Maximum concurrent requests allowed */
    this._maxConcurrency = Math.max(1, parseInt(LOCAL_MODEL_CONCURRENCY, 10) || 1);
    /** @type {Array<() => void>} FIFO queue of pending resolve callbacks */
    this._queue = [];
    /** Number of slots currently in use */
    this._activeCount = 0;
    /** Number of total requests processed (for logging) */
    this._totalProcessed = 0;

    logger.info(
      `[LocalModelQueue] Initialized with concurrency: ${this._maxConcurrency}`,
    );
  }

  /**
   * Check whether a provider requires the local GPU lock.
   * @param {string} provider
   * @returns {boolean}
   */
  isLocal(provider) {
    return LOCAL_PROVIDERS.has(provider);
  }

  /**
   * Acquire a semaphore slot. Resolves immediately if a slot is
   * available, otherwise enqueues and waits for its turn (FIFO order).
   *
   * @returns {Promise<() => void>} A release function — MUST be called
   *   when inference is complete (use try/finally).
   */
  acquire() {
    return new Promise((resolve) => {
      const release = () => {
        this._activeCount--;
        this._totalProcessed++;
        const next = this._queue.shift();
        if (next) {
          // Hand a slot to the next waiter
          this._activeCount++;
          next();
        }
      };

      if (this._activeCount < this._maxConcurrency) {
        this._activeCount++;
        resolve(release);
      } else {
        // Enqueue — will be resolved when a previous holder calls release()
        this._queue.push(() => resolve(release));
        logger.info(
          `[LocalModelQueue] Queued request (${this._queue.length} waiting, ${this._activeCount}/${this._maxConcurrency} active)`,
        );
      }
    });
  }

  /** Number of requests currently waiting in the queue. */
  get pending() {
    return this._queue.length;
  }

  /** Whether all slots are currently in use. */
  get busy() {
    return this._activeCount >= this._maxConcurrency;
  }

  /** Number of slots currently in use. */
  get activeCount() {
    return this._activeCount;
  }

  /** Maximum concurrent slots. */
  get maxConcurrency() {
    return this._maxConcurrency;
  }

  /** Total requests processed since process start. */
  get totalProcessed() {
    return this._totalProcessed;
  }
}

// Singleton — one queue for the entire process
const localModelQueue = new LocalModelQueue();
export default localModelQueue;

// ============================================================
// LocalModelQueue — Process-level Async Mutex for Local GPU Models
// ============================================================
// Local inference servers (LM Studio, vLLM, Ollama, llama.cpp) can
// only serve one request at a time on a single GPU. This module
// provides a FIFO async mutex that serializes all local model
// requests across the entire Prism process — whether they originate
// from concurrent benchmark runs, chat requests, or any other path.
//
// Usage:
//   const release = await LocalModelQueue.acquire();
//   try { await doInference(); }
//   finally { release(); }

import logger from "../utils/logger.js";

// Providers that hit the local GPU
const LOCAL_PROVIDERS = new Set(["lm-studio", "vllm", "ollama", "llama-cpp"]);

class LocalModelQueue {
  constructor() {
    /** @type {Array<() => void>} FIFO queue of pending resolve callbacks */
    this._queue = [];
    /** Whether the lock is currently held */
    this._locked = false;
    /** Number of total requests processed (for logging) */
    this._totalProcessed = 0;
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
   * Acquire the mutex. Resolves immediately if unlocked, otherwise
   * enqueues and waits for its turn (FIFO order).
   *
   * @returns {Promise<() => void>} A release function — MUST be called
   *   when inference is complete (use try/finally).
   */
  acquire() {
    return new Promise((resolve) => {
      const release = () => {
        this._totalProcessed++;
        const next = this._queue.shift();
        if (next) {
          // Hand the lock to the next waiter
          next();
        } else {
          this._locked = false;
        }
      };

      if (!this._locked) {
        this._locked = true;
        resolve(release);
      } else {
        // Enqueue — will be resolved when a previous holder calls release()
        this._queue.push(() => resolve(release));
        logger.info(
          `[LocalModelQueue] Queued request (${this._queue.length} waiting)`,
        );
      }
    });
  }

  /** Number of requests currently waiting in the queue. */
  get pending() {
    return this._queue.length;
  }

  /** Whether the lock is currently held. */
  get busy() {
    return this._locked;
  }

  /** Total requests processed since process start. */
  get totalProcessed() {
    return this._totalProcessed;
  }
}

// Singleton — one queue for the entire process
const localModelQueue = new LocalModelQueue();
export default localModelQueue;

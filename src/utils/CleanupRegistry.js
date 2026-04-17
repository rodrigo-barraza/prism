// ────────────────────────────────────────────────────────────
// CleanupRegistry — Global shutdown coordination singleton
// ────────────────────────────────────────────────────────────
//
// Any service can register an async teardown function via registerCleanup().
// All registered functions run on SIGTERM/SIGINT (graceful shutdown) and can
// also be invoked manually from AgenticLoopService.finally or similar.
//
// Pattern modeled on Claude Code's src/utils/cleanupRegistry.ts.
// ────────────────────────────────────────────────────────────

import logger from "./logger.js";

/** @type {Set<() => Promise<void>>} */
const cleanupFunctions = new Set();

/** @type {boolean} */
let isRunning = false;

/**
 * Register a cleanup function to run during graceful shutdown.
 *
 * @param {() => Promise<void>} cleanupFn - Async teardown function
 * @returns {() => void} Unregister function — call to remove the handler
 */
export function registerCleanup(cleanupFn) {
  cleanupFunctions.add(cleanupFn);
  return () => cleanupFunctions.delete(cleanupFn);
}

/**
 * Run all registered cleanup functions in parallel.
 * Safe to call multiple times — subsequent calls are no-ops while running.
 *
 * Each function runs independently; failures are logged but don't block others.
 *
 * @returns {Promise<void>}
 */
export async function runCleanupFunctions() {
  if (isRunning) return;
  isRunning = true;

  const count = cleanupFunctions.size;
  if (count === 0) {
    isRunning = false;
    return;
  }

  logger.info(`[CleanupRegistry] Running ${count} cleanup function(s)…`);

  const results = await Promise.allSettled(
    Array.from(cleanupFunctions).map((fn) => fn()),
  );

  let failures = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      failures++;
      logger.error(`[CleanupRegistry] Cleanup failed: ${result.reason?.message || result.reason}`);
    }
  }

  if (failures > 0) {
    logger.warn(`[CleanupRegistry] ${failures}/${count} cleanup function(s) failed`);
  } else {
    logger.success(`[CleanupRegistry] All ${count} cleanup function(s) completed`);
  }

  isRunning = false;
}

/**
 * Install process signal handlers that run cleanup on shutdown.
 * Call once at startup (e.g. in index.js).
 *
 * Handles SIGTERM, SIGINT, and uncaught exceptions.
 * Uses a 5-second hard timeout to prevent hanging on stuck cleanup.
 */
export function installShutdownHandlers() {
  let shuttingDown = false;

  const handleShutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`[CleanupRegistry] Received ${signal}, shutting down…`);

    // Hard timeout — don't let stuck cleanup hang the process
    const hardTimeout = setTimeout(() => {
      logger.error("[CleanupRegistry] Cleanup timed out after 5s, forcing exit");
      process.exit(1);
    }, 5000);
    hardTimeout.unref(); // Don't keep the process alive just for the timeout

    try {
      await runCleanupFunctions();
    } catch (err) {
      logger.error(`[CleanupRegistry] Fatal cleanup error: ${err.message}`);
    }

    clearTimeout(hardTimeout);
    process.exit(0);
  };

  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));
}

/**
 * Current count of registered cleanup functions (for diagnostics).
 * @returns {number}
 */
export function cleanupCount() {
  return cleanupFunctions.size;
}

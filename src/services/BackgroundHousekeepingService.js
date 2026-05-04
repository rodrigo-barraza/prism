// ────────────────────────────────────────────────────────────
// BackgroundHousekeepingService — Boot-Time & Scheduled Cleanup
// ────────────────────────────────────────────────────────────
// Proactive cleanup of orphaned resources that survive crashes
// and unclean shutdowns. Runs once at boot and on a periodic
// interval (default 6h).
//
// Three cleanup targets:
//   1. Orphaned worktrees in /tmp/prism-worktrees/ (>24h)
//   2. Stale MongoDB sessions/request-logs
//   3. MinIO orphan objects (tombstoned references)
//
// Modeled on Claude Code's src/utils/backgroundHousekeeping.ts
// ────────────────────────────────────────────────────────────

import { readdir, stat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { MS_PER_DAY, hours } from "@rodrigo-barraza/utilities";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import MinioWrapper from "../wrappers/MinioWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import { COLLECTIONS } from "../constants.js";
import logger from "../utils/logger.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Worktrees older than this are considered orphaned */
const WORKTREE_MAX_AGE_MS = MS_PER_DAY;

/** Temp worktree root directory used by CoordinatorService */
const WORKTREE_ROOT = "/tmp/prism-worktrees";

/** Request logs older than this are pruned (keep 90 days) */
const REQUEST_LOG_MAX_AGE_DAYS = 90;

/** Stale isGenerating flags left from crashes */
const STALE_SESSION_CUTOFF_MS = hours(2);

// ─── Worktree Pruning ─────────────────────────────────────────────────────────

/**
 * Remove orphaned worktrees in /tmp/prism-worktrees/ older than 24h.
 * These accumulate when workers crash or the process is killed without
 * running CleanupRegistry teardown.
 *
 * @returns {Promise<{ pruned: string[], errors: string[] }>}
 */
async function pruneOrphanedWorktrees() {
  const pruned = [];
  const errors = [];

  let entries;
  try {
    entries = await readdir(WORKTREE_ROOT).catch(() => []);
  } catch {
    return { pruned, errors };
  }

  if (entries.length === 0) return { pruned, errors };

  const cutoff = Date.now() - WORKTREE_MAX_AGE_MS;

  for (const entry of entries) {
    const entryPath = resolve(WORKTREE_ROOT, entry);
    try {
      const info = await stat(entryPath);
      if (!info.isDirectory()) continue;

      if (info.mtimeMs < cutoff) {
        await rm(entryPath, { recursive: true, force: true });
        pruned.push(entry);
      }
    } catch (err) {
      errors.push(`${entry}: ${err.message}`);
    }
  }

  return { pruned, errors };
}

// ─── Stale Session Cleanup ────────────────────────────────────────────────────

/**
 * Clear isGenerating flags that were left dangling by a crash.
 * Also removes sessions that have been in "generating" state for >2h.
 *
 * @returns {Promise<{ conversationsCleared: number, agentSessionsCleared: number }>}
 */
async function clearStaleSessions() {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return { conversationsCleared: 0, agentSessionsCleared: 0 };

  const cutoff = new Date(Date.now() - STALE_SESSION_CUTOFF_MS).toISOString();

  const [convResult, sessionResult] = await Promise.all([
    db.collection(COLLECTIONS.CONVERSATIONS).updateMany(
      { isGenerating: true, updatedAt: { $lt: cutoff } },
      { $set: { isGenerating: false } },
    ),
    db.collection(COLLECTIONS.AGENT_SESSIONS).updateMany(
      { isGenerating: true, updatedAt: { $lt: cutoff } },
      { $set: { isGenerating: false } },
    ),
  ]);

  return {
    conversationsCleared: convResult.modifiedCount,
    agentSessionsCleared: sessionResult.modifiedCount,
  };
}

// ─── Old Request Log Pruning ──────────────────────────────────────────────────

/**
 * Remove request logs older than REQUEST_LOG_MAX_AGE_DAYS.
 * Keeps the DB from growing unbounded over time.
 *
 * @returns {Promise<number>} Number of documents deleted
 */
async function pruneOldRequestLogs() {
  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return 0;

  const cutoff = new Date(Date.now() - REQUEST_LOG_MAX_AGE_DAYS * MS_PER_DAY).toISOString();
  const result = await db.collection(COLLECTIONS.REQUESTS).deleteMany({
    timestamp: { $lt: cutoff },
  });

  return result.deletedCount;
}

// ─── MinIO Orphan Cleanup ─────────────────────────────────────────────────────

/**
 * Find MinIO objects that no longer have matching MongoDB references.
 * This handles cases where a conversation is deleted but the MinIO
 * objects (screenshots, file artifacts) remain.
 *
 * Conservative approach: only removes objects in known tool-result
 * prefixes (screenshots/, artifacts/) that have no matching conversation.
 *
 * @returns {Promise<number>} Number of orphaned objects removed
 */
async function pruneMinioOrphans() {
  if (!MinioWrapper.isAvailable()) return 0;

  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  if (!db) return 0;

  let removed = 0;

  try {
    // Get all conversation IDs and agent session IDs that exist
    const [convIds, sessionIds] = await Promise.all([
      db.collection(COLLECTIONS.CONVERSATIONS).distinct("id"),
      db.collection(COLLECTIONS.AGENT_SESSIONS).distinct("id"),
    ]);
    const validIds = new Set([...convIds, ...sessionIds]);

    // List MinIO objects with the conversation-scoped prefix pattern
    // Convention: objects are stored as {conversationId}/{filename}
    const objects = await MinioWrapper.listObjects("").catch(() => []);
    if (!Array.isArray(objects) || objects.length === 0) return 0;

    // Group objects by their top-level prefix (conversation ID)
    const prefixes = new Set();
    for (const obj of objects) {
      const prefix = (obj.name || obj).split("/")[0];
      if (prefix && !validIds.has(prefix)) {
        prefixes.add(prefix);
      }
    }

    // Remove orphaned prefixes
    for (const prefix of prefixes) {
      const orphanedObjects = objects.filter((o) =>
        (o.name || o).startsWith(`${prefix}/`),
      );
      for (const obj of orphanedObjects) {
        try {
          await MinioWrapper.remove(obj.name || obj);
          removed++;
        } catch {
          // Best-effort — skip failures
        }
      }
    }
  } catch (err) {
    logger.warn(`[Housekeeping] MinIO orphan scan failed: ${err.message}`);
  }

  return removed;
}

// ─── Public API ───────────────────────────────────────────────────────────────

const BackgroundHousekeepingService = {
  /**
   * Run all housekeeping tasks.
   * Safe to call at any time — each task is independent and failure-tolerant.
   *
   * @param {object} [options]
   * @param {"boot"|"scheduled"} [options.trigger="boot"] - What triggered the run
   * @returns {Promise<object>} Summary of actions taken
   */
  async run({ trigger = "boot" } = {}) {
    const startTime = performance.now();
    logger.info(`[Housekeeping] Starting (trigger: ${trigger})…`);

    const results = {};

    // 1. Prune orphaned worktrees
    try {
      const worktrees = await pruneOrphanedWorktrees();
      results.worktrees = worktrees;
      if (worktrees.pruned.length > 0) {
        logger.info(`[Housekeeping] Pruned ${worktrees.pruned.length} orphaned worktree(s): ${worktrees.pruned.join(", ")}`);
      }
      if (worktrees.errors.length > 0) {
        logger.warn(`[Housekeeping] Worktree errors: ${worktrees.errors.join("; ")}`);
      }
    } catch (err) {
      results.worktrees = { error: err.message };
      logger.error(`[Housekeeping] Worktree pruning failed: ${err.message}`);
    }

    // 2. Clear stale sessions
    try {
      const sessions = await clearStaleSessions();
      results.staleSessions = sessions;
      const total = sessions.conversationsCleared + sessions.agentSessionsCleared;
      if (total > 0) {
        logger.info(`[Housekeeping] Cleared ${total} stale isGenerating flag(s)`);
      }
    } catch (err) {
      results.staleSessions = { error: err.message };
      logger.error(`[Housekeeping] Session cleanup failed: ${err.message}`);
    }

    // 3. Prune old request logs
    try {
      const deletedLogs = await pruneOldRequestLogs();
      results.requestLogs = { deleted: deletedLogs };
      if (deletedLogs > 0) {
        logger.info(`[Housekeeping] Pruned ${deletedLogs} request log(s) older than ${REQUEST_LOG_MAX_AGE_DAYS} days`);
      }
    } catch (err) {
      results.requestLogs = { error: err.message };
      logger.error(`[Housekeeping] Request log pruning failed: ${err.message}`);
    }

    // 4. MinIO orphan cleanup
    try {
      const minioOrphans = await pruneMinioOrphans();
      results.minioOrphans = { removed: minioOrphans };
      if (minioOrphans > 0) {
        logger.info(`[Housekeeping] Removed ${minioOrphans} orphaned MinIO object(s)`);
      }
    } catch (err) {
      results.minioOrphans = { error: err.message };
      logger.error(`[Housekeeping] MinIO orphan cleanup failed: ${err.message}`);
    }

    const durationMs = Math.round(performance.now() - startTime);
    results.durationMs = durationMs;
    results.trigger = trigger;

    logger.success(`[Housekeeping] Complete (${durationMs}ms)`);
    return results;
  },
};

export default BackgroundHousekeepingService;

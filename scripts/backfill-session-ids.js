/**
 * Backfill sessionId on request documents.
 *
 * Problem:  Before sessionId was added to RequestLogger, request docs were
 *           written without a sessionId.  The admin /sessions pipeline joins
 *           requests → sessions via `requests.sessionId`, so older requests
 *           appear orphaned and sessions show up empty.
 *
 * Strategy:
 *   1. Build a lookup map:  conversationId → sessionId
 *      from `sessions.conversationIds` arrays.
 *   2. Find all requests that have a conversationId but NO sessionId.
 *   3. Bulk-update each request with the matching sessionId.
 *
 * Usage:  node scripts/backfill-session-ids.js [--dry-run]
 */

import { MongoClient } from "mongodb";
import { MONGO_URI, MONGO_DB_NAME } from "../secrets.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function run() {
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  🔧 Backfill sessionId on request documents`);
  console.log(`  Database: ${MONGO_DB_NAME}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE"}`);
  console.log(`═══════════════════════════════════════════════════════\n`);

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB_NAME);

  // ── Step 1: Build conversationId → sessionId map ──────────────
  const sessions = await db
    .collection("sessions")
    .find(
      { conversationIds: { $exists: true, $ne: [] } },
      { projection: { id: 1, conversationIds: 1 } }
    )
    .toArray();

  const convToSession = new Map();
  for (const session of sessions) {
    for (const convId of session.conversationIds) {
      convToSession.set(convId, session.id);
    }
  }

  console.log(`  📋 Sessions with conversations: ${sessions.length}`);
  console.log(`  📋 Conversation → Session mappings: ${convToSession.size}`);

  // ── Step 2: Find orphaned requests ────────────────────────────
  const orphanedRequests = await db
    .collection("requests")
    .find(
      {
        conversationId: { $ne: null },
        $or: [{ sessionId: null }, { sessionId: { $exists: false } }],
      },
      { projection: { _id: 1, conversationId: 1, timestamp: 1 } }
    )
    .toArray();

  console.log(`  📋 Requests missing sessionId: ${orphanedRequests.length}\n`);

  if (orphanedRequests.length === 0) {
    console.log("  ✅ Nothing to backfill — all requests already have sessionId.\n");
    await client.close();
    return;
  }

  // ── Step 3: Build bulk operations ─────────────────────────────
  const ops = [];
  let matched = 0;
  let unmatched = 0;

  for (const req of orphanedRequests) {
    const sessionId = convToSession.get(req.conversationId);
    if (sessionId) {
      matched++;
      ops.push({
        updateOne: {
          filter: { _id: req._id },
          update: { $set: { sessionId } },
        },
      });
    } else {
      unmatched++;
    }
  }

  console.log(`  🔗 Matched to a session: ${matched}`);
  console.log(`  ❌ No session found:     ${unmatched}`);

  if (ops.length === 0) {
    console.log("\n  ⚠️  No requests could be matched to a session.\n");
    await client.close();
    return;
  }

  // ── Step 4: Execute bulk write ────────────────────────────────
  if (DRY_RUN) {
    console.log(`\n  🏜️  DRY RUN — skipping ${ops.length} updates.\n`);
  } else {
    console.log(`\n  ⏳ Writing ${ops.length} updates...`);
    const result = await db.collection("requests").bulkWrite(ops, { ordered: false });
    console.log(`  ✅ Modified: ${result.modifiedCount}`);
    console.log(`     Matched:  ${result.matchedCount}\n`);
  }

  await client.close();
  console.log(`  Done.\n`);
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

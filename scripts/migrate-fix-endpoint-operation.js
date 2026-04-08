/**
 * Migration: Fix endpoint format (add leading slash) and ensure operation is populated.
 *
 * 1. Add leading "/" to endpoint values that don't have one (chat → /chat, agent → /agent, etc.)
 * 2. Set operation from endpoint for records where operation == endpoint (they need the non-slash version)
 *
 * Usage: node scripts/migrate-fix-endpoint-operation.js
 */
import { MongoClient } from "mongodb";
import { MONGO_DB_NAME, MONGO_URI } from "../secrets.js";

const REQUESTS_COL = "requests";

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB_NAME);
  const col = db.collection(REQUESTS_COL);

  console.log("Starting endpoint/operation fix migration...");

  // Endpoint values that need a leading slash
  const endpointMap = {
    chat: "/chat",
    agent: "/agent",
    live: "/live",
    embed: "/embed",
  };

  // Step 1: Fix endpoints without leading slash
  for (const [oldVal, newVal] of Object.entries(endpointMap)) {
    const result = await col.updateMany(
      { endpoint: oldVal },
      { $set: { endpoint: newVal } },
    );
    if (result.modifiedCount > 0) {
      console.log(`  endpoint "${oldVal}" → "${newVal}": ${result.modifiedCount} docs`);
    }
  }

  // Step 2: Set operation for records where it matches endpoint (was set by previous migration fallback)
  // These records have operation like "/chat" (with slash) because the first migration did operation=endpoint
  // They should have operation = "chat" (without slash)
  const slashedOps = await col.updateMany(
    { operation: { $regex: /^\// } },
    [
      {
        $set: {
          operation: { $substrBytes: ["$operation", 1, { $subtract: [{ $strLenBytes: "$operation" }, 1] }] },
        },
      },
    ],
  );
  if (slashedOps.modifiedCount > 0) {
    console.log(`  Removed leading slash from ${slashedOps.modifiedCount} operation values`);
  }

  // Step 3: Records that still have null/missing operation — set from endpoint minus slash
  const nullOps = await col.updateMany(
    { $or: [{ operation: null }, { operation: { $exists: false } }] },
    [
      {
        $set: {
          operation: {
            $cond: [
              { $and: [{ $ne: ["$endpoint", null] }, { $gt: [{ $strLenBytes: { $ifNull: ["$endpoint", ""] } }, 0] }] },
              {
                $cond: [
                  { $eq: [{ $substrBytes: [{ $ifNull: ["$endpoint", "x"] }, 0, 1] }, "/"] },
                  { $substrBytes: ["$endpoint", 1, { $subtract: [{ $strLenBytes: "$endpoint" }, 1] }] },
                  "$endpoint",
                ],
              },
              "unknown",
            ],
          },
        },
      },
    ],
  );
  if (nullOps.modifiedCount > 0) {
    console.log(`  Set operation from endpoint for ${nullOps.modifiedCount} null-operation docs`);
  }

  // Summary
  const sampleSlashed = await col.find({ endpoint: { $regex: /^\// } }).limit(3).project({ endpoint: 1, operation: 1, _id: 0 }).toArray();
  const sampleNull = await col.find({ endpoint: null }).limit(3).project({ endpoint: 1, operation: 1, _id: 0 }).toArray();
  console.log("\nSample records (slashed endpoints):", JSON.stringify(sampleSlashed));
  console.log("Sample records (null endpoints):", JSON.stringify(sampleNull));

  const noOp = await col.countDocuments({ $or: [{ operation: null }, { operation: { $exists: false } }] });
  const noSlash = await col.countDocuments({ endpoint: { $regex: /^[^/]/ } });
  console.log(`\nRemaining: ${noOp} without operation, ${noSlash} without leading slash`);

  await client.close();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

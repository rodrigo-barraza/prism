/**
 * Migration: Backfill `operation` field on existing request documents.
 *
 * Rules:
 * 1. Documents without `operation` get it set based on `endpoint`:
 *    - "chat" → "chat"
 *    - "agent" → "agent" (or "agent:iteration" if agenticIteration is set)
 *    - "live" → "live"
 *    - "embed:*" → operation = "embed:<source>", endpoint = null (for internal) or "embed" (for api)
 *    - null/undefined → defaults to endpoint value
 *
 * 2. Clean up the `embed:source` pattern from the endpoint field.
 *
 * Usage: node scripts/migrate-operation-field.js
 */
import { MongoClient } from "mongodb";
import { MONGO_DB_NAME, MONGO_URI } from "../secrets.js";

const REQUESTS_COL = "requests";

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB_NAME);
  const col = db.collection(REQUESTS_COL);

  console.log("Starting operation field migration...");

  // Count total documents to migrate
  const totalDocs = await col.countDocuments({ operation: { $exists: false } });
  console.log(`Found ${totalDocs} documents without operation field.`);

  if (totalDocs === 0) {
    console.log("Nothing to migrate. All documents already have an operation field.");
    await client.close();
    return;
  }

  // Step 1: Fix embed:* endpoint pattern → split into endpoint + operation
  const embedResult = await col.updateMany(
    {
      endpoint: { $regex: /^embed:/ },
      operation: { $exists: false },
    },
    [
      {
        $set: {
          operation: "$endpoint", // "embed:memory" → operation: "embed:memory"
          endpoint: {
            $cond: [
              { $eq: [{ $substrBytes: ["$endpoint", 6, 100] }, "api"] },
              "embed",  // embed:api → endpoint: "embed"
              null,     // embed:memory → endpoint: null (internal call)
            ],
          },
        },
      },
    ],
  );
  console.log(`Fixed embed:* pattern: ${embedResult.modifiedCount} documents.`);

  // Step 2: Backfill agent operations with agentic iteration tracking
  const agentIterResult = await col.updateMany(
    {
      endpoint: "agent",
      agenticIteration: { $exists: true, $ne: null },
      operation: { $exists: false },
    },
    { $set: { operation: "agent:iteration" } },
  );
  console.log(`Backfilled agent:iteration: ${agentIterResult.modifiedCount} documents.`);

  // Step 3: Backfill remaining documents — operation = endpoint
  const remainingResult = await col.updateMany(
    { operation: { $exists: false } },
    [
      {
        $set: {
          operation: { $ifNull: ["$endpoint", "unknown"] },
        },
      },
    ],
  );
  console.log(`Backfilled remaining: ${remainingResult.modifiedCount} documents.`);

  // Step 4: Create index on operation field for efficient filtering
  await col.createIndex({ operation: 1 });
  console.log("Created index on operation field.");

  // Summary
  const verifyCount = await col.countDocuments({ operation: { $exists: false } });
  console.log(`\nMigration complete. Documents without operation: ${verifyCount}`);

  await client.close();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

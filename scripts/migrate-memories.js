/**
 * migrate-memories.js — One-time migration script
 *
 * Splits the shared `memories` collection into:
 *   - `lupos_memories`  (Discord guild/user memories)
 *   - `agent_memories`  (project-scoped coding session memories)
 *
 * Usage:
 *   node scripts/migrate-memories.js
 *
 * The original `memories` collection is preserved as a backup.
 */
import { MongoClient } from "mongodb";
import { MONGO_URI, MONGO_DB_NAME } from "../secrets.js";

const SOURCE = "memories";
const LUPOS_TARGET = "lupos_memories";
const AGENT_TARGET = "agent_memories";

async function migrate() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB_NAME);

  const source = db.collection(SOURCE);
  const luposCol = db.collection(LUPOS_TARGET);
  const agentCol = db.collection(AGENT_TARGET);

  const allDocs = await source.find({}).toArray();
  console.log(`Found ${allDocs.length} documents in "${SOURCE}"`);

  let luposCount = 0;
  let agentCount = 0;
  let skipped = 0;

  for (const doc of allDocs) {
    // Remove the MongoDB _id so we get fresh insertions
    const { _id, ...data } = doc;

    const isLupos = !!data.guildId;
    const isAgent = !!data.project;

    if (isLupos) {
      await luposCol.insertOne(data);
      luposCount++;
    }

    if (isAgent) {
      await agentCol.insertOne(data);
      agentCount++;
    }

    if (!isLupos && !isAgent) {
      console.warn(`  ⚠️ Orphan document (no guildId or project): id=${data.id}`);
      skipped++;
    }
  }

  console.log(`\nMigration complete:`);
  console.log(`  → ${luposCount} docs → ${LUPOS_TARGET}`);
  console.log(`  → ${agentCount} docs → ${AGENT_TARGET}`);
  if (skipped) console.log(`  → ${skipped} orphan docs skipped`);
  console.log(`\nOriginal "${SOURCE}" collection preserved as backup.`);

  await client.close();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

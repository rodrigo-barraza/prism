#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// migrate-rename-projects.js
// ─────────────────────────────────────────────────────────────
// Renames legacy project identifiers across all relevant
// collections to align with the current naming convention.
//
// Mappings:
//   retina        → prism
//   retina-chat   → prism-chat
//   retina-agent  → prism-agent
//   retina-web    → prism-web
//   retina-console → prism-console
//
// Usage:
//   node scripts/migrate-rename-projects.js              # dry-run (shows counts)
//   node scripts/migrate-rename-projects.js --execute     # apply changes
//
// Safe to re-run — updateMany is idempotent.
// ─────────────────────────────────────────────────────────────

import { MongoClient } from "mongodb";

// ── Configuration ──────────────────────────────────────────────
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb://localhost:27017/?directConnection=true";
const DB_NAME =
  process.env.PRISM_SERVICE_MONGO_DB_NAME ||
  process.env.PRISM_MONGO_DB_NAME ||
  process.env.MONGO_DB_NAME ||
  "prism";

const EXECUTE = process.argv.includes("--execute");

// ── Rename Map ─────────────────────────────────────────────────
const RENAMES = {
  retina: "prism",
  "retina-chat": "prism-chat",
  "retina-agent": "prism-agent",
  "retina-web": "prism-web",
  "retina-console": "prism-console",
};

// Collections that have a `project` field
const COLLECTIONS = [
  "requests",
  "conversations",
  "agent_sessions",
  "workflows",
  "memories",
  "benchmarks",
  "benchmark_runs",
  "synthesis",
  "favorites",
  "custom_tools",
  "agent_skills",
  "mcp_servers",
  "settings",
  "custom_agents",
  "workspaces",
];

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  📋 Migrate — Rename Legacy Project Identifiers");
  console.log(`  Database: ${DB_NAME}`);
  console.log(`  Mode: ${EXECUTE ? "🔥 EXECUTE" : "👀 DRY RUN"}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log();

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DB_NAME);

  let totalMatched = 0;
  let totalModified = 0;

  for (const collName of COLLECTIONS) {
    // Check if collection exists
    const collections = await db
      .listCollections({ name: collName })
      .toArray();
    if (collections.length === 0) continue;

    const coll = db.collection(collName);

    for (const [oldName, newName] of Object.entries(RENAMES)) {
      const count = await coll.countDocuments({ project: oldName });
      if (count === 0) continue;

      totalMatched += count;

      if (EXECUTE) {
        const result = await coll.updateMany(
          { project: oldName },
          { $set: { project: newName } },
        );
        totalModified += result.modifiedCount;
        console.log(
          `  ✅ ${collName}: "${oldName}" → "${newName}" — ${result.modifiedCount} docs updated`,
        );
      } else {
        console.log(
          `  📊 ${collName}: "${oldName}" → "${newName}" — ${count} docs would be updated`,
        );
      }
    }
  }

  console.log();
  console.log("───────────────────────────────────────────────────────────");
  if (EXECUTE) {
    console.log(`  ✅ Done — ${totalModified} documents updated`);
  } else {
    console.log(`  📊 Dry run — ${totalMatched} documents would be updated`);
    if (totalMatched > 0) {
      console.log("  Run with --execute to apply changes.");
    }
  }
  console.log("───────────────────────────────────────────────────────────");

  await client.close();
}

main().catch((err) => {
  console.error("❌ Migration failed:", error.message);
  process.exit(1);
});

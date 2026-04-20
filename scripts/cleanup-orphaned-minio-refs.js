#!/usr/bin/env node
/**
 * Cleanup orphaned minio:// refs in MongoDB.
 *
 * Scans conversations, agent_sessions, and requests for minio:// refs,
 * checks if the object exists in MinIO, and removes refs that are orphaned.
 *
 * Usage:
 *   node scripts/cleanup-orphaned-minio-refs.js --dry-run
 *   node scripts/cleanup-orphaned-minio-refs.js
 */

import MongoWrapper from "../src/wrappers/MongoWrapper.js";
import MinioWrapper from "../src/wrappers/MinioWrapper.js";
import {
  MONGO_URI,
  MONGO_DB_NAME,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_BUCKET_NAME,
} from "../secrets.js";

const DRY_RUN = process.argv.includes("--dry-run");
const MINIO_PREFIX = "minio://";

async function objectExists(key) {
  try {
    await MinioWrapper.stat(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean orphaned minio:// refs from an array field (e.g. images).
 * Returns the cleaned array (refs removed) and count of removed refs.
 */
async function cleanArrayField(arr) {
  if (!Array.isArray(arr)) return { cleaned: arr, removed: 0 };
  const cleaned = [];
  let removed = 0;
  for (const item of arr) {
    if (typeof item === "string" && item.startsWith(MINIO_PREFIX)) {
      const key = item.replace(MINIO_PREFIX, "");
      if (await objectExists(key)) {
        cleaned.push(item);
      } else {
        removed++;
      }
    } else {
      cleaned.push(item);
    }
  }
  return { cleaned, removed };
}

/**
 * Clean orphaned minio:// ref from a single string field (e.g. audio).
 */
async function cleanStringField(value) {
  if (typeof value !== "string" || !value.startsWith(MINIO_PREFIX)) {
    return { cleaned: value, removed: 0 };
  }
  const key = value.replace(MINIO_PREFIX, "");
  if (await objectExists(key)) return { cleaned: value, removed: 0 };
  return { cleaned: null, removed: 1 };
}

async function cleanCollection(db, collectionName) {
  console.log(`\n── ${collectionName} ──`);

  const query = {
    $or: [
      { "messages.images": { $regex: "^minio://" } },
      { "messages.audio": { $regex: "^minio://" } },
    ],
  };
  const docs = await db.collection(collectionName).find(query).toArray();
  console.log(`  Found ${docs.length} documents with minio:// refs`);

  let totalRemoved = 0;
  let docsModified = 0;

  for (const doc of docs) {
    let docDirty = false;

    for (let i = 0; i < (doc.messages || []).length; i++) {
      const msg = doc.messages[i];

      // Clean images array
      if (Array.isArray(msg.images)) {
        const { cleaned, removed } = await cleanArrayField(msg.images);
        if (removed > 0) {
          doc.messages[i].images = cleaned;
          totalRemoved += removed;
          docDirty = true;
        }
      }

      // Clean audio string
      if (typeof msg.audio === "string" && msg.audio.startsWith(MINIO_PREFIX)) {
        const { cleaned, removed } = await cleanStringField(msg.audio);
        if (removed > 0) {
          doc.messages[i].audio = cleaned;
          totalRemoved += removed;
          docDirty = true;
        }
      }

      // Clean toolCalls screenshotRef
      if (Array.isArray(msg.toolCalls)) {
        for (let j = 0; j < msg.toolCalls.length; j++) {
          const ref = msg.toolCalls[j]?.result?.screenshotRef;
          if (typeof ref === "string" && ref.startsWith(MINIO_PREFIX)) {
            const { cleaned, removed } = await cleanStringField(ref);
            if (removed > 0) {
              doc.messages[i].toolCalls[j].result.screenshotRef = cleaned;
              totalRemoved += removed;
              docDirty = true;
            }
          }
        }
      }
    }

    if (docDirty) {
      docsModified++;
      const title = (doc.title || doc.id || doc._id).toString().slice(0, 50);
      console.log(`  ✂ ${title}`);
      if (!DRY_RUN) {
        await db.collection(collectionName).updateOne(
          { _id: doc._id },
          { $set: { messages: doc.messages } },
        );
      }
    }
  }

  console.log(`  ${totalRemoved} orphaned refs in ${docsModified} docs${DRY_RUN ? " (dry run)" : " — cleaned"}`);
  return totalRemoved;
}

async function cleanRequests(db) {
  console.log("\n── requests ──");

  const query = { "responsePayload.images": { $regex: "^minio://" } };
  const docs = await db.collection("requests").find(query).toArray();
  console.log(`  Found ${docs.length} requests with minio:// refs`);

  let totalRemoved = 0;
  let docsModified = 0;

  for (const doc of docs) {
    const images = doc.responsePayload?.images;
    if (!Array.isArray(images)) continue;

    const { cleaned, removed } = await cleanArrayField(images);
    if (removed > 0) {
      totalRemoved += removed;
      docsModified++;
      if (!DRY_RUN) {
        await db.collection("requests").updateOne(
          { _id: doc._id },
          { $set: { "responsePayload.images": cleaned } },
        );
      }
    }
  }

  console.log(`  ${totalRemoved} orphaned refs in ${docsModified} docs${DRY_RUN ? " (dry run)" : " — cleaned"}`);
  return totalRemoved;
}

async function main() {
  await MongoWrapper.createClient(MONGO_DB_NAME, MONGO_URI);
  await MinioWrapper.init(MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET_NAME);

  if (!MinioWrapper.isAvailable()) {
    console.error("❌ MinIO not available");
    process.exit(1);
  }

  const db = MongoWrapper.getDb(MONGO_DB_NAME);
  console.log(`\n🧹 Cleaning orphaned minio:// refs${DRY_RUN ? " (DRY RUN)" : ""}...\n`);

  let total = 0;
  total += await cleanCollection(db, "conversations");
  total += await cleanCollection(db, "agent_sessions");
  total += await cleanRequests(db);

  console.log(`\n✅ Total: ${total} orphaned refs removed${DRY_RUN ? " (dry run — no changes made)" : ""}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

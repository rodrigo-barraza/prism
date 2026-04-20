#!/usr/bin/env node
/**
 * Purge ALL media references from MongoDB.
 * Unlike wipe-minio-refs.js which only targets MinIO URLs,
 * this script removes ALL media (images, audio, video, pdf, screenshotRef)
 * from every relevant collection — total scorched earth.
 *
 * Collections cleaned:
 *   - conversations   (messages[].images → [], messages[].audio → null,
 *                       messages[].toolCalls[].result.screenshotRef → null)
 *   - agent_sessions  (same structure as conversations)
 *   - requests        (responsePayload.images → [])
 *   - workflows       (nodes media fields, nodeResults media)
 *
 * Usage:
 *   node scripts/purge-all-media.js --dry-run   # preview only
 *   node scripts/purge-all-media.js              # execute purge
 */

import { MongoClient } from "mongodb";
import { MONGO_URI, MONGO_DB_NAME } from "../secrets.js";

const DRY_RUN = process.argv.includes("--dry-run");

// ─── Conversations & Agent Sessions ──────────────────────────

async function purgeMessageMedia(db, collectionName) {
  console.log(`\n── ${collectionName} ──`);

  // Find docs with any media at all
  const query = {
    $or: [
      { "messages.images": { $exists: true, $ne: [] } },
      { "messages.audio": { $exists: true, $ne: null } },
      { "messages.toolCalls.result.screenshotRef": { $exists: true, $ne: null } },
    ],
  };

  const docs = await db.collection(collectionName).find(query).toArray();
  console.log(`  Found ${docs.length} documents with media`);

  let totalRemoved = 0;
  let docsModified = 0;

  for (const doc of docs) {
    let dirty = false;

    for (let i = 0; i < (doc.messages || []).length; i++) {
      const msg = doc.messages[i];

      // images array → empty
      if (Array.isArray(msg.images) && msg.images.length > 0) {
        totalRemoved += msg.images.length;
        doc.messages[i].images = [];
        dirty = true;
      }

      // audio → null
      if (msg.audio != null) {
        doc.messages[i].audio = null;
        totalRemoved++;
        dirty = true;
      }

      // toolCalls[].result.screenshotRef → null
      if (Array.isArray(msg.toolCalls)) {
        for (let j = 0; j < msg.toolCalls.length; j++) {
          const ref = msg.toolCalls[j]?.result?.screenshotRef;
          if (ref != null) {
            doc.messages[i].toolCalls[j].result.screenshotRef = null;
            totalRemoved++;
            dirty = true;
          }
        }
      }
    }

    if (dirty) {
      docsModified++;
      const label = (doc.title || doc.id || doc._id).toString().slice(0, 60);
      console.log(`  ✂ ${label}`);
      if (!DRY_RUN) {
        await db.collection(collectionName).updateOne(
          { _id: doc._id },
          { $set: { messages: doc.messages } },
        );
      }
    }
  }

  console.log(`  ${totalRemoved} media refs purged in ${docsModified} docs${DRY_RUN ? " (dry run)" : ""}`);
  return totalRemoved;
}

// ─── Requests ────────────────────────────────────────────────

async function purgeRequestMedia(db) {
  console.log("\n── requests ──");

  const query = { "responsePayload.images": { $exists: true, $ne: [] } };
  const docs = await db.collection("requests").find(query).toArray();
  console.log(`  Found ${docs.length} requests with media`);

  let totalRemoved = 0;
  let docsModified = 0;

  for (const doc of docs) {
    const images = doc.responsePayload?.images;
    if (!Array.isArray(images) || images.length === 0) continue;

    totalRemoved += images.length;
    docsModified++;
    if (!DRY_RUN) {
      await db.collection("requests").updateOne(
        { _id: doc._id },
        { $set: { "responsePayload.images": [] } },
      );
    }
  }

  console.log(`  ${totalRemoved} media refs purged in ${docsModified} docs${DRY_RUN ? " (dry run)" : ""}`);
  return totalRemoved;
}

// ─── Workflows ───────────────────────────────────────────────

const MEDIA_FIELDS = ["images", "audio", "video", "pdf"];

async function purgeWorkflowMedia(db) {
  console.log("\n── workflows ──");

  const allWorkflows = await db.collection("workflows").find({}).toArray();
  let totalRemoved = 0;
  let docsModified = 0;

  for (const doc of allWorkflows) {
    let dirty = false;

    if (Array.isArray(doc.nodes)) {
      for (let i = 0; i < doc.nodes.length; i++) {
        const node = doc.nodes[i];

        // nodes[].messages[].{images,audio,video,pdf}
        if (Array.isArray(node.messages)) {
          for (let m = 0; m < node.messages.length; m++) {
            const msg = node.messages[m];
            for (const field of MEDIA_FIELDS) {
              const val = msg[field];
              if (Array.isArray(val) && val.length > 0) {
                totalRemoved += val.length;
                doc.nodes[i].messages[m][field] = [];
                dirty = true;
              } else if (val != null && typeof val === "string") {
                doc.nodes[i].messages[m][field] = null;
                totalRemoved++;
                dirty = true;
              }
            }
          }
        }

        // nodes[].receivedOutputs
        if (node.receivedOutputs && typeof node.receivedOutputs === "object") {
          for (const [mod, data] of Object.entries(node.receivedOutputs)) {
            if (data != null && typeof data === "string") {
              doc.nodes[i].receivedOutputs[mod] = null;
              totalRemoved++;
              dirty = true;
            }
          }
        }
      }
    }

    // nodeResults
    if (doc.nodeResults && typeof doc.nodeResults === "object") {
      for (const [nodeId, outputs] of Object.entries(doc.nodeResults)) {
        if (!outputs || typeof outputs !== "object") continue;
        for (const [mod, data] of Object.entries(outputs)) {
          if (mod === "conversation" && Array.isArray(data)) {
            for (let m = 0; m < data.length; m++) {
              const msg = data[m];
              for (const field of MEDIA_FIELDS) {
                const val = msg[field];
                if (Array.isArray(val) && val.length > 0) {
                  totalRemoved += val.length;
                  doc.nodeResults[nodeId][mod][m][field] = [];
                  dirty = true;
                } else if (val != null && typeof val === "string") {
                  doc.nodeResults[nodeId][mod][m][field] = null;
                  totalRemoved++;
                  dirty = true;
                }
              }
            }
          } else if (data != null && typeof data === "string" && MEDIA_FIELDS.includes(mod)) {
            doc.nodeResults[nodeId][mod] = null;
            totalRemoved++;
            dirty = true;
          }
        }
      }
    }

    if (dirty) {
      docsModified++;
      const label = (doc.name || doc.workflowId || doc._id).toString().slice(0, 60);
      console.log(`  ✂ ${label}`);
      if (!DRY_RUN) {
        const $set = { nodes: doc.nodes };
        if (doc.nodeResults) $set.nodeResults = doc.nodeResults;
        await db.collection("workflows").updateOne(
          { _id: doc._id },
          { $set },
        );
      }
    }
  }

  console.log(`  ${totalRemoved} media refs purged in ${docsModified} docs${DRY_RUN ? " (dry run)" : ""}`);
  return totalRemoved;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB_NAME);

  console.log(`\n🔥 Purging ALL media${DRY_RUN ? " (DRY RUN)" : ""}...\n`);

  let total = 0;
  total += await purgeMessageMedia(db, "conversations");
  total += await purgeMessageMedia(db, "agent_sessions");
  total += await purgeRequestMedia(db);
  total += await purgeWorkflowMedia(db);

  console.log(`\n✅ Total: ${total} media refs purged${DRY_RUN ? " (dry run — no changes made)" : ""}`);

  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Wipe ALL minio:// refs AND resolved HTTP MinIO URLs from MongoDB
 * after a MinIO data purge.
 *
 * Matches both patterns:
 *   - minio://...                              (internal protocol refs)
 *   - https://prism.rod.dev/files/...   (resolved HTTP URLs)
 *
 * Collections cleaned:
 *   - conversations   (messages[].images[], messages[].audio, messages[].toolCalls[].result.screenshotRef)
 *   - agent_sessions  (same message structure as conversations)
 *   - requests        (responsePayload.images[])
 *   - workflows       (nodes[].content, nodes[].messages[].{images,audio,video,pdf},
 *                       nodes[].receivedOutputs.*, nodeResults.*.*)
 *
 * Usage:
 *   node scripts/wipe-minio-refs.js --dry-run   # preview only
 *   node scripts/wipe-minio-refs.js              # execute wipe
 */

import { MongoClient } from "mongodb";
import { MONGO_URI, MONGO_DB_NAME } from "../secrets.js";

const DRY_RUN = process.argv.includes("--dry-run");

/** Matches both minio:// protocol refs and resolved HTTP MinIO file URLs. */
const MINIO_PATTERNS = [
  /^minio:\/\//,
  /^https?:\/\/prism\.rod\.dev\/files\//,
];

/** MongoDB $regex string matching either pattern. */
const MONGO_MINIO_RE = "^(minio://|https?://prism\\.rod\\.dev/files/)";

// ─── Helpers ──────────────────────────────────────────────────

function isMinioRef(val) {
  return typeof val === "string" && MINIO_PATTERNS.some((re) => re.test(val));
}

/** Strip minio refs from an array, returning cleaned array and removal count. */
function stripArrayRefs(arr) {
  if (!Array.isArray(arr)) return { cleaned: arr, removed: 0 };
  let removed = 0;
  const cleaned = arr.filter((v) => {
    if (isMinioRef(v)) { removed++; return false; }
    return true;
  });
  return { cleaned, removed };
}

// ─── Conversations & Agent Sessions ───────────────────────────

async function cleanMessageCollection(db, collectionName) {
  console.log(`\n── ${collectionName} ──`);

  const query = {
    $or: [
      { "messages.images": { $regex: MONGO_MINIO_RE } },
      { "messages.audio": { $regex: MONGO_MINIO_RE } },
      { "messages.toolCalls.result.screenshotRef": { $regex: MONGO_MINIO_RE } },
    ],
  };

  const docs = await db.collection(collectionName).find(query).toArray();
  console.log(`  Found ${docs.length} documents with minio:// refs`);

  let totalRemoved = 0;
  let docsModified = 0;

  for (const doc of docs) {
    let dirty = false;

    for (let i = 0; i < (doc.messages || []).length; i++) {
      const msg = doc.messages[i];

      // images array — remove minio entries
      if (Array.isArray(msg.images)) {
        const { cleaned, removed } = stripArrayRefs(msg.images);
        if (removed > 0) {
          doc.messages[i].images = cleaned;
          totalRemoved += removed;
          dirty = true;
        }
      }

      // audio string — null it out
      if (isMinioRef(msg.audio)) {
        doc.messages[i].audio = null;
        totalRemoved++;
        dirty = true;
      }

      // toolCalls[].result.screenshotRef — null it out
      if (Array.isArray(msg.toolCalls)) {
        for (let j = 0; j < msg.toolCalls.length; j++) {
          const ref = msg.toolCalls[j]?.result?.screenshotRef;
          if (isMinioRef(ref)) {
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

  console.log(`  ${totalRemoved} refs wiped in ${docsModified} docs${DRY_RUN ? " (dry run)" : ""}`);
  return totalRemoved;
}

// ─── Requests ─────────────────────────────────────────────────

async function cleanRequests(db) {
  console.log("\n── requests ──");

  const query = { "responsePayload.images": { $regex: MONGO_MINIO_RE } };
  const docs = await db.collection("requests").find(query).toArray();
  console.log(`  Found ${docs.length} requests with minio:// refs`);

  let totalRemoved = 0;
  let docsModified = 0;

  for (const doc of docs) {
    const images = doc.responsePayload?.images;
    if (!Array.isArray(images)) continue;

    const { cleaned, removed } = stripArrayRefs(images);
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

  console.log(`  ${totalRemoved} refs wiped in ${docsModified} docs${DRY_RUN ? " (dry run)" : ""}`);
  return totalRemoved;
}

// ─── Workflows ────────────────────────────────────────────────

const MEDIA_FIELDS = ["images", "audio", "video", "pdf"];

async function cleanWorkflows(db) {
  console.log("\n── workflows ──");

  // Match any document that has a minio:// ref anywhere inside it
  const query = {
    $or: [
      { "nodes.content": { $regex: MONGO_MINIO_RE } },
      ...MEDIA_FIELDS.flatMap((f) => [
        { [`nodes.messages.${f}`]: { $regex: MONGO_MINIO_RE } },
      ]),
      // receivedOutputs and nodeResults are dynamic-keyed objects;
      // fall back to a text search via $where for thoroughness
    ],
  };

  const docs = await db.collection("workflows").find(query).toArray();

  // Also grab docs where nodeResults or receivedOutputs contain minio refs
  // (dynamic keys can't be queried with dot-notation)
  const allWorkflows = await db.collection("workflows").find({}).toArray();
  const extraIds = new Set(docs.map((d) => d._id.toString()));
  for (const wf of allWorkflows) {
    if (extraIds.has(wf._id.toString())) continue;
    const json = JSON.stringify(wf);
    if (json.includes("minio://") || json.includes("prism.rod.dev/files/")) {
      docs.push(wf);
      extraIds.add(wf._id.toString());
    }
  }

  console.log(`  Found ${docs.length} workflows with minio:// refs`);

  let totalRemoved = 0;
  let docsModified = 0;

  for (const doc of docs) {
    let dirty = false;

    // 1. nodes[].content
    if (Array.isArray(doc.nodes)) {
      for (let i = 0; i < doc.nodes.length; i++) {
        const node = doc.nodes[i];

        if (isMinioRef(node.content)) {
          doc.nodes[i].content = "";
          totalRemoved++;
          dirty = true;
        }

        // 2. nodes[].messages[].{images,audio,video,pdf}
        if (Array.isArray(node.messages)) {
          for (let m = 0; m < node.messages.length; m++) {
            const msg = node.messages[m];
            for (const field of MEDIA_FIELDS) {
              const val = msg[field];
              if (Array.isArray(val)) {
                const { cleaned, removed } = stripArrayRefs(val);
                if (removed > 0) {
                  doc.nodes[i].messages[m][field] = cleaned;
                  totalRemoved += removed;
                  dirty = true;
                }
              } else if (isMinioRef(val)) {
                doc.nodes[i].messages[m][field] = null;
                totalRemoved++;
                dirty = true;
              }
            }
          }
        }

        // 3. nodes[].receivedOutputs
        if (node.receivedOutputs && typeof node.receivedOutputs === "object") {
          for (const [mod, data] of Object.entries(node.receivedOutputs)) {
            if (isMinioRef(data)) {
              doc.nodes[i].receivedOutputs[mod] = null;
              totalRemoved++;
              dirty = true;
            }
          }
        }
      }
    }

    // 4. nodeResults: { [nodeId]: { [modality]: value | messagesArray } }
    if (doc.nodeResults && typeof doc.nodeResults === "object") {
      for (const [nodeId, outputs] of Object.entries(doc.nodeResults)) {
        if (!outputs || typeof outputs !== "object") continue;
        for (const [mod, data] of Object.entries(outputs)) {
          if (mod === "conversation" && Array.isArray(data)) {
            for (let m = 0; m < data.length; m++) {
              const msg = data[m];
              for (const field of MEDIA_FIELDS) {
                const val = msg[field];
                if (Array.isArray(val)) {
                  const { cleaned, removed } = stripArrayRefs(val);
                  if (removed > 0) {
                    doc.nodeResults[nodeId][mod][m][field] = cleaned;
                    totalRemoved += removed;
                    dirty = true;
                  }
                } else if (isMinioRef(val)) {
                  doc.nodeResults[nodeId][mod][m][field] = null;
                  totalRemoved++;
                  dirty = true;
                }
              }
            }
          } else if (isMinioRef(data)) {
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

  console.log(`  ${totalRemoved} refs wiped in ${docsModified} docs${DRY_RUN ? " (dry run)" : ""}`);
  return totalRemoved;
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB_NAME);

  console.log(`\n🗑️  Wiping ALL minio:// refs${DRY_RUN ? " (DRY RUN)" : ""}...\n`);

  let total = 0;
  total += await cleanMessageCollection(db, "conversations");
  total += await cleanMessageCollection(db, "agent_sessions");
  total += await cleanRequests(db);
  total += await cleanWorkflows(db);

  console.log(`\n✅ Total: ${total} minio:// refs wiped${DRY_RUN ? " (dry run — no changes made)" : ""}`);

  await client.close();
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});

// Quick MongoDB query to inspect the most recent agent session's requests
import { MongoClient } from "mongodb";
import { MONGO_URI, MONGO_DB_NAME } from "../secrets.js";
import { COLLECTIONS } from "../src/constants.js";

const client = new MongoClient(MONGO_URI);
await client.connect();
const db = client.db(MONGO_DB_NAME);

// Find the most recent session
const sessions = await db.collection(COLLECTIONS.AGENT_SESSIONS)
  .find()
  .sort({ updatedAt: -1 })
  .limit(1)
  .toArray();

if (!sessions.length) {
  console.log("No sessions found");
  process.exit(1);
}

const session = sessions[0];
// The session's `id` field is the UUID used as agentSessionId in requests
const sid = session.id || session._id;
console.log(`Session _id: ${session._id}`);
console.log(`Session id:  ${session.id}`);
console.log(`Title: ${(session.title || "?").substring(0, 80)}`);
console.log(`Project: ${session.project}`);
console.log(`Username: ${session.username}`);
console.log();

// Discover all descendant session IDs (same traversal as agent-sessions.js)
const allSessionIds = new Set([sid]);
let frontier = [sid];
for (let depth = 0; depth < 10 && frontier.length > 0; depth++) {
  const childIds = await db.collection(COLLECTIONS.REQUESTS)
    .distinct("agentSessionId", {
      parentAgentSessionId: { $in: frontier },
      agentSessionId: { $nin: [...allSessionIds] },
    });
  if (childIds.length === 0) break;
  const newIds = childIds.filter(Boolean);
  for (const id of newIds) allSessionIds.add(id);
  frontier = newIds;
}

console.log(`Total session IDs: ${allSessionIds.size} (main + ${allSessionIds.size - 1} workers)`);
if (allSessionIds.size > 1) {
  console.log(`Worker IDs: ${[...allSessionIds].filter(id => id !== sid).join(", ")}`);
}
console.log();

// Get all requests
const requests = await db.collection(COLLECTIONS.REQUESTS)
  .find({ agentSessionId: { $in: [...allSessionIds] } })
  .sort({ timestamp: 1 })
  .toArray();

console.log(`${"=".repeat(130)}`);
console.log(`  All ${requests.length} requests for session`);
console.log(`${"=".repeat(130)}`);

for (let i = 0; i < requests.length; i++) {
  const r = requests[i];
  const op = (r.operation || r.endpoint || "?").padEnd(25);
  const model = (r.model || "?").substring(0, 30).padEnd(30);
  const inp = (r.inputTokens || 0);
  const out = (r.outputTokens || 0);
  const ts = r.timestamp || "?";
  const isWorker = r.agentSessionId !== sid;
  const marker = isWorker ? " [WORKER]" : "";
  console.log(`  ${String(i + 1).padStart(2)}. ${op} | ${model} | in:${String(inp).padStart(8)} out:${String(out).padStart(8)}${marker}  ${ts}`);
}

// Summary by operation
const byOp = {};
for (const r of requests) {
  const op = r.operation || r.endpoint || "?";
  const isWorker = r.agentSessionId !== sid;
  const key = `${op}${isWorker ? " [WORKER]" : ""}`;
  if (!byOp[key]) byOp[key] = { count: 0, inputTokens: 0, outputTokens: 0 };
  byOp[key].count++;
  byOp[key].inputTokens += r.inputTokens || 0;
  byOp[key].outputTokens += r.outputTokens || 0;
}

console.log(`\n${"=".repeat(80)}`);
console.log("  Summary by operation");
console.log(`${"=".repeat(80)}`);
for (const [op, data] of Object.entries(byOp).sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${op.padEnd(40)} | ${String(data.count).padStart(3)} requests | in:${String(data.inputTokens).padStart(10)} out:${String(data.outputTokens).padStart(10)}`);
}

await client.close();

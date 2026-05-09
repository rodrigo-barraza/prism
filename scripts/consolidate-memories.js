#!/usr/bin/env node
/**
 * consolidate-memories.js — On-demand memory consolidation CLI
 *
 * Triggers memory consolidation via the running Prism service.
 * Uses Node's built-in fetch (no dependencies).
 *
 * Usage:
 *   node scripts/consolidate-memories.js                         # default: CODING agent, "default" project
 *   node scripts/consolidate-memories.js --agent=CODING          # specify agent
 *   node scripts/consolidate-memories.js --project=prism         # specify project
 *   node scripts/consolidate-memories.js --agent=LUPOS --guildId=123456  # conversational agent
 *   node scripts/consolidate-memories.js --history               # view consolidation history
 *   node scripts/consolidate-memories.js --dry-run               # show what would be processed (list memories without running LLM)
 *
 * npm script:
 *   npm run consolidate
 *   npm run consolidate -- --agent=LUPOS --guildId=123456
 */

const PRISM_URL = process.env.PRISM_URL || "http://localhost:7777";

// ─── Argument Parsing ────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {
    agent: "CODING",
    project: null,
    guildId: null,
    history: false,
    dryRun: false,
    limit: 10,
  };

  for (const arg of args) {
    if (arg === "--history") {
      parsed.history = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg.startsWith("--agent=")) {
      parsed.agent = arg.split("=")[1];
    } else if (arg.startsWith("--project=")) {
      parsed.project = arg.split("=")[1];
    } else if (arg.startsWith("--guildId=")) {
      parsed.guildId = arg.split("=")[1];
    } else if (arg.startsWith("--limit=")) {
      parsed.limit = parseInt(arg.split("=")[1]) || 10;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return parsed;
}

function printHelp() {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║         🧠 Memory Consolidation CLI                      ║
╚═══════════════════════════════════════════════════════════╝

Usage:
  node scripts/consolidate-memories.js [options]

Options:
  --agent=<name>       Agent identifier (default: CODING)
  --project=<name>     Project scope (default: from Prism header)
  --guildId=<id>       Discord guild ID (for conversational agents)
  --history            View consolidation run history instead of running
  --dry-run            Preview: list memories and clusters without running LLM
  --limit=<n>          History entries to show (default: 10)
  --help, -h           Show this help

Examples:
  node scripts/consolidate-memories.js
  node scripts/consolidate-memories.js --agent=CODING --project=prism
  node scripts/consolidate-memories.js --agent=LUPOS --guildId=123456789
  node scripts/consolidate-memories.js --history --project=prism
  node scripts/consolidate-memories.js --dry-run

Environment:
  PRISM_URL            Prism service base URL (default: http://localhost:7777)
`);
}

// ─── Formatting Helpers ──────────────────────────────────────────────────────
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

function header(text) {
  console.log(`\n${BOLD}${CYAN}═══ ${text} ═══${RESET}`);
}

function kvLine(key, value) {
  console.log(`  ${DIM}${key}:${RESET} ${value}`);
}

// ─── API Calls ───────────────────────────────────────────────────────────────
async function runConsolidation(opts) {
  const url = `${PRISM_URL}/agent-memories/consolidate`;
  const body = {
    agent: opts.agent,
    username: "cli",
  };
  if (opts.guildId) body.guildId = opts.guildId;

  const headers = { "Content-Type": "application/json" };
  if (opts.project) headers["x-project"] = opts.project;

  header("Running Memory Consolidation");
  kvLine("Agent", opts.agent);
  kvLine("Project", opts.project || "(default)");
  if (opts.guildId) kvLine("Guild ID", opts.guildId);
  console.log(`  ${DIM}Calling ${url}...${RESET}\n`);

  const start = performance.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`${RED}✗ HTTP ${res.status}: ${text}${RESET}`);
    process.exit(1);
  }

  const result = await res.json();
  const elapsed = Math.round(performance.now() - start);

  if (result.skipped) {
    console.log(`${YELLOW}⊘ Skipped:${RESET} ${result.reason}`);
    kvLine("Total memories", result.total ?? "—");
  } else {
    console.log(`${GREEN}✓ Consolidation complete${RESET}`);
    kvLine("Actions applied", result.actionsApplied ?? 0);
    kvLine("Merged", result.merged ?? 0);
    kvLine("Deleted", result.deleted ?? 0);
    kvLine("Errors", result.errors ?? 0);
    kvLine("Batches", result.batchCount ?? 0);
    kvLine("Total memories", result.total ?? "—");
    kvLine("Duration (server)", `${result.durationMs ?? "—"}ms`);
    if (result.summary) {
      console.log(`\n  ${MAGENTA}${result.summary}${RESET}`);
    }
  }
  console.log(`  ${DIM}CLI round-trip: ${elapsed}ms${RESET}\n`);
}

async function viewHistory(opts) {
  const params = new URLSearchParams({ limit: String(opts.limit) });
  if (opts.project) params.set("project", opts.project);

  const url = `${PRISM_URL}/agent-memories/consolidation-history?${params}`;
  const headers = {};
  if (opts.project) headers["x-project"] = opts.project;

  header("Consolidation History");
  const res = await fetch(url, { headers });

  if (!res.ok) {
    const text = await res.text();
    console.error(`${RED}✗ HTTP ${res.status}: ${text}${RESET}`);
    process.exit(1);
  }

  const { history } = await res.json();

  if (!history || history.length === 0) {
    console.log(`  ${DIM}No consolidation history found.${RESET}\n`);
    return;
  }

  for (const entry of history) {
    const date = entry.runAt ? new Date(entry.runAt).toLocaleString() : "—";
    console.log(`\n  ${BOLD}${date}${RESET}  ${DIM}(${entry.trigger})${RESET}`);
    kvLine("  Memories", `${entry.memoriesBefore} → ${entry.memoriesAfter}`);
    kvLine("  Actions", entry.actionsApplied);
    kvLine("  Duration", `${entry.durationMs ?? "—"}ms`);
    if (entry.summary) {
      console.log(`    ${MAGENTA}${entry.summary}${RESET}`);
    }
  }
  console.log();
}

async function dryRun(opts) {
  const params = new URLSearchParams({ limit: "500" });
  if (opts.agent) params.set("agent", opts.agent);

  const headers = {};
  if (opts.project) headers["x-project"] = opts.project;

  const url = `${PRISM_URL}/agent-memories?${params}`;

  header("Dry Run — Memory Preview");
  kvLine("Agent", opts.agent);
  kvLine("Project", opts.project || "(default)");
  console.log();

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const text = await res.text();
    console.error(`${RED}✗ HTTP ${res.status}: ${text}${RESET}`);
    process.exit(1);
  }

  const data = await res.json();
  const memories = data.memories || data;
  const count = Array.isArray(memories) ? memories.length : data.total ?? 0;

  console.log(`  ${BOLD}${count}${RESET} memories found\n`);

  if (Array.isArray(memories)) {
    // Group by type
    const byType = {};
    for (const m of memories) {
      const t = m.type || "unknown";
      if (!byType[t]) byType[t] = [];
      byType[t].push(m);
    }

    for (const [type, items] of Object.entries(byType).sort()) {
      console.log(`  ${CYAN}${type}${RESET} (${items.length})`);
      for (const m of items.slice(0, 5)) {
        const title = m.title || m.content?.substring(0, 80) || "—";
        const age = m.createdAt
          ? `${Math.round((Date.now() - new Date(m.createdAt).getTime()) / 86400000)}d ago`
          : "";
        console.log(`    ${DIM}•${RESET} ${title}  ${DIM}${age}${RESET}`);
      }
      if (items.length > 5) {
        console.log(`    ${DIM}... and ${items.length - 5} more${RESET}`);
      }
    }
  }

  console.log(`\n  ${DIM}Run without --dry-run to execute consolidation.${RESET}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();

  try {
    if (opts.history) {
      await viewHistory(opts);
    } else if (opts.dryRun) {
      await dryRun(opts);
    } else {
      await runConsolidation(opts);
    }
  } catch (err) {
    if (err.cause?.code === "ECONNREFUSED") {
      console.error(`${RED}✗ Cannot connect to Prism at ${PRISM_URL}${RESET}`);
      console.error(`  ${DIM}Is the service running? (npm run dev)${RESET}`);
    } else {
      console.error(`${RED}✗ ${err.message}${RESET}`);
    }
    process.exit(1);
  }
}

main();

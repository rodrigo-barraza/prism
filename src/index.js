import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";

import { errorHandler } from "./utils/errors.js";
import logger from "./utils/logger.js";
import { listProviders } from "./providers/index.js";
import { TYPES } from "./config.js";
import { setupWebSocket } from "./websocket/index.js";
import { authMiddleware } from "./middleware/AuthMiddleware.js";
import { requestLoggerMiddleware } from "./middleware/RequestLoggerMiddleware.js";
import {
  PRISM_SERVICE_PORT as PORT,
  MONGO_URI,
  MONGO_DB_NAME,
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_BUCKET_NAME,
} from "../secrets.js";
import MongoWrapper from "./wrappers/MongoWrapper.js";
import MinioWrapper from "./wrappers/MinioWrapper.js";
import ChangeStreamService from "./services/ChangeStreamService.js";
import MemoryConsolidationService from "./services/MemoryConsolidationService.js";
import BackgroundHousekeepingService from "./services/BackgroundHousekeepingService.js";
import { installShutdownHandlers } from "./utils/CleanupRegistry.js";

// Install process-level shutdown handlers (SIGTERM, SIGINT → runCleanupFunctions)
installShutdownHandlers();

// Routes
import chatRouter from "./routes/chat.js";
import agentRouter from "./routes/agent.js";
import audioRouter from "./routes/audio.js";
import embedRouter from "./routes/embed.js";
import configRouter, { localConfigRouter } from "./routes/config.js";
import conversationsRouter from "./routes/conversations.js";
import filesRouter from "./routes/files.js";
import memoryRouter from "./routes/memory.js";
import MemoryService from "./services/MemoryService.js";
import adminRouter from "./routes/admin.js";
import workflowsRouter from "./routes/workflows.js";
import mediaRouter from "./routes/media.js";
import textRouter from "./routes/text.js";
import lmStudioRouter from "./routes/lm-studio.js";
import customToolsRouter from "./routes/custom-tools.js";
import skillsRouter from "./routes/skills.js";
import agentMemoriesRouter from "./routes/agent-memories.js";
import mcpServersRouter from "./routes/mcp-servers.js";
import favoritesRouter from "./routes/favorites.js";
import agentSessionsRouter from "./routes/agent-sessions.js";

import statsRouter from "./routes/stats.js";
import benchmarkRouter from "./routes/benchmark.js";
import synthesisRouter from "./routes/synthesis.js";
import vramBenchmarksRouter from "./routes/vram-benchmarks.js";
import coordinatorRouter from "./routes/coordinator.js";
import settingsRouter from "./routes/settings.js";
import customAgentsRouter from "./routes/custom-agents.js";
import workspacesRouter from "./routes/workspaces.js";

const app = express();
const server = http.createServer(app);

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(requestLoggerMiddleware);

// Endpoint registry (single source of truth for health check + startup logs)
const ENDPOINTS = {
  rest: [
    "/config",
    "/config-local",
    "/chat",
    "/agent",
    "/text-to-audio",
    "/audio-to-text",
    "/embed",
    "/conversations",
    "/memory",
    "/files",
    "/workflows",
    "/media",
    "/text",
    "/lm-studio",
    "/custom-tools",
    "/skills",
    "/agent-memories",
    "/mcp-servers",
    "/favorites",
    "/agent-sessions",

    "/stats",
    "/benchmark",
    "/synthesis",
    "/vram-benchmarks",
    "/coordinator",
    "/settings",
    "/custom-agents",
    "/workspaces",
  ],
  websocket: ["/ws/chat", "/ws/text-to-audio"],
  admin: ["/admin", "/admin/lm-studio"],
};

// Health check (public — no auth required)
app.get("/", (_req, res) => {
  res.json({
    name: "Prism the AI Gateway",
    version: "1.0.0",
    providers: listProviders(),
    endpoints: ENDPOINTS,
  });
});

// Health check (public — standard path for Docker, load balancers, portal)
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Admin routes
app.use("/admin", adminRouter);

// Public routes (no auth required)
app.use("/files", filesRouter);

// Extract project / username / clientIp from headers for downstream tracking
app.use(authMiddleware);

// REST routes
app.use("/config", configRouter);
app.use("/config-local", localConfigRouter);
app.use("/chat", chatRouter);
app.use("/agent", agentRouter);
app.use("/text-to-audio", audioRouter);
app.use("/audio-to-text", audioRouter);
app.use("/embed", embedRouter);
app.use("/conversations", conversationsRouter);
app.use("/memory", memoryRouter);
app.use("/workflows", workflowsRouter);
app.use("/media", mediaRouter);
app.use("/text", textRouter);
app.use("/lm-studio", lmStudioRouter);
app.use("/custom-tools", customToolsRouter);
app.use("/skills", skillsRouter);
app.use("/agent-memories", agentMemoriesRouter);
app.use("/mcp-servers", mcpServersRouter);
app.use("/favorites", favoritesRouter);
app.use("/agent-sessions", agentSessionsRouter);

app.use("/stats", statsRouter);
app.use("/benchmark", benchmarkRouter);
app.use("/synthesis", synthesisRouter);
app.use("/vram-benchmarks", vramBenchmarksRouter);
app.use("/coordinator", coordinatorRouter);
app.use("/settings", settingsRouter);
app.use("/custom-agents", customAgentsRouter);
app.use("/workspaces", workspacesRouter);

// Error handler (must be last)
app.use(errorHandler);

// WebSocket server
const wss = new WebSocketServer({ server });
setupWebSocket(wss);

// Start
(async () => {
  await MongoWrapper.createClient(MONGO_DB_NAME, MONGO_URI);
  await MemoryService.ensureIndexes();

  // ── Ensure collection indexes ──────────────────────────────────
  // Critical for $lookup aggregation performance (conversations ↔ requests).
  // Without these, $lookup does full collection scans per document.
  try {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (db) {
      await Promise.all([
        // requests — used by $lookup from conversations and session joins
        db.collection("requests").createIndex({ conversationId: 1 }),
        db.collection("requests").createIndex({ traceId: 1 }),
        db.collection("requests").createIndex({ timestamp: -1 }),
        db.collection("requests").createIndex({ project: 1, timestamp: -1 }),
        // conversations — used by findOne lookups and list queries
        db.collection("conversations").createIndex({ id: 1 }, { unique: true }),
        db.collection("conversations").createIndex({ updatedAt: -1 }),
        db.collection("conversations").createIndex({ project: 1, username: 1, updatedAt: -1 }),
        db.collection("conversations").createIndex({ traceId: 1 }),

        // agent_sessions — same indexes as conversations
        db.collection("agent_sessions").createIndex({ id: 1 }, { unique: true }),
        db.collection("agent_sessions").createIndex({ updatedAt: -1 }),
        db.collection("agent_sessions").createIndex({ project: 1, username: 1, updatedAt: -1 }),

        // workflows — used by conversationIds lookup
        db.collection("workflows").createIndex({ id: 1 }, { unique: true }),
        // benchmarks
        db.collection("benchmarks").createIndex({ id: 1 }, { unique: true }),
        db.collection("benchmarks").createIndex({ project: 1, updatedAt: -1 }),
        db.collection("benchmark_runs").createIndex({ id: 1 }, { unique: true }),
        db.collection("benchmark_runs").createIndex({ benchmarkId: 1, project: 1, startedAt: -1 }),
        // synthesis
        db.collection("synthesis").createIndex({ id: 1 }, { unique: true }),
        db.collection("synthesis").createIndex({ project: 1, username: 1, updatedAt: -1 }),
        // agent_skills
        db.collection("agent_skills").createIndex({ project: 1, username: 1 }),
        // mcp_servers
        db.collection("mcp_servers").createIndex({ project: 1, username: 1 }),
        // workspaces
        db.collection("workspaces").createIndex({ project: 1, username: 1 }),
        db.collection("workspaces").createIndex({ id: 1 }, { unique: true }),
      ]);
      logger.success("Database indexes ensured");
    }
  } catch (err) {
    logger.error(`Failed to ensure indexes: ${err.message}`);
  }

  // Clear any stale isGenerating flags left over from a previous crash/restart
  try {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (db) {
      const { modifiedCount } = await db
        .collection("conversations")
        .updateMany({ isGenerating: true }, { $set: { isGenerating: false } });
      if (modifiedCount > 0) {
        logger.info(`Cleared ${modifiedCount} stale isGenerating flag(s) in conversations`);
      }
      // Also clear in agent_sessions
      const { modifiedCount: agentCleared } = await db
        .collection("agent_sessions")
        .updateMany({ isGenerating: true }, { $set: { isGenerating: false } });
      if (agentCleared > 0) {
        logger.info(`Cleared ${agentCleared} stale isGenerating flag(s) in agent_sessions`);
      }
    }
  } catch (err) {
    logger.error(`Failed to clear stale isGenerating flags: ${err.message}`);
  }

  // ── One-time migration: conversations → agent_sessions ──────────
  // Move any existing agent project conversations to the new collection.
  try {
    const { default: AgentPersonaRegistry } = await import("./services/AgentPersonaRegistry.js");
    const agentProjects = AgentPersonaRegistry.list().map((p) => {
      const persona = AgentPersonaRegistry.get(p.id);
      return persona?.project;
    }).filter(Boolean);

    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (db && agentProjects.length > 0) {
      const agentConvs = await db.collection("conversations")
        .find({ project: { $in: agentProjects } })
        .toArray();
      if (agentConvs.length > 0) {
        // Strip _id to avoid duplicate key errors on insert
        const docs = agentConvs.map(({ _id, ...rest }) => rest);
        await db.collection("agent_sessions").insertMany(docs, { ordered: false }).catch(() => {});
        await db.collection("conversations").deleteMany({ project: { $in: agentProjects } });
        logger.info(`Migrated ${agentConvs.length} agent conversation(s) → agent_sessions`);
      }
    }
  } catch (err) {
    logger.error(`Agent session migration failed: ${err.message}`);
  }

  // Load custom agents from database into the persona registry
  try {
    const { default: AgentPersonaRegistryCustom } = await import("./services/AgentPersonaRegistry.js");
    await AgentPersonaRegistryCustom.loadCustomAgents();
  } catch (err) {
    logger.warn(`Custom agent loading failed: ${err.message}`);
  }

  // Initialize Change Streams (requires replica set — graceful fallback)
  await ChangeStreamService.init();

  // Auto-connect enabled MCP servers
  try {
    const { default: MCPClientService } = await import("./services/MCPClientService.js");
    const { default: AgentPersonaRegistryMCP } = await import("./services/AgentPersonaRegistry.js");
    const mcpDb = MongoWrapper.getDb(MONGO_DB_NAME);
    const codingProject = AgentPersonaRegistryMCP.get("CODING")?.project || "coding";
    if (mcpDb) {
      await MCPClientService.connectAllFromDB(mcpDb, codingProject, "admin");
    }
  } catch (err) {
    logger.warn(`MCP auto-connect failed: ${err.message}`);
  }

  // ── Scheduled Memory Consolidation ─────────────────
  // Runs every 6 hours, consolidates memories for all active projects.
  const CONSOLIDATION_INTERVAL_MS = 6 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      const db = MongoWrapper.getDb(MONGO_DB_NAME);
      if (!db) return;

      // Find all distinct projects with at least some memories
      const projects = await db.collection("memories").distinct("project");

      for (const project of projects) {
        const count = await db.collection("memories").countDocuments({ project });
        if (count < 10) continue; // Skip projects with few memories

        logger.info(`[AutoDream] Scheduled consolidation for project "${project}" (${count} memories)`);
        MemoryConsolidationService.consolidate({
          project,
          username: "system",
          trigger: "scheduled",
        }).catch((err) =>
          logger.error(`[AutoDream] Scheduled consolidation failed for "${project}": ${err.message}`),
        );
      }
    } catch (err) {
      logger.error(`[AutoDream] Scheduled consolidation sweep failed: ${err.message}`);
    }
  }, CONSOLIDATION_INTERVAL_MS);
  logger.info(`[AutoDream] Scheduled consolidation every ${CONSOLIDATION_INTERVAL_MS / 3_600_000}h`);

  // ── Background Housekeeping ────────────────────────────────
  // Boot-time run: clean up orphans from previous crashes
  BackgroundHousekeepingService.run({ trigger: "boot" }).catch((err) =>
    logger.error(`[Housekeeping] Boot-time run failed: ${err.message}`),
  );

  // Scheduled run: every 6h (piggybacking on the consolidation interval)
  setInterval(() => {
    BackgroundHousekeepingService.run({ trigger: "scheduled" }).catch((err) =>
      logger.error(`[Housekeeping] Scheduled run failed: ${err.message}`),
    );
  }, CONSOLIDATION_INTERVAL_MS);
  logger.info(`[Housekeeping] Scheduled cleanup every ${CONSOLIDATION_INTERVAL_MS / 3_600_000}h`);

  // Initialize MinIO if all secrets are configured
  if (
    MINIO_ENDPOINT &&
    MINIO_ACCESS_KEY &&
    MINIO_SECRET_KEY &&
    MINIO_BUCKET_NAME
  ) {
    await MinioWrapper.init(
      MINIO_ENDPOINT,
      MINIO_ACCESS_KEY,
      MINIO_SECRET_KEY,
      MINIO_BUCKET_NAME,
    );
  } else {
    logger.info(
      "MinIO not configured — files will be stored inline in MongoDB",
    );
  }

  server.listen(PORT, () => {
    logger.success(`Prism the AI Gateway is running on port ${PORT}`);
    logger.info("Available providers:", listProviders().join(", "));
    // Modality colors matching Retina's MODALITY_COLORS
    const MODALITY_COLORS = {
      text: [99, 102, 241], // #6366f1 — indigo
      image: [16, 185, 129], // #10b981 — emerald
      audio: [245, 158, 11], // #f59e0b — amber
      video: [244, 63, 94], // #f43f5e — rose
      pdf: [100, 116, 139], // #64748b — slate
      embedding: [6, 182, 212], // #06b6d4 — cyan
    };
    const coloredModalities = Object.values(TYPES)
      .map((t) => {
        const [r, g, b] = MODALITY_COLORS[t] || [255, 255, 255];
        return `\x1b[38;2;${r};${g};${b}m${t}\x1b[0m`;
      })
      .join(", ");
    logger.info("Available modalities:", coloredModalities);
    ENDPOINTS.rest.forEach((ep) =>
      logger.info(`  REST  →  http://localhost:${PORT}${ep}`),
    );
    ENDPOINTS.websocket.forEach((ep) =>
      logger.info(`  WS    →  ws://localhost:${PORT}${ep}`),
    );
  });
})();

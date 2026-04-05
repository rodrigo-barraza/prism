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
  PORT,
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

// Routes
import chatRouter from "./routes/chat.js";
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
import favoritesRouter from "./routes/favorites.js";
import sessionsRouter from "./routes/sessions.js";
import statsRouter from "./routes/stats.js";
import benchmarkRouter from "./routes/benchmark.js";
import synthesisRouter from "./routes/synthesis.js";

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
    "/favorites",
    "/sessions",
    "/stats",
    "/benchmark",
    "/synthesis",
  ],
  websocket: ["/ws/chat", "/ws/text-to-audio"],
  admin: ["/admin", "/admin/lm-studio", "/admin/sessions"],
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
app.use("/favorites", favoritesRouter);
app.use("/sessions", sessionsRouter);
app.use("/stats", statsRouter);
app.use("/benchmark", benchmarkRouter);
app.use("/synthesis", synthesisRouter);

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
    const db = MongoWrapper.getClient(MONGO_DB_NAME)?.db(MONGO_DB_NAME);
    if (db) {
      await Promise.all([
        // requests — used by $lookup from conversations and session joins
        db.collection("requests").createIndex({ conversationId: 1 }),
        db.collection("requests").createIndex({ timestamp: -1 }),
        db.collection("requests").createIndex({ project: 1, timestamp: -1 }),
        // conversations — used by findOne lookups and list queries
        db.collection("conversations").createIndex({ id: 1 }, { unique: true }),
        db.collection("conversations").createIndex({ updatedAt: -1 }),
        db.collection("conversations").createIndex({ project: 1, username: 1, updatedAt: -1 }),
        db.collection("conversations").createIndex({ sessionId: 1 }),
        // sessions — used by findOne and list queries
        db.collection("sessions").createIndex({ id: 1 }, { unique: true }),
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
      ]);
      logger.success("Database indexes ensured");
    }
  } catch (err) {
    logger.error(`Failed to ensure indexes: ${err.message}`);
  }

  // Clear any stale isGenerating flags left over from a previous crash/restart
  try {
    const db = MongoWrapper.getClient(MONGO_DB_NAME)?.db(MONGO_DB_NAME);
    if (db) {
      const { modifiedCount } = await db
        .collection("conversations")
        .updateMany({ isGenerating: true }, { $set: { isGenerating: false } });
      if (modifiedCount > 0) {
        logger.info(`Cleared ${modifiedCount} stale isGenerating flag(s)`);
      }
    }
  } catch (err) {
    logger.error(`Failed to clear stale isGenerating flags: ${err.message}`);
  }

  // Initialize Change Streams (requires replica set — graceful fallback)
  await ChangeStreamService.init();

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

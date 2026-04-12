import express from "express";
import MemoryService from "../services/MemoryService.js";
import MemoryConsolidationService from "../services/MemoryConsolidationService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * POST /agent-memories
 * Create a new memory via MemoryService.store() (embedding + dedup).
 * Called by tools-api's upsert_memory route.
 */
router.post("/", async (req, res, next) => {
  try {
    const { agent, project, username, content, type, title, agentSessionId } = req.body;
    if (!content) {
      return res.status(400).json({ error: "content is required" });
    }

    const result = await MemoryService.store({
      agent: agent || "CODING",
      project: project || "default",
      username: username || null,
      content,
      type: type || "project",
      title: title || null,
      sessionId: agentSessionId || null,
      endpoint: "/agent-memories",
    });

    if (!result) {
      // Duplicate detected
      return res.json({ duplicate: true, message: "Near-duplicate memory already exists" });
    }

    // Strip embedding from response (large vector, not needed by caller)
    const { embedding: _emb, ...safe } = result;
    res.json(safe);
  } catch (error) {
    logger.error(`[agent-memories] POST ${error.message}`);
    next(error);
  }
});

/**
 * GET /agent-memories?project=<project>&agent=<agent>&limit=100&skip=0
 * List all agent memories for a project (read-only).
 * Defaults to agent="CODING" for backward compatibility.
 */
router.get("/", async (req, res, next) => {
  try {
    const project = req.query.project || req.project || "default";
    const agent = req.query.agent || "CODING";
    const limit = parseInt(req.query.limit) || 100;
    const skip = parseInt(req.query.skip) || 0;

    const result = await MemoryService.list({ agent, project, limit, skip });
    res.json(result);
  } catch (error) {
    logger.error(`[agent-memories] ${error.message}`);
    next(error);
  }
});

/**
 * DELETE /agent-memories/:id
 * Delete a specific agent memory.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const deleted = await MemoryService.remove(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Memory not found" });
    }
    res.json({ success: true });
  } catch (error) {
    logger.error(`[agent-memories] DELETE ${error.message}`);
    next(error);
  }
});

/**
 * GET /agent-memories/consolidation-history?project=<project>&limit=10
 * Retrieve consolidation run history for a project.
 */
router.get("/consolidation-history", async (req, res, next) => {
  try {
    const project = req.query.project || req.project || "default";
    const limit = parseInt(req.query.limit) || 10;

    const history = await MemoryConsolidationService.getHistory(project, limit);
    res.json({ history });
  } catch (error) {
    logger.error(`[agent-memories] HISTORY ${error.message}`);
    next(error);
  }
});

/**
 * POST /agent-memories/consolidate
 * Trigger on-demand memory consolidation for a project.
 */
router.post("/consolidate", async (req, res, next) => {
  try {
    const project = req.body.project || req.query.project || "default";
    const agent = req.body.agent || "CODING";
    const username = req.body.username || "system";

    const result = await MemoryConsolidationService.consolidate({
      agent,
      project,
      username,
      trigger: "manual",
      endpoint: "/agent-memories/consolidate",
    });
    res.json(result);
  } catch (error) {
    logger.error(`[agent-memories] CONSOLIDATE ${error.message}`);
    next(error);
  }
});

export default router;

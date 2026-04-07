import express from "express";
import AgentMemoryService from "../services/AgentMemoryService.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * GET /agent-memories?project=<project>&limit=100&skip=0
 * List all agent memories for a project (read-only).
 */
router.get("/", async (req, res, next) => {
  try {
    const project = req.query.project || req.project || "default";
    const limit = parseInt(req.query.limit) || 100;
    const skip = parseInt(req.query.skip) || 0;

    const result = await AgentMemoryService.list({ project, limit, skip });
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
    const deleted = await AgentMemoryService.remove(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Memory not found" });
    }
    res.json({ success: true });
  } catch (error) {
    logger.error(`[agent-memories] DELETE ${error.message}`);
    next(error);
  }
});

export default router;

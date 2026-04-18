import express from "express";
import CustomAgentService from "../services/CustomAgentService.js";
import AgentPersonaRegistry from "../services/AgentPersonaRegistry.js";
import logger from "../utils/logger.js";

const router = express.Router();

/**
 * GET /custom-agents
 * List all custom agents.
 */
router.get("/", async (_req, res, next) => {
  try {
    const agents = await CustomAgentService.list();
    res.json(agents);
  } catch (err) {
    logger.error(`GET /custom-agents error: ${err.message}`);
    next(err);
  }
});

/**
 * POST /custom-agents
 * Create a new custom agent and register it in the persona registry.
 */
router.post("/", async (req, res, next) => {
  try {
    const data = req.body;
    if (!data?.name?.trim()) {
      return res.status(400).json({ error: "Agent name is required" });
    }

    const created = await CustomAgentService.create(data);

    // Register into live persona registry
    AgentPersonaRegistry.registerCustom(created);

    res.status(201).json(created);
  } catch (err) {
    if (err.message?.includes("already exists")) {
      return res.status(409).json({ error: err.message });
    }
    logger.error(`POST /custom-agents error: ${err.message}`);
    next(err);
  }
});

/**
 * PUT /custom-agents/:id
 * Update an existing custom agent and refresh its persona registration.
 */
router.put("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    if (!updates || typeof updates !== "object") {
      return res.status(400).json({ error: "Request body must be an object" });
    }

    // Get the old doc to unregister the old agentId if name changed
    const oldDoc = await CustomAgentService.get(id);
    if (!oldDoc) {
      return res.status(404).json({ error: "Agent not found" });
    }

    const updated = await CustomAgentService.update(id, updates);

    // Unregister old ID if it changed, then register new
    if (oldDoc.agentId !== updated.agentId) {
      AgentPersonaRegistry.unregister(oldDoc.agentId);
    }
    AgentPersonaRegistry.registerCustom(updated);

    res.json(updated);
  } catch (err) {
    logger.error(`PUT /custom-agents/:id error: ${err.message}`);
    next(err);
  }
});

/**
 * DELETE /custom-agents/:id
 * Delete a custom agent and unregister it from the persona registry.
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get the doc first so we know the agentId to unregister
    const doc = await CustomAgentService.get(id);
    if (!doc) {
      return res.status(404).json({ error: "Agent not found" });
    }

    await CustomAgentService.delete(id);
    AgentPersonaRegistry.unregister(doc.agentId);

    res.json({ success: true });
  } catch (err) {
    logger.error(`DELETE /custom-agents/:id error: ${err.message}`);
    next(err);
  }
});

export default router;

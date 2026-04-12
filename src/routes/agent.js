import express from "express";
import AgenticLoopService from "../services/AgenticLoopService.js";
import { handleAgent } from "./chat.js";
import logger from "../utils/logger.js";
import {
  handleSseRequest,
  handleJsonRequest,
} from "../utils/SseUtilities.js";

const router = express.Router();

// ============================================================
// Approval endpoint — resolves pending plan/tool approvals
// ============================================================

/**
 * POST /agent/approve
 *
 * Body:
 *   { agentSessionId: string, approved: boolean }
 *
 * Resolves the pending approval promise in AgenticLoopService
 * so the agentic loop can continue (or abort).
 */
router.post("/approve", async (req, res) => {
  const { agentSessionId, approved, approveAll } = req.body;

  if (!agentSessionId) {
    return res.status(400).json({ error: "Missing agentSessionId" });
  }

  const resolved = AgenticLoopService.resolveApproval(
    agentSessionId,
    approved !== false,
    { approveAll: approveAll === true },
  );

  if (!resolved) {
    return res.status(404).json({
      error: "No pending approval for this agent session",
      agentSessionId,
    });
  }

  logger.info(
    `[agent/approve] ${approved !== false ? "Approved" : "Rejected"}${approveAll ? " (all future)" : ""} for session ${agentSessionId}`,
  );

  res.json({ ok: true, approved: approved !== false });
});

// ============================================================
// REST endpoint — SSE streaming or JSON fallback
// ============================================================

/**
 * POST /agent
 *
 * Agentic endpoint — always enables function calling and the
 * AgenticLoopService tool-execution loop. Use this for autonomous
 * agent workflows; use /chat for simple LLM calls.
 *
 * Default:       SSE streaming (text/event-stream)
 * ?stream=false: Plain JSON response (for server-to-server callers)
 *
 * Body (flat, OpenAI-style):
 *   { provider, model?, messages, enabledTools?, temperature?, maxTokens?, ... }
 */
router.post("/", async (req, res, next) => {
  // Force agentic mode — the entire point of this endpoint
  const params = {
    ...req.body,
    functionCallingEnabled: true,
    agenticLoopEnabled: true,
    project: req.body.project || req.project,
    username: req.username,
    clientIp: req.clientIp,
    agent: req.body.agent || req.agent || null,
  };

  if (req.query.stream !== "false") {
    await handleSseRequest(req, res, params, handleAgent);
  } else {
    await handleJsonRequest(req, res, next, params, handleAgent);
  }
});

export default router;

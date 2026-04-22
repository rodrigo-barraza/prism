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
// Answer endpoint — resolves pending ask_user_question pauses
// ============================================================

/**
 * POST /agent/answer
 *
 * Body:
 *   { agentSessionId: string, answer: string }
 *
 * Resolves the pending question promise in AgenticLoopService
 * so the agentic loop can continue with the user's answer.
 */
router.post("/answer", async (req, res) => {
  const { agentSessionId, answer } = req.body;

  if (!agentSessionId) {
    return res.status(400).json({ error: "Missing agentSessionId" });
  }
  if (answer === undefined || answer === null) {
    return res.status(400).json({ error: "Missing answer" });
  }

  const resolved = AgenticLoopService.resolveUserQuestion(
    agentSessionId,
    String(answer),
  );

  if (!resolved) {
    return res.status(404).json({
      error: "No pending question for this agent session",
      agentSessionId,
    });
  }

  logger.info(`[agent/answer] Answered for session ${agentSessionId}: "${String(answer).slice(0, 80)}"`);

  res.json({ ok: true });
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
    project: req.project,
    username: req.username,
    clientIp: req.clientIp,
    agent: req.body.agent || req.agent || null,
    // Multi-workspace: override the default workspace root when the user has
    // selected a non-default workspace in the Retina sidebar. Sources:
    //   1. x-workspace-root header (set by Retina's serviceHeaders.js)
    //   2. body.workspaceRoot (for server-to-server / API callers)
    workspaceRoot: req.workspaceRoot || req.body.workspaceRoot || null,
  };

  if (req.query.stream !== "false") {
    await handleSseRequest(req, res, params, handleAgent);
  } else {
    await handleJsonRequest(req, res, next, params, handleAgent);
  }
});

export default router;

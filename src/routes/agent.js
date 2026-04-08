import express from "express";
import { handleChat } from "./chat.js";
import { ProviderError } from "../utils/errors.js";
import AgenticLoopService from "../services/AgenticLoopService.js";
import logger from "../utils/logger.js";

const router = express.Router();

// ============================================================
// Approval endpoint — resolves pending plan/tool approvals
// ============================================================

/**
 * POST /agent/approve
 *
 * Body:
 *   { conversationId: string, approved: boolean }
 *
 * Resolves the pending approval promise in AgenticLoopService
 * so the agentic loop can continue (or abort).
 */
router.post("/approve", async (req, res) => {
  const { conversationId, approved, approveAll } = req.body;

  if (!conversationId) {
    return res.status(400).json({ error: "Missing conversationId" });
  }

  const resolved = AgenticLoopService.resolveApproval(
    conversationId,
    approved !== false,
    { approveAll: approveAll === true },
  );

  if (!resolved) {
    return res.status(404).json({
      error: "No pending approval for this conversation",
      conversationId,
    });
  }

  logger.info(
    `[agent/approve] ${approved !== false ? "Approved" : "Rejected"}${approveAll ? " (all future)" : ""} for conversation ${conversationId}`,
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
  const wantsStream = req.query.stream !== "false";

  // Force agentic mode — the entire point of this endpoint
  const params = {
    ...req.body,
    functionCallingEnabled: true,
    agenticLoopEnabled: true,
    project: req.body.project || req.project,
    username: req.username,
    clientIp: req.clientIp,
  };

  if (wantsStream) {
    // SSE streaming response
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Abort upstream provider when client disconnects (not on normal completion)
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });

    await handleChat(
      params,
      (event) => {
        if (!controller.signal.aborted) {
          // Strip heavy base64 data from image events when minioRef is
          // available — SSE/browser clients load images via the ref URL.
          if (event.type === "image" && event.minioRef && event.data) {
            const { data: _stripped, ...lightweight } = event;
            res.write(`data: ${JSON.stringify(lightweight)}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }
        }
      },
      { signal: controller.signal },
    );
    if (!controller.signal.aborted) res.end();
  } else {
    // Non-streaming JSON response (for lupos and other server callers)
    const events = [];
    await handleChat(params, (event) => events.push(event));

    // Build a flat response from collected events
    const errorEvent = events.find((e) => e.type === "error");
    if (errorEvent) {
      return next(new ProviderError("server", errorEvent.message, 500));
    }

    const doneEvent = events.find((e) => e.type === "done") || {};
    const text = events
      .filter((e) => e.type === "chunk")
      .map((e) => e.content)
      .join("");
    const thinking = events
      .filter((e) => e.type === "thinking")
      .map((e) => e.content)
      .join("");
    const images = events
      .filter((e) => e.type === "image")
      .map((e) => ({
        data: e.data,
        mimeType: e.mimeType,
        minioRef: e.minioRef || null,
      }));

    const toolCalls = events
      .filter((e) => e.type === "tool_execution" && e.status === "calling")
      .map((e) => ({
        name: e.tool?.name,
        args: e.tool?.args,
      }));

    res.json({
      text: text || null,
      thinking: thinking || null,
      images: images.length > 0 ? images : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      // provider/model echoed back — useful when Prism resolves a default model
      provider: doneEvent.provider || req.body.provider,
      model: doneEvent.model || req.body.model,
      usage: doneEvent.usage || null,
      estimatedCost: doneEvent.estimatedCost ?? null,
      ...(doneEvent.sessionId && { sessionId: doneEvent.sessionId }),
      ...(doneEvent.conversationId && { conversationId: doneEvent.conversationId }),
    });
  }
});

export default router;

import { handleConversation } from "../routes/chat.js";
import { ProviderError } from "./errors.js";

// ============================================================
// SSE streaming utilities — shared by /chat and /agent routes
// ============================================================

/**
 * Configure an Express response for SSE (Server-Sent Events) streaming.
 * Sets the required headers and flushes them immediately.
 *
 * @param {import("express").Response} res
 */
export function initSseResponse(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

/**
 * Create an SSE emit callback that writes events to the response.
 * Strips heavy base64 data from image events when minioRef is available.
 *
 * @param {import("express").Response} res
 * @param {AbortSignal} signal
 * @returns {(event: object) => void}
 */
export function createSseEmitter(res, signal) {
  return (event) => {
    if (!signal.aborted) {
      if (event.type === "image" && event.minioRef && event.data) {
        const { data: _stripped, ...lightweight } = event;
        res.write(`data: ${JSON.stringify(lightweight)}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    }
  };
}

/**
 * Build a flat JSON response from collected SSE events.
 * Used by non-streaming callers (?stream=false).
 *
 * @param {Array<object>} events   - Collected events from handleChat
 * @param {object}        reqBody  - The original request body (for fallback provider/model)
 * @returns {{ error?: object, response?: object }}
 */
export function buildJsonResponseFromEvents(events, reqBody) {
  const errorEvent = events.find((e) => e.type === "error");
  if (errorEvent) {
    return { error: new ProviderError("server", errorEvent.message, 500) };
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

  return {
    response: {
      text: text || null,
      thinking: thinking || null,
      images: images.length > 0 ? images : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      provider: doneEvent.provider || reqBody.provider,
      model: doneEvent.model || reqBody.model,
      usage: doneEvent.usage || null,
      estimatedCost: doneEvent.estimatedCost ?? null,
      ...(doneEvent.traceId && { traceId: doneEvent.traceId }),
      ...(doneEvent.conversationId && { conversationId: doneEvent.conversationId }),
    },
  };
}

/**
 * Handle a full SSE streaming request lifecycle.
 * Sets up SSE headers, AbortController, runs the handler, and closes.
 *
 * @param {import("express").Request}  req
 * @param {import("express").Response} res
 * @param {object}                     params  - Parameters to pass to the handler
 * @param {Function}                   [handler] - Generation handler (default: handleConversation)
 */
export async function handleSseRequest(req, res, params, handler = handleConversation) {
  initSseResponse(res);

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  await handler(
    params,
    createSseEmitter(res, controller.signal),
    { signal: controller.signal },
  );

  if (!controller.signal.aborted) res.end();
}

/**
 * Handle a non-streaming JSON request lifecycle.
 * Collects events from the handler and returns a flat JSON response.
 *
 * @param {import("express").Request}  req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @param {object}                     params  - Parameters to pass to the handler
 * @param {Function}                   [handler] - Generation handler (default: handleConversation)
 */
export async function handleJsonRequest(req, res, next, params, handler = handleConversation) {
  const events = [];
  await handler(params, (event) => events.push(event));

  const { error, response } = buildJsonResponseFromEvents(events, req.body);
  if (error) return next(error);

  res.json(response);
}

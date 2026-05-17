import { handleConversation } from "../routes/ChatRoutes.js";
import { ProviderError } from "./errors.js";
import { createAbortController } from "./AbortController.js";

// ─── shared by /chat and /agent routes ──────────────────────

/**
 * Configure an Express response for SSE (Server-Sent Events) streaming.
 * Sets the required headers and flushes them immediately.
 *

 */
export function initSseResponse(res: any) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

/**
 * Create an SSE emit callback that writes events to the response.
 * Strips heavy base64 data from image events when minioRef is available.
 *


 */
export function createSseEmitter(res: any, signal: any) {
  // Disable Nagle's algorithm for minimal SSE latency.
  // Without this, small SSE events can sit in the TCP buffer when
  // the server blocks on await (e.g. plan approval promise).
  if (res.socket) res.socket.setNoDelay(true);

  return (event: any) => {
    if (!signal.aborted) {
      if (event.type === "image" && event.minioRef && event.data) {
        const { data: _stripped, ...lightweight } = event;
        res.write(`data: ${JSON.stringify(lightweight)}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      // Force-flush the write buffer. Without compression middleware,
      // res.flush() doesn't exist — use cork()/uncork() to guarantee
      // Node flushes pending writes to the socket immediately. Critical
      // for events emitted before an await block (plan_proposal,
      // approval_required) where no further writes push the buffer.
      if (typeof res.flush === "function") {
        res.flush();
      } else if (res.socket && !res.socket.destroyed) {
        res.socket.uncork?.();
        res.socket.cork?.();
        res.socket.uncork?.();
      }
    }
  };
}

/**
 * Build a flat JSON response from collected SSE events.
 * Used by non-streaming callers (?stream=false).
 *


 * @returns {{ error?: object, response?: object }}
 */
export function buildJsonResponseFromEvents(events: any, reqBody: any) {
  const errorEvent = events.find((e: any) => e.type === "error");
  if (errorEvent) {
    return { error: new ProviderError("server", errorEvent.message, 500) };
  }

  const doneEvent = events.find((e: any) => e.type === "done") || {};
  const text = events
    .filter((e: any) => e.type === "chunk")
    .map((e: any) => e.content)
    .join("");
  const thinking = events
    .filter((e: any) => e.type === "thinking")
    .map((e: any) => e.content)
    .join("");
  const images = events
    .filter((e: any) => e.type === "image")
    .map((e: any) => ({
      data: e.data,
      mimeType: e.mimeType,
      minioRef: e.minioRef || null,
    }));

  const toolCalls = events
    .filter((e: any) => e.type === "tool_execution" && e.status === "calling")
    .map((e: any) => ({
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
      ...(doneEvent.conversationId && {
        conversationId: doneEvent.conversationId,
      }),
    },
  };
}

/**
 * Handle a full SSE streaming request lifecycle.
 * Sets up SSE headers, AbortController, runs the handler, and closes.
 *


 */
export async function handleSseRequest(
  req: any,
  res: any,
  params: any,
  handler = handleConversation,
) {
  initSseResponse(res);

  const controller = createAbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  await handler(params, createSseEmitter(res, controller.signal), {
    signal: controller.signal,
  });

  if (!controller.signal.aborted) res.end();
}

/**
 * Handle a non-streaming JSON request lifecycle.
 * Collects events from the handler and returns a flat JSON response.
 *


 */
export async function handleJsonRequest(
  req: any,
  res: any,
  next: any,
  params: any,
  handler = handleConversation,
) {
  // @ts-ignore
  const events = [];
  await handler(params, (event: any) => events.push(event));

  // @ts-ignore
  const { error, response } = buildJsonResponseFromEvents(events, req.body);
  if (error) return next(error);

  res.json(response);
}

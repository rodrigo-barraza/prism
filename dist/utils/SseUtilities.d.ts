import { handleConversation } from "../routes/ChatRoutes.js";
import { ProviderError } from "./errors.js";
/**
 * Configure an Express response for SSE (Server-Sent Events) streaming.
 * Sets the required headers and flushes them immediately.
 *
 * @param {import("express").Response} res
 */
export declare function initSseResponse(res: any): void;
/**
 * Create an SSE emit callback that writes events to the response.
 * Strips heavy base64 data from image events when minioRef is available.
 *
 * @param {import("express").Response} res
 * @param {AbortSignal} signal
 * @returns {(event: object) => void}
 */
export declare function createSseEmitter(res: any, signal: any): (event: any) => void;
/**
 * Build a flat JSON response from collected SSE events.
 * Used by non-streaming callers (?stream=false).
 *
 * @param {Array<object>} events   - Collected events from the handler
 * @param {object}        reqBody  - The original request body (for fallback provider/model)
 * @returns {{ error?: object, response?: object }}
 */
export declare function buildJsonResponseFromEvents(events: any, reqBody: any): {
    error: ProviderError;
    response?: undefined;
} | {
    response: any;
    error?: undefined;
};
/**
 * Handle a full SSE streaming request lifecycle.
 * Sets up SSE headers, AbortController, runs the handler, and closes.
 *
 * @param {import("express").Request}  req
 * @param {import("express").Response} res
 * @param {object}                     params  - Parameters to pass to the handler
 * @param {Function}                   [handler] - Generation handler (default: handleConversation)
 */
export declare function handleSseRequest(req: any, res: any, params: any, handler?: typeof handleConversation): Promise<void>;
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
export declare function handleJsonRequest(req: any, res: any, next: any, params: any, handler?: typeof handleConversation): Promise<any>;
//# sourceMappingURL=SseUtilities.d.ts.map
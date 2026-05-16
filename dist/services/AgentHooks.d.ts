import { EventEmitter } from "events";
/**
 * AgentHooks — EventEmitter-based lifecycle system for the agentic loop.
 *
 * Events:
 *   beforePrompt     — Fires before each LLM call. Listeners receive (ctx) and
 *                       can mutate ctx.messages (e.g. inject system prompt context).
 *   beforeToolCall   — Fires before each tool execution. Listeners receive
 *                       (toolCall, ctx) and can return { approved: false } to block.
 *   afterToolCall    — Fires after each tool returns. Listeners receive
 *                       (toolCall, result, ctx).
 *   afterResponse    — Fires when the loop exits with a final response.
 *                       Listeners receive (ctx, { text, thinking, toolCalls, messages }).
 *   onError          — Fires on any loop error. Listeners receive (error, ctx).
 *
 * Usage:
 *   const hooks = new AgentHooks();
 *   hooks.register("beforePrompt", async (ctx) => { ... });
 *   await hooks.emit("beforePrompt", ctx);
 */
export default class AgentHooks extends EventEmitter {
    constructor();
    /**
     * Register a named async hook for a lifecycle event.
     * Hooks run sequentially in registration order.
     *
     * @param {string} event - Lifecycle event name
     * @param {Function} handler - Async handler function
     * @param {string} [name] - Optional name for logging
     */
    register(event: any, handler: any, name: any): void;
    /**
     * Run all registered hooks for an event sequentially.
     * Each hook can mutate ctx or return a control object.
     *
     * @param {string} event - Lifecycle event name
     * @param  {...any} args - Arguments passed to each handler
     * @returns {Promise<object|undefined>} Merged results from handlers
     */
    run(event: any, ...args: any): Promise<any>;
    /**
     * Check if any hooks are registered for an event.
     * @param {string} event
     * @returns {boolean}
     */
    hasHooks(event: any): boolean;
}
//# sourceMappingURL=AgentHooks.d.ts.map
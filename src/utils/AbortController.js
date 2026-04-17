// ────────────────────────────────────────────────────────────
// AbortController Tree — GC-safe parent→child signal propagation
// ────────────────────────────────────────────────────────────
//
// Provides factory functions for creating AbortControllers with proper
// listener limits and parent-child relationships where:
//   - Aborting the PARENT aborts all children
//   - Aborting a CHILD does NOT affect the parent
//   - Abandoned children can be garbage-collected (WeakRef-based)
//
// Pattern modeled on Claude Code's src/utils/abortController.ts.
// ────────────────────────────────────────────────────────────

import { setMaxListeners } from "events";

const DEFAULT_MAX_LISTENERS = 50;

/**
 * Create an AbortController with a higher listener limit.
 * Prevents MaxListenersExceededWarning when multiple consumers
 * (tool calls, stream readers, etc.) listen on the same signal.
 *
 * @param {number} [maxListeners=50]
 * @returns {AbortController}
 */
export function createAbortController(maxListeners = DEFAULT_MAX_LISTENERS) {
  const controller = new AbortController();
  setMaxListeners(maxListeners, controller.signal);
  return controller;
}

/**
 * Module-scope abort propagation handler.
 * Bound to WeakRef<parent> with WeakRef<child> as first arg.
 * Avoids per-call closure allocation.
 *
 * @this {WeakRef<AbortController>}
 * @param {WeakRef<AbortController>} weakChild
 */
function propagateAbort(weakChild) {
  const parent = this.deref();
  weakChild.deref()?.abort(parent?.signal.reason);
}

/**
 * Module-scope cleanup handler — removes the parent listener when child aborts.
 * Both parent and handler are weakly held.
 *
 * @this {WeakRef<AbortController>}
 * @param {WeakRef<Function>} weakHandler
 */
function removeAbortHandler(weakHandler) {
  const parent = this.deref();
  const handler = weakHandler.deref();
  if (parent && handler) {
    parent.signal.removeEventListener("abort", handler);
  }
}

/**
 * Create a child AbortController that aborts when its parent aborts.
 * Aborting the child does NOT affect the parent.
 *
 * Memory-safe: Uses WeakRef so the parent doesn't retain abandoned children.
 * If the child is dropped without being aborted, it can still be GC'd.
 * When the child IS aborted, the parent listener is removed to prevent
 * accumulation of dead handlers.
 *
 * @param {AbortController} parent - The parent controller
 * @param {number} [maxListeners] - Max listeners for the child
 * @returns {AbortController} Child controller
 *
 * @example
 * // Session-level controller (created per request)
 * const session = createAbortController();
 *
 * // Tool-level child (auto-aborts if session aborts)
 * const toolChild = createChildAbortController(session);
 * fetch(url, { signal: toolChild.signal });
 *
 * // Aborting session cascades to all children
 * session.abort(); // → toolChild also aborts
 *
 * // Aborting child does NOT affect session
 * toolChild.abort(); // → session stays alive
 */
export function createChildAbortController(parent, maxListeners) {
  const child = createAbortController(maxListeners);

  // Fast path: parent already aborted
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason);
    return child;
  }

  // WeakRef prevents the parent from keeping an abandoned child alive.
  const weakChild = new WeakRef(child);
  const weakParent = new WeakRef(parent);
  const handler = propagateAbort.bind(weakParent, weakChild);

  parent.signal.addEventListener("abort", handler, { once: true });

  // Auto-cleanup: remove parent listener when child is aborted (from any source).
  child.signal.addEventListener(
    "abort",
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true },
  );

  return child;
}

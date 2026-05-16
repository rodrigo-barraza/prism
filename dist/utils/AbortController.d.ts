/**
 * Create an AbortController with a higher listener limit.
 * Prevents MaxListenersExceededWarning when multiple consumers
 * (tool calls, stream readers, etc.) listen on the same signal.
 *
 * @param {number} [maxListeners=50]
 * @returns {AbortController}
 */
export declare function createAbortController(maxListeners?: number): AbortController;
//# sourceMappingURL=AbortController.d.ts.map
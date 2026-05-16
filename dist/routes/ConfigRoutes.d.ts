declare const router: import("express-serve-static-core").Router;
/**
 * GET /config-local
 * Fetches models from local/self-hosted providers (LM Studio, vLLM, Ollama)
 * with a 3-second timeout per provider so unreachable services fail fast.
 * Returns { models: { [provider]: [...] } } for the client to merge.
 * Mounted at /config-local (top-level, not under /config).
 *
 * Delegates all model discovery, normalization, and HF enrichment
 * to LocalProviderGateway.discoverModels(). Arena score enrichment
 * is applied here since it's a config-route concern.
 */
declare const localConfigRouter: import("express-serve-static-core").Router;
export { localConfigRouter };
export default router;
//# sourceMappingURL=ConfigRoutes.d.ts.map
/**
 * Express middleware that attaches the MongoDB database instance to `req.db`.
 * Returns 503 if the database is not available, eliminating the need for
 * per-route `const client = MongoWrapper.getClient(...)` + null-check boilerplate.
 *
 * Usage: `router.use(requireDb)` or per-route `router.get("/", requireDb, handler)`
 */
export default function requireDb(req: any, res: any, next: any): any;
//# sourceMappingURL=RequireDbMiddleware.d.ts.map
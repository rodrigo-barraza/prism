import logger from "../utils/logger.js";
import { requestContext } from "../utils/RequestContext.js";

/**
 * Format bytes into a human-readable string (B, KB, MB).
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0B";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

/**
 * Express middleware that:
 *   1. Sets AsyncLocalStorage context (project, username, clientIp)
 *      so deep call-stack code (providers, services) can read it.
 *   2. Logs every completed request with identity, IP, method, path,
 *      status, timing, and transfer sizes.
 */
export function requestLoggerMiddleware(req, res, next) {
  const start = performance.now();

  // Resolve identity + IP early (before authMiddleware for admin/files routes)
  const project = req.project || req.headers["x-project"] || null;
  const username = req.username || req.headers["x-username"] || null;
  const clientIp = req.clientIp || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;

  // Log on response finish
  res.on("finish", () => {
    // Skip SSE streaming requests — those are logged in detail by the route handlers
    const contentType = res.getHeader("content-type") || "";
    if (contentType.includes("text/event-stream")) return;
    // Skip binary audio streams — logged by route handler
    if (contentType.includes("audio/")) return;

    const elapsed = performance.now() - start;
    // Re-read project/username in case authMiddleware set them after us
    const finalProject = req.project || project;
    const finalUsername = req.username || username;
    const finalIp = req.clientIp || clientIp;
    const method = req.method;
    const path = req.originalUrl;
    const status = res.statusCode;

    // Format timing
    const time = elapsed >= 1000
      ? `${(elapsed / 1000).toFixed(2)}s`
      : `${Math.round(elapsed)}ms`;

    // Request / response sizes (from headers — zero-cost)
    const inBytes = parseInt(req.headers["content-length"] || "0", 10);
    const outBytes = parseInt(res.getHeader("content-length") || "0", 10);
    const totalBytes = inBytes + outBytes;
    const sizeTag = `(in: ${formatBytes(inBytes)}, out: ${formatBytes(outBytes)}, total: ${formatBytes(totalBytes)})`;

    logger.request(finalProject, finalUsername, finalIp, `${method} ${path} ${status} — ${time} ${sizeTag}`);
  });

  // Run the rest of the middleware chain inside AsyncLocalStorage context
  requestContext.run({ project, username, clientIp }, () => {
    next();
  });
}

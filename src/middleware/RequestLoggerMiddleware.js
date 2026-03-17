import logger from "../utils/logger.js";

/**
 * Express middleware that logs every completed request with:
 *   - Client IP
 *   - Project / username (if present)
 *   - HTTP method + path
 *   - Status code
 *   - Response time
 *
 * Hooks into `res.on("finish")` so the log fires after the response
 * is fully sent, capturing the final status code.
 */
export function requestLoggerMiddleware(req, res, next) {
  const start = performance.now();

  res.on("finish", () => {
    // Skip SSE streaming requests — those are logged in detail by the route handlers
    const contentType = res.getHeader("content-type") || "";
    if (contentType.includes("text/event-stream")) return;
    // Skip binary audio streams — logged by route handler
    if (contentType.includes("audio/")) return;

    const elapsed = performance.now() - start;
    const ip = req.clientIp || req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const project = req.project || null;
    const username = req.username || null;
    const method = req.method;
    const path = req.originalUrl;
    const status = res.statusCode;

    // Format timing
    const time = elapsed >= 1000
      ? `${(elapsed / 1000).toFixed(2)}s`
      : `${Math.round(elapsed)}ms`;

    logger.request(project, username, ip, `${method} ${path} ${status} — ${time}`);
  });

  next();
}

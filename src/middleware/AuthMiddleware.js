import { requestContext } from "../utils/RequestContext.js";

/**
 * Express middleware that attaches the x-project and x-username headers
 * to the request.
 */
export function authMiddleware(req, res, next) {
  // Attach project + username + client IP for downstream logging / tracking
  req.project = req.headers["x-project"] || "unknown";
  req.username = req.headers["x-username"] || "unknown";
  req.clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;

  // Update AsyncLocalStorage context with auth-resolved values
  const store = requestContext.getStore();
  if (store) {
    store.project = req.project;
    store.username = req.username;
    store.clientIp = req.clientIp;
  }

  next();
}

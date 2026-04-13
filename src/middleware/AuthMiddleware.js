import { requestContext } from "../utils/RequestContext.js";

/**
 * Express middleware that attaches the x-project and x-username headers
 * to the request.
 */
export function authMiddleware(req, res, next) {
  // Single source of truth for project resolution.
  // Priority: query param → body → x-project header → "default"
  req.project =
    req.query?.project || req.body?.project || req.headers["x-project"] || "default";
  req.clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  req.username = req.headers["x-username"] || req.clientIp;

  // Update AsyncLocalStorage context with auth-resolved values
  const store = requestContext.getStore();
  if (store) {
    store.project = req.project;
    store.username = req.username;
    store.clientIp = req.clientIp;
  }

  next();
}

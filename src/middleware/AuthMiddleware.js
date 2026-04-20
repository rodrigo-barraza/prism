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
  const rawIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
  // Normalize IPv4-mapped IPv6 addresses (::ffff:127.0.0.1 → 127.0.0.1)
  // to prevent colons from leaking into file paths / MinIO object keys.
  req.clientIp = rawIp?.replace(/^::ffff:/, "") || rawIp;
  // Use x-username header when provided; otherwise fall back to "anonymous".
  // Never use the raw client IP as the username — IPs in MinIO object keys
  // (e.g. projects/lupos/127.0.0.1/...) cause path duplication when the
  // same logical user is later identified by a proper username header.
  req.username = req.headers["x-username"] || "anonymous";

  // Update AsyncLocalStorage context with auth-resolved values
  const store = requestContext.getStore();
  if (store) {
    store.project = req.project;
    store.username = req.username;
    store.clientIp = req.clientIp;
  }

  next();
}

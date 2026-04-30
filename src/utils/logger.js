// ─────────────────────────────────────────────────────────────
// Re-export shared logger, scoped to this service.
// Extended with Prism-specific methods (provider, request).
// ─────────────────────────────────────────────────────────────

import { createLogger } from "@rodrigo-barraza/utilities/node";
import { getRequestContext } from "./RequestContext.js";

const base = createLogger("prism");

/**
 * Build identity + IP tags from provided values or AsyncLocalStorage context.
 */
function buildContextTags(project, username, clientIp) {
  const hasProject = project && project !== "unknown";
  const hasUser = username && username !== "unknown";

  let identityTag = "";
  if (hasProject && hasUser) {
    identityTag = ` [${project}/${username}]`;
  } else if (hasProject) {
    identityTag = ` [${project}]`;
  } else if (hasUser) {
    identityTag = ` [${username}]`;
  }

  const ipTag = clientIp ? ` (${clientIp})` : "";

  return `${identityTag}${ipTag}`;
}

const logger = {
  ...base,

  provider(provider, action, ...args) {
    const ctx = getRequestContext();
    const tags = buildContextTags(ctx.project, ctx.username, ctx.clientIp);
    console.log(
      `[${new Date().toISOString()}] PROV [prism]${tags} [${provider}] ${action}`,
      ...args,
    );
  },

  request(project, username, clientIp, message, ...args) {
    const tags = buildContextTags(project, username, clientIp);
    console.log(
      `[${new Date().toISOString()}] OK   [prism]${tags} ${message}`,
      ...args,
    );
  },
};

export default logger;

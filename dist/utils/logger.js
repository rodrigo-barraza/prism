// @ts-ignore
import { createLogger } from "@rodrigo-barraza/utilities-library/node";
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
    }
    else if (hasProject) {
        identityTag = ` [${project}]`;
    }
    else if (hasUser) {
        identityTag = ` [${username}]`;
    }
    const ipTag = clientIp ? ` (${clientIp})` : "";
    return `${identityTag}${ipTag}`;
}
const logger = {
    ...base,
    provider(provider, action, ...args) {
        const ctx = getRequestContext();
        // @ts-ignore
        const tags = buildContextTags(ctx.project, ctx.username, ctx.clientIp);
        base.info(`[${provider}] ${action}${tags}`, ...args);
    },
    request(project, username, clientIp, message, ...args) {
        const tags = buildContextTags(project, username, clientIp);
        base.info(`${message}${tags}`, ...args);
    },
};
export default logger;
//# sourceMappingURL=logger.js.map
import { getRequestContext } from "./RequestContext.js";

const COLORS = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function timestamp() {
  return new Date().toISOString();
}

/**
 * Build identity + IP tags from provided values or AsyncLocalStorage context.
 */
function buildContextTags(project, username, clientIp) {
  const hasProject = project && project !== "unknown";
  const hasUser = username && username !== "unknown";

  let identityTag = "";
  if (hasProject && hasUser) {
    identityTag = ` ${COLORS.cyan}[${project}/${username}]${COLORS.reset}`;
  } else if (hasProject) {
    identityTag = ` ${COLORS.cyan}[${project}]${COLORS.reset}`;
  } else if (hasUser) {
    identityTag = ` ${COLORS.cyan}[${username}]${COLORS.reset}`;
  }

  const ipTag = clientIp ? ` ${COLORS.gray}(${clientIp})${COLORS.reset}` : "";

  return `${identityTag}${ipTag}`;
}

const logger = {
  info(message, ...args) {
    console.log(
      `${COLORS.gray}[${timestamp()}]${COLORS.reset} ${COLORS.blue}ℹ${COLORS.reset} ${message}`,
      ...args,
    );
  },
  success(message, ...args) {
    console.log(
      `${COLORS.gray}[${timestamp()}]${COLORS.reset} ${COLORS.green}✓${COLORS.reset} ${message}`,
      ...args,
    );
  },
  warn(message, ...args) {
    console.warn(
      `${COLORS.gray}[${timestamp()}]${COLORS.reset} ${COLORS.yellow}⚠${COLORS.reset} ${message}`,
      ...args,
    );
  },
  error(message, ...args) {
    console.error(
      `${COLORS.gray}[${timestamp()}]${COLORS.reset} ${COLORS.red}✗${COLORS.reset} ${message}`,
      ...args,
    );
  },
  provider(provider, action, ...args) {
    const ctx = getRequestContext();
    const tags = buildContextTags(ctx.project, ctx.username, ctx.clientIp);
    console.log(
      `${COLORS.gray}[${timestamp()}]${COLORS.reset} ${COLORS.magenta}◆${COLORS.reset}${tags} ${COLORS.cyan}[${provider}]${COLORS.reset} ${action}`,
      ...args,
    );
  },
  request(project, username, clientIp, message, ...args) {
    const tags = buildContextTags(project, username, clientIp);
    console.log(
      `${COLORS.gray}[${timestamp()}]${COLORS.reset} ${COLORS.green}✓${COLORS.reset}${tags} ${message}`,
      ...args,
    );
  },
};

export default logger;

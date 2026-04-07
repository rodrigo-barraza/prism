import { resolve } from "node:path";
import ToolOrchestratorService from "./ToolOrchestratorService.js";
import AgentMemoryService from "./AgentMemoryService.js";
import { TOOLS_API_URL, WORKSPACE_ROOT as WORKSPACE_ROOT_RAW } from "../../secrets.js";
import logger from "../utils/logger.js";



/** Workspace root from secrets.js — must match tools-api WORKSPACE_ROOT */
const DEFAULT_WORKSPACE_ROOT = WORKSPACE_ROOT_RAW
  ? resolve(WORKSPACE_ROOT_RAW.split(",")[0].trim())
  : resolve(process.env.HOME || "/home");

/**
 * SystemPromptAssembler — sole owner of the agent's system prompt.
 *
 * Assembles identity, coding guidelines, tool descriptions, project
 * structure, environment info, and session memory into a single coherent
 * system message. Registered as a `beforePrompt` hook in AgentHooks.
 */
export default class SystemPromptAssembler {
  /**
   * @param {object} [options]
   * @param {string} [options.workspaceRoot] - Workspace root path
   */
  constructor(options = {}) {
    this.workspaceRoot = options.workspaceRoot || DEFAULT_WORKSPACE_ROOT;
    this._directoryCache = null;
    this._directoryCacheTime = 0;
    this._directoryCacheTTL = 60_000; // 1 minute
  }

  /**
   * Fetch project directory tree from tools-api.
   * Cached for 1 minute to avoid hammering the API.
   *
   * @returns {Promise<string>} Formatted directory tree
   */
  async fetchDirectoryTree() {
    const now = Date.now();
    if (this._directoryCache && now - this._directoryCacheTime < this._directoryCacheTTL) {
      return this._directoryCache;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const url = `${TOOLS_API_URL}/filesystem/list?path=${encodeURIComponent(this.workspaceRoot)}&depth=2`;
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!res.ok) {
        logger.warn(`[SystemPromptAssembler] Directory fetch failed: ${res.status}`);
        return "";
      }

      const data = await res.json();
      const tree = this._formatDirectoryTree(data);
      this._directoryCache = tree;
      this._directoryCacheTime = now;
      return tree;
    } catch (err) {
      logger.warn(`[SystemPromptAssembler] Directory fetch error: ${err.message}`);
      return this._directoryCache || "";
    }
  }

  /**
   * Format directory listing into a readable tree string.
   * @param {object} data - Response from tools-api list endpoint
   * @returns {string}
   */
  _formatDirectoryTree(data) {
    if (!data || !data.entries) return "";

    const lines = [];
    for (const entry of data.entries) {
      const prefix = entry.type === "directory" ? "📁" : "📄";
      const name = entry.name || entry.path;
      lines.push(`${prefix} ${name}`);

      // Include first-level children for directories
      if (entry.children && Array.isArray(entry.children)) {
        for (const child of entry.children.slice(0, 20)) {
          const childPrefix = child.type === "directory" ? "📁" : "📄";
          lines.push(`  ${childPrefix} ${child.name || child.path}`);
        }
        if (entry.children.length > 20) {
          lines.push(`  ... and ${entry.children.length - 20} more`);
        }
      }
    }

    return lines.join("\n");
  }

  /**
   * Build domain-grouped tool descriptions from current schemas.
   *
   * Groups tools by their `domain` field, then for each tool shows:
   *   - Name + first sentence of description (capability summary)
   *   - Full parameter listing with required markers
   *
   * @param {Array} [enabledTools] - If provided, only include these tool names
   * @returns {string}
   */
  buildToolDescriptions(enabledTools) {
    const schemas = ToolOrchestratorService.getToolSchemas();
    const enabledSet = enabledTools ? new Set(enabledTools) : null;

    const filtered = enabledSet
      ? schemas.filter((t) => enabledSet.has(t.name))
      : schemas;

    if (filtered.length === 0) return "";

    // Group by domain
    const groups = new Map();
    for (const tool of filtered) {
      const domain = (tool.domain || "Other").replace(/^Agentic:\s*/i, "");
      if (!groups.has(domain)) groups.set(domain, []);
      groups.get(domain).push(tool);
    }

    // Build categorised sections with parameter details
    const sections = [];
    for (const [domain, domainTools] of groups) {
      const entries = domainTools.map((tool) => {
        const desc = tool.description || "";

        const params = tool.parameters?.properties || {};
        const paramNames = Object.keys(params);
        const required = tool.parameters?.required || [];
        const paramStr = paramNames
          .map((p) => {
            const isReq = required.includes(p);
            const paramDesc = params[p].description || "";
            return `  - ${p}${isReq ? " (required)" : ""}: ${paramDesc}`;
          })
          .join("\n");

        return `### ${tool.name}\n${desc}\n${paramStr}`;
      });

      sections.push(`**${domain}**\n${entries.join("\n\n")}`);
    }

    return sections.join("\n\n");
  }

  /**
   * Fetch relevant project memories.
   *
   * @param {string} project - Project identifier
   * @param {string} queryText - Query for semantic search
   * @param {number} [limit=5]
   * @returns {Promise<string>}
   */
  async fetchMemories(project, queryText, limit = 5) {
    try {
      const memories = await AgentMemoryService.search({
        project,
        queryText,
        limit,
      });

      if (!memories || memories.length === 0) return "";

      return AgentMemoryService.formatForPrompt(memories);
    } catch (err) {
      logger.warn(`[SystemPromptAssembler] Memory fetch error: ${err.message}`);
      return "";
    }
  }



  /**
   * Assemble the complete agent system prompt.
   *
   * Sections (in order):
   *   1. Agent identity + coding guidelines
   *   2. Available tools (domain-grouped with parameters)
   *   3. Environment info (date/time, OS, workspace)
   *   4. Project directory tree
   *   5. Session memory from past conversations
   *
   * @param {object} ctx - Request context
   * @param {string} ctx.project - Project identifier
   * @param {Array} ctx.messages - Current messages array
   * @param {Array} [ctx.enabledTools] - Enabled tool names
   * @returns {Promise<string>} Complete system prompt
   */
  async assemble(ctx) {
    const sections = [];

    // ── 1. Agent Identity ────────────────────────────────────────
    sections.push(
      `You are a highly capable coding agent with access to file system, git, command execution, and web tools.`,
    );

    // ── 2. Available Tools (domain-grouped) ──────────────────────
    const toolDescs = this.buildToolDescriptions(ctx.enabledTools);
    if (toolDescs) {
      const schemas = ToolOrchestratorService.getToolSchemas();
      const count = ctx.enabledTools
        ? schemas.filter((t) => new Set(ctx.enabledTools).has(t.name)).length
        : schemas.length;
      sections.push(`## Available Tools (${count})\n` + toolDescs);
    }

    // ── 3. Coding Guidelines ─────────────────────────────────────
    sections.push(
      `## Coding Guidelines\n` +
      `1. Always read relevant files before making edits to understand context\n` +
      `2. Prefer str_replace_file over write_file for editing existing code — it's safer and preserves unchanged content\n` +
      `3. Use multi_file_read when you need to inspect several files at once\n` +
      `4. After making changes, verify them by reading the modified section\n` +
      `5. Use project_summary to understand unfamiliar codebases before diving in\n` +
      `6. Check git_status before and after edits to track your changes\n` +
      `7. When searching, use includes filters to narrow results (e.g. [".js", ".ts"])\n` +
      `8. Keep your explanations concise and technical`,
    );

    // ── 4. Environment ───────────────────────────────────────────
    sections.push(
      `## Environment\n` +
      `- Date/Time: ${new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" })}\n` +
      `- OS: Linux (WSL2)\n` +
      `- Workspace: ${this.workspaceRoot}`,
    );

    // ── 5. Project Structure (cached) ────────────────────────────
    const dirTree = await this.fetchDirectoryTree();
    if (dirTree) {
      sections.push(`## Project Structure\n` + dirTree);
    }

    // ── 6. Session Memory ────────────────────────────────────────
    const lastUserMsg = [...(ctx.messages || [])]
      .reverse()
      .find((m) => m.role === "user");
    const queryText = lastUserMsg?.content || ctx.project || "";

    if (queryText) {
      const memories = await this.fetchMemories(ctx.project, queryText);
      if (memories) {
        sections.push(`## Session Memory (from past conversations)\n` + memories);
      }
    }

    return sections.join("\n\n");
  }

  /**
   * Create a beforePrompt hook handler for AgentHooks.
   *
   * Replaces or creates the system message with the fully assembled prompt.
   * Any existing system message content from the client is ignored — the
   * backend is the single source of truth for the agent system prompt.
   *
   * @returns {Function}
   */
  createHook() {
    return async (ctx) => {
      try {
        const systemPrompt = await this.assemble(ctx);
        if (!systemPrompt) return;

        // Replace existing system message or prepend a new one
        const systemIdx = ctx.messages?.findIndex((m) => m.role === "system");
        if (systemIdx !== undefined && systemIdx >= 0) {
          ctx.messages[systemIdx].content = systemPrompt;
        } else {
          ctx.messages?.unshift({ role: "system", content: systemPrompt });
        }

        logger.info(
          `[SystemPromptAssembler] Assembled ${systemPrompt.length} char system prompt`,
        );
      } catch (err) {
        logger.error(`[SystemPromptAssembler] Assembly failed: ${err.message}`);
      }
    };
  }
}

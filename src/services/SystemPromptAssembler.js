import { resolve } from "node:path";
import ToolOrchestratorService from "./ToolOrchestratorService.js";
import AgentMemoryService from "./AgentMemoryService.js";
import { TOOLS_API_URL, WORKSPACE_ROOT as WORKSPACE_ROOT_RAW } from "../../secrets.js";
import logger from "../utils/logger.js";

/**
 * Default token budget for assembled system prompt context.
 * ~4 chars per token → 4096 tokens ≈ 16K chars.
 */
const DEFAULT_TOKEN_BUDGET = 4096;
const CHARS_PER_TOKEN = 4;

/** Workspace root from secrets.js — must match tools-api WORKSPACE_ROOT */
const DEFAULT_WORKSPACE_ROOT = WORKSPACE_ROOT_RAW
  ? resolve(WORKSPACE_ROOT_RAW.split(",")[0].trim())
  : resolve(process.env.HOME || "/home");

/**
 * SystemPromptAssembler — dynamically injects project context, tool schemas,
 * and memory into the system prompt before each LLM call.
 *
 * Registered as a `beforePrompt` hook in AgentHooks.
 */
export default class SystemPromptAssembler {
  /**
   * @param {object} [options]
   * @param {number} [options.tokenBudget=4096] - Max tokens for injected context
   * @param {string} [options.workspaceRoot] - Workspace root path
   */
  constructor(options = {}) {
    this.tokenBudget = options.tokenBudget || DEFAULT_TOKEN_BUDGET;
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
   * Build tool descriptions from current schemas.
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

    const lines = filtered.map((tool) => {
      const params = tool.parameters?.properties || {};
      const paramNames = Object.keys(params);
      const required = tool.parameters?.required || [];
      const paramStr = paramNames
        .map((p) => {
          const isReq = required.includes(p);
          const desc = params[p].description || "";
          return `  - ${p}${isReq ? " (required)" : ""}: ${desc}`;
        })
        .join("\n");

      return `### ${tool.name}\n${tool.description || ""}\n${paramStr}`;
    });

    return lines.join("\n\n");
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
   * Truncate text to fit within token budget.
   * @param {string} text
   * @param {number} maxTokens
   * @returns {string}
   */
  truncate(text, maxTokens) {
    const maxChars = maxTokens * CHARS_PER_TOKEN;
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + "\n\n[... context truncated to fit token budget]";
  }

  /**
   * Assemble the dynamic context block to inject into the system prompt.
   *
   * @param {object} ctx - Request context
   * @param {string} ctx.project - Project identifier
   * @param {Array} ctx.messages - Current messages array
   * @param {Array} [ctx.enabledTools] - Enabled tool names
   * @returns {Promise<string>} Assembled context block
   */
  async assemble(ctx) {
    const sections = [];
    const budgetPerSection = Math.floor(this.tokenBudget / 4);

    // 1. Environment info (cheap, always include)
    sections.push(
      `## Environment\n` +
      `- Date/Time: ${new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" })}\n` +
      `- OS: Linux (WSL2)\n` +
      `- Workspace: ${this.workspaceRoot}`,
    );

    // 2. Directory tree (cached, ~500-1000 chars typically)
    const dirTree = await this.fetchDirectoryTree();
    if (dirTree) {
      sections.push(
        `## Project Structure\n` +
        this.truncate(dirTree, budgetPerSection),
      );
    }

    // 3. Available tools
    const toolDescs = this.buildToolDescriptions(ctx.enabledTools);
    if (toolDescs) {
      sections.push(
        `## Available Tools\n` +
        this.truncate(toolDescs, budgetPerSection),
      );
    }

    // 4. Relevant memories from past sessions
    const lastUserMsg = [...(ctx.messages || [])]
      .reverse()
      .find((m) => m.role === "user");
    const queryText = lastUserMsg?.content || ctx.project || "";

    if (queryText) {
      const memories = await this.fetchMemories(ctx.project, queryText);
      if (memories) {
        sections.push(
          `## Session Memory (from past conversations)\n` +
          this.truncate(memories, budgetPerSection),
        );
      }
    }

    const assembled = sections.join("\n\n");
    return this.truncate(assembled, this.tokenBudget);
  }

  /**
   * Create a beforePrompt hook handler for AgentHooks.
   * Injects assembled context into the system prompt message.
   *
   * @returns {Function}
   */
  createHook() {
    return async (ctx) => {
      try {
        const context = await this.assemble(ctx);
        if (!context) return;

        // Find the system message and append context
        const systemMsg = ctx.messages?.find((m) => m.role === "system");
        if (systemMsg) {
          systemMsg.content = `${systemMsg.content}\n\n---\n\n${context}`;
        } else {
          // No system message — prepend one
          ctx.messages?.unshift({ role: "system", content: context });
        }

        logger.info(
          `[SystemPromptAssembler] Injected ${context.length} chars of context into system prompt`,
        );
      } catch (err) {
        logger.error(`[SystemPromptAssembler] Assembly failed: ${err.message}`);
      }
    };
  }
}

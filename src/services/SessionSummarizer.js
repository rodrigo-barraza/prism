import { getProvider } from "../providers/index.js";
import MemoryService from "./MemoryService.js";
import logger from "../utils/logger.js";

const SUMMARIZATION_PROVIDER = "anthropic";
const SUMMARIZATION_MODEL = "claude-haiku-4-5-20251001";
const MIN_MESSAGES_FOR_SUMMARY = 4;

const SUMMARIZATION_PROMPT = `You are a session summarizer. Analyze this agentic coding conversation and extract key information for future sessions.

Extract the following categories of information:

1. **Decisions**: Technical decisions made during this session (e.g., "chose to use EventEmitter pattern for hooks")
2. **Files Modified**: Files that were created, modified, or deleted, with brief reasons
3. **TODOs**: Unresolved issues, pending tasks, or things to revisit
4. **Preferences**: User preferences observed (e.g., coding style, tool preferences, naming conventions)
5. **Context**: Important project context learned (e.g., architecture patterns, dependency relationships)

Respond ONLY with a JSON array. Each object must have:
- "fact": string — concise description of the information
- "category": string — one of: "decision", "file_change", "todo", "preference", "context"
- "confidence": number — 0.0 to 1.0

If no meaningful information was found, return an empty array: []`;

/**
 * SessionSummarizer — extracts and stores memories from agentic conversations.
 *
 * Registered as an `afterResponse` hook in AgentHooks.
 * Runs in the background (fire-and-forget) after the final response.
 */
export default class SessionSummarizer {
  /**
   * Extract facts from a conversation and store as project-scoped memories.
   *
   * @param {object} params
   * @param {string} params.project - Project identifier
   * @param {string} params.username - Username
   * @param {Array} params.messages - Full conversation messages
   * @param {string} [params.conversationId] - Conversation ID for tracking
   * @returns {Promise<Array>} Stored memory documents
   */
  static async summarizeAndStore({ project, username, messages, conversationId }) {
    if (!messages || messages.length < MIN_MESSAGES_FOR_SUMMARY) {
      logger.info(
        `[SessionSummarizer] Skipping — only ${messages?.length || 0} messages (min: ${MIN_MESSAGES_FOR_SUMMARY})`,
      );
      return [];
    }

    try {
      const provider = getProvider(SUMMARIZATION_PROVIDER);

      // Build conversation text (compact format to save tokens)
      const conversationText = messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => {
          const content = m.content || "";
          // Truncate very long messages to save tokens
          const truncated = content.length > 500 ? content.slice(0, 500) + "..." : content;
          return `${m.role}: ${truncated}`;
        })
        .join("\n");

      const aiMessages = [
        { role: "system", content: SUMMARIZATION_PROMPT },
        {
          role: "user",
          content: `Extract key information from this coding session:\n\n${conversationText}`,
        },
      ];

      const result = await provider.generateText(aiMessages, SUMMARIZATION_MODEL, {
        maxTokens: 1000,
        temperature: 0.1,
      });

      const text = result.text || "";

      // Parse JSON from the response (handle markdown code blocks)
      let jsonText = text.trim();
      const jsonMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonText = jsonMatch[1].trim();
      }

      let facts;
      try {
        facts = JSON.parse(jsonText);
        if (!Array.isArray(facts)) {
          logger.warn("[SessionSummarizer] Response was not an array");
          return [];
        }
      } catch {
        logger.warn(
          "[SessionSummarizer] Failed to parse extraction result:",
          jsonText.substring(0, 200),
        );
        return [];
      }

      // Filter valid entries with sufficient confidence
      const validFacts = facts.filter(
        (f) => f.fact && f.category && typeof f.confidence === "number" && f.confidence >= 0.5,
      );

      if (validFacts.length === 0) {
        logger.info("[SessionSummarizer] No high-confidence facts extracted");
        return [];
      }

      // Store via MemoryService (project-scoped)
      const stored = await MemoryService.extractAndStoreForProject({
        project,
        username,
        facts: validFacts,
        conversationId,
      });

      logger.info(
        `[SessionSummarizer] Stored ${stored.length} memories from conversation ${conversationId || "unknown"}`,
      );
      return stored;
    } catch (err) {
      logger.error(`[SessionSummarizer] Failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Create an afterResponse hook handler for AgentHooks.
   * Runs as fire-and-forget (non-blocking).
   *
   * @returns {Function}
   */
  static createHook() {
    return async (ctx, { _text, messages }) => {
      // Fire-and-forget — don't block the response
      SessionSummarizer.summarizeAndStore({
        project: ctx.project,
        username: ctx.username,
        messages: messages || ctx.messages,
        conversationId: ctx.conversationId,
      }).catch((err) =>
        logger.error(`[SessionSummarizer] Background summarization failed: ${err.message}`),
      );
    };
  }
}

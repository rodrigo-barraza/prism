import { getProvider } from "../providers/index.js";
import AgentMemoryService from "./AgentMemoryService.js";
import logger from "../utils/logger.js";

const SUMMARIZATION_PROVIDER = "anthropic";
const SUMMARIZATION_MODEL = "claude-haiku-4-5-20251001";
const MIN_MESSAGES_FOR_SUMMARY = 4;

/**
 * Extraction prompt — inspired by Claude Code's memdir type taxonomy.
 *
 * Constrains memories to 4 types capturing context NOT derivable from the
 * current project state. Code patterns, architecture, git history, and file
 * structure are derivable (via grep/git/file reads) and should NOT be saved.
 */
const EXTRACTION_PROMPT = `You are a memory extraction agent. Analyze this coding conversation and extract memories worth preserving for future sessions.

## Memory Types

There are exactly 4 types of memory you can extract:

<types>
<type>
  <name>user</name>
  <description>Information about the user's role, goals, responsibilities, and expertise. Great user memories help tailor future behavior to the user's preferences and perspective.</description>
  <when_to_save>When you learn details about the user's role, preferences, responsibilities, or knowledge.</when_to_save>
  <examples>
  - "User is an experienced full-stack engineer with an arts background, high CSS standards"
  - "User prefers concise explanations — expert-level, no hand-holding"
  </examples>
</type>
<type>
  <name>feedback</name>
  <description>Guidance the user has given about how to approach work — both what to avoid AND what to keep doing. Record from failure AND success: if you only save corrections, you'll avoid past mistakes but drift away from validated approaches.</description>
  <when_to_save>Any time the user corrects your approach ("no not that", "don't", "stop doing X") OR confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that"). Include *why* so you can judge edge cases later.</when_to_save>
  <examples>
  - "Don't mock the database in tests — previous incident where mock/prod divergence masked a broken migration"
  - "User prefers one bundled PR over many small ones for refactors — confirmed after I chose this approach"
  </examples>
</type>
<type>
  <name>project</name>
  <description>Information about ongoing work, goals, initiatives, bugs, or incidents that is NOT derivable from the code or git history. Project memories help understand broader context and motivation.</description>
  <when_to_save>When you learn who is doing what, why, or by when. Convert relative dates to absolute dates. These states change quickly so keep them current.</when_to_save>
  <examples>
  - "Auth middleware rewrite is driven by legal/compliance requirements, not tech-debt cleanup"
  - "Merge freeze begins 2026-03-05 for mobile release cut"
  </examples>
</type>
<type>
  <name>reference</name>
  <description>Pointers to where information can be found in external systems. These let you remember where to look for information outside the project directory.</description>
  <when_to_save>When you learn about resources in external systems and their purpose.</when_to_save>
  <examples>
  - "Pipeline bugs tracked in Linear project 'INGEST'"
  - "VRAM benchmark data stored in MongoDB prism.vram_benchmarks collection"
  </examples>
</type>
</types>

## What NOT to Save

- Code patterns, conventions, architecture, file paths, or project structure — derivable by reading the code
- Git history, recent changes, or who-changed-what — git log/blame are authoritative
- Debugging solutions or fix recipes — the fix is in the code, the commit message has context
- Ephemeral task details: in-progress work, temporary state, current conversation context
- File changes — these are already tracked by version control

These exclusions apply even for seemingly important items. Only save what will be useful in FUTURE conversations.

## Output Format

Respond ONLY with a JSON array. Each object must have:
- "type": one of "user", "feedback", "project", "reference"
- "title": short name (under 60 chars) used for scanning relevance
- "content": full memory text, structured as: fact/rule, then why, then how to apply

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
        { role: "system", content: EXTRACTION_PROMPT },
        {
          role: "user",
          content: `Extract memories from this coding session:\n\n${conversationText}`,
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

      let memories;
      try {
        memories = JSON.parse(jsonText);
        if (!Array.isArray(memories)) {
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

      // Filter valid entries
      const validMemories = memories.filter(
        (m) => m.content && m.title && m.type,
      );

      if (validMemories.length === 0) {
        logger.info("[SessionSummarizer] No valid memories extracted");
        return [];
      }

      // Store via AgentMemoryService
      const stored = [];
      for (const mem of validMemories) {
        const result = await AgentMemoryService.store({
          project,
          username,
          type: mem.type,
          title: mem.title,
          content: mem.content,
          conversationId,
        });
        if (result) stored.push(result);
      }

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
      })
        .then((stored) => {
          if (stored?.length > 0 && ctx.emit) {
            ctx.emit({
              type: "status",
              message: "memories_updated",
              count: stored.length,
            });
          }
        })
        .catch((err) =>
          logger.error(`[SessionSummarizer] Background summarization failed: ${err.message}`),
        );
    };
  }
}

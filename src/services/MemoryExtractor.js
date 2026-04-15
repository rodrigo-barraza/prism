import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import MemoryService from "./MemoryService.js";
import MemoryConsolidationService from "./MemoryConsolidationService.js";
import EpisodicMemoryService from "./EpisodicMemoryService.js";
import SemanticMemoryService from "./SemanticMemoryService.js";
import ProceduralMemoryService from "./ProceduralMemoryService.js";
import RequestLogger from "./RequestLogger.js";
import logger from "../utils/logger.js";
import { estimateTokens, calculateTextCost } from "../utils/CostCalculator.js";
import { TYPES, getPricing } from "../config.js";
import { calculateTokensPerSec } from "../utils/math.js";
import { roundMs } from "../utils/utilities.js";

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
const EXTRACTION_PROMPT = `You are a memory extraction agent for a multi-system memory architecture. Analyze this conversation and extract three categories of memories.

## Category 1: Semantic Memories (Facts & Knowledge)
Stable facts, preferences, rules, and references that will be useful in future sessions.

Types: "preference", "fact", "rule", "reference"

Examples:
- {"category": "semantic", "type": "preference", "title": "CSS animation standards", "content": "User requires GPU-accelerated CSS animations using transform/opacity"}
- {"category": "semantic", "type": "rule", "title": "No database mocks in tests", "content": "Don't mock databases in tests — mock/prod divergence masked a broken migration"}

## Category 2: Procedural Memories (Learned Patterns)
Successful approaches, tool sequences, or problem-solving strategies that worked.

Examples:
- {"category": "procedural", "trigger": "WebSocket disconnection during streaming", "procedure": ["Check AbortController signal chain", "Verify stream.return() on abort", "Check orphaned event listeners"], "toolSequence": ["grep_search", "read_file", "str_replace_file"]}

## Category 3: Episode Summary
A narrative summary of what happened in this session as a whole.

Example:
- {"category": "episode", "summary": "Debugged WebSocket reconnection issue in AgenticLoopService", "narrative": "User reported streaming drops. Found AbortController wasn't passed through stream chain. Fixed by threading signal through all async generators.", "outcome": "resolved", "satisfaction": "positive", "keyDecisions": ["Choose AbortController over setTimeout for cleanup"], "tags": ["websocket", "debugging"]}

## What NOT to Save
- Code patterns derivable by reading the code
- Git history, file changes, or project structure
- Ephemeral task details or current conversation context
- Debugging solutions (the fix is in the code)

## Output Format
Respond ONLY with a JSON object:
\`\`\`json
{
  "episode": { "summary": "...", "narrative": "...", "outcome": "resolved|partial|abandoned|deferred", "satisfaction": "positive|neutral|negative", "keyDecisions": [], "tags": [] },
  "semantic": [ { "type": "...", "title": "...", "content": "..." } ],
  "procedural": [ { "trigger": "...", "procedure": ["step1", "step2"], "toolSequence": ["tool1"] } ]
}
\`\`\`

Omit any section if nothing meaningful was found. Minimally, always try to produce an episode summary.`;

/**
 * MemoryExtractor — extracts and stores memories from agentic conversations.
 *
 * Registered as an `afterResponse` hook in AgentHooks.
 * Runs in the background (fire-and-forget) after the final response.
 */
export default class MemoryExtractor {
  /**
   * Extract facts from a conversation and store as project-scoped memories.
   *
   * @param {object} params
   * @param {string} params.project - Project identifier
   * @param {string} params.username - Username
   * @param {Array} params.messages - Full conversation messages
   * @param {string} [params.traceId] - Session ID for attribution
   * @param {string} [params.conversationId] - Conversation ID for tracking
   * @returns {Promise<Array>} Stored memory documents
   */
  static async summarizeAndStore({ project, username, messages, traceId, agentSessionId, conversationId, endpoint, agent }) {
    if (!messages || messages.length < MIN_MESSAGES_FOR_SUMMARY) {
      logger.info(
        `[MemoryExtractor] Skipping — only ${messages?.length || 0} messages (min: ${MIN_MESSAGES_FOR_SUMMARY})`,
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

      const requestId = crypto.randomUUID();
      const requestStart = performance.now();
      let result;
      let success = true;
      let errorMessage = null;

      try {
        result = await provider.generateText(aiMessages, SUMMARIZATION_MODEL, {
          maxTokens: 1000,
          temperature: 0.1,
        });
      } catch (err) {
        success = false;
        errorMessage = err.message;
        throw err;
      } finally {
        const totalSec = (performance.now() - requestStart) / 1000;
        const inputText = aiMessages.map((m) => m.content).join("\n");
        const approxInputTokens = estimateTokens(inputText);
        const approxOutputTokens = result ? estimateTokens(result.text || "") : 0;
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[SUMMARIZATION_MODEL];
        let estimatedCost = null;
        if (pricing) {
          estimatedCost = calculateTextCost(
            { inputTokens: approxInputTokens, outputTokens: approxOutputTokens },
            pricing,
          );
        }

        RequestLogger.log({
          requestId,
          endpoint: endpoint || "/agent",
          operation: "memory:extract",
          project,
          traceId: traceId || null,
          agentSessionId: agentSessionId || null,
          username: username || "system",
          clientIp: null,
          agent: agent || null,
          provider: SUMMARIZATION_PROVIDER,
          model: SUMMARIZATION_MODEL,
          success,
          errorMessage,
          estimatedCost,
          inputTokens: approxInputTokens,
          outputTokens: approxOutputTokens,
          tokensPerSec: calculateTokensPerSec(approxOutputTokens, totalSec),
          inputCharacters: inputText.length,
          totalTime: roundMs(totalSec),
          modalities: { textIn: true, textOut: true },
          requestPayload: {
            operation: "memory:extract",
            messageCount: messages.length,
            conversationId: conversationId || null,
            messages: aiMessages,
          },
          responsePayload: success
            ? { textPreview: (result?.text || "").slice(0, 200) }
            : { error: errorMessage },
        });
      }

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
          logger.warn("[MemoryExtractor] Response was not an array");
          return [];
        }
      } catch {
        logger.warn(
          "[MemoryExtractor] Failed to parse extraction result:",
          jsonText.substring(0, 200),
        );
        return [];
      }

      // Handle both legacy (array) and new (object with sections) formats
      let parsed;
      if (Array.isArray(memories)) {
        // Legacy format — treat as semantic memories
        parsed = {
          semantic: memories.filter((m) => m.content && m.title && m.type),
          episode: null,
          procedural: [],
        };
      } else if (typeof memories === "object") {
        parsed = memories;
      } else {
        logger.warn("[MemoryExtractor] Unexpected response format");
        return [];
      }

      const agentId = agent || "CODING";
      const stored = [];
      let episodeId = null;

      // ── 1. Store Episode (episodic memory) ────────────────────────
      if (parsed.episode?.summary) {
        try {
          const ep = await EpisodicMemoryService.store({
            agent: agentId,
            project,
            traceId,
            agentSessionId,
            conversationId,
            username,
            summary: parsed.episode.summary,
            narrative: parsed.episode.narrative || null,
            outcome: parsed.episode.outcome || "resolved",
            satisfaction: parsed.episode.satisfaction || "neutral",
            keyDecisions: parsed.episode.keyDecisions || [],
            tags: parsed.episode.tags || [],
          });
          episodeId = ep.id;
          stored.push({ type: "episode", id: ep.id });
          logger.info(`[MemoryExtractor] Stored episode: "${parsed.episode.summary.substring(0, 60)}"`);
        } catch (err) {
          logger.error(`[MemoryExtractor] Episode storage failed: ${err.message}`);
        }
      }

      // ── 2. Store Semantic Memories ─────────────────────────────────
      const semanticIds = [];
      if (parsed.semantic?.length > 0) {
        for (const mem of parsed.semantic) {
          if (!mem.content) continue;
          try {
            // Store in new semantic system
            const semResult = await SemanticMemoryService.store({
              agent: agentId,
              project,
              type: mem.type || "fact",
              title: mem.title,
              content: mem.content,
              sourceEpisodeId: episodeId,
              username,
              agentSessionId,
            });
            if (semResult) semanticIds.push(semResult.id);

            // Also store in legacy MemoryService for backward compatibility
            await MemoryService.store({
              agent: agentId,
              project,
              username,
              type: mem.type || "fact",
              title: mem.title,
              content: mem.content,
              conversationId,
              traceId,
              agentSessionId,
              endpoint: endpoint || "/agent",
            });

            stored.push({ type: "semantic", id: semResult?.id });
          } catch (err) {
            logger.error(`[MemoryExtractor] Semantic storage failed: ${err.message}`);
          }
        }
      }

      // ── 3. Store Procedural Memories ───────────────────────────────
      const proceduralIds = [];
      if (parsed.procedural?.length > 0) {
        for (const proc of parsed.procedural) {
          if (!proc.trigger || !proc.procedure?.length) continue;
          try {
            const procResult = await ProceduralMemoryService.store({
              agent: agentId,
              project,
              trigger: proc.trigger,
              procedure: proc.procedure,
              toolSequence: proc.toolSequence || [],
              sourceEpisodeId: episodeId,
              agentSessionId,
            });
            if (procResult) proceduralIds.push(procResult.id);
            stored.push({ type: "procedural", id: procResult?.id });
          } catch (err) {
            logger.error(`[MemoryExtractor] Procedural storage failed: ${err.message}`);
          }
        }
      }

      // ── 4. Cross-reference episode with extracted IDs ──────────────
      if (episodeId && (semanticIds.length > 0 || proceduralIds.length > 0)) {
        EpisodicMemoryService.linkExtracted(episodeId, {
          semanticIds,
          proceduralIds,
        }).catch((err) =>
          logger.error(`[MemoryExtractor] Episode cross-ref failed: ${err.message}`),
        );
      }

      logger.info(
        `[MemoryExtractor] Stored ${stored.length} memories from conversation ${conversationId || "unknown"} ` +
        `(ep:${episodeId ? 1 : 0} sem:${semanticIds.length} proc:${proceduralIds.length})`,
      );
      return stored;
    } catch (err) {
      logger.error(`[MemoryExtractor] Failed: ${err.message}`);
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
      MemoryExtractor.summarizeAndStore({
        project: ctx.project,
        username: ctx.username,
        messages: messages || ctx.messages,
        traceId: ctx.traceId,
        agentSessionId: ctx.agentSessionId,
        conversationId: ctx.conversationId,
        endpoint: ctx.endpoint || "/agent",
        agent: ctx.agent || null,
      })
        .then((stored) => {
          if (stored?.length > 0 && ctx.emit) {
            ctx.emit({
              type: "status",
              message: "memories_updated",
              count: stored.length,
            });
          }

          // Build a broadcast callback from ctx.emit for consolidation notifications
          const broadcast = ctx.emit
            ? (payload) => ctx.emit(payload)
            : undefined;

          // Check if consolidation should run (tracks session count)
          MemoryConsolidationService.checkAndRun({
            project: ctx.project,
            username: ctx.username,
            broadcast,
            endpoint: ctx.endpoint || "/agent",
            agent: ctx.agent || null,
            traceId: ctx.traceId || null,
            agentSessionId: ctx.agentSessionId || null,
          });
        })
        .catch((err) =>
          logger.error(`[MemoryExtractor] Background summarization failed: ${err.message}`),
        );
    };
  }
}

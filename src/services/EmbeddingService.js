import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import { TYPES, getDefaultModels, getPricing } from "../config.js";
import { estimateTokens } from "../utils/CostCalculator.js";
import RequestLogger from "./RequestLogger.js";
import logger from "../utils/logger.js";
import { calculateTokensPerSec } from "../utils/math.js";
import { formatCostTag } from "../utils/utilities.js";
import SettingsService from "./SettingsService.js";

const DEFAULT_PROVIDER = "google";
const DEFAULT_MODEL = "gemini-embedding-2-preview";

/** Resolve the current embedding provider + model from settings. */
async function getEmbeddingConfig() {
  try {
    const mem = await SettingsService.getSection("memory");
    return {
      provider: mem.embeddingProvider || DEFAULT_PROVIDER,
      model: mem.embeddingModel || DEFAULT_MODEL,
    };
  } catch {
    return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
  }
}

/**
 * EmbeddingService — single entry point for all embedding generation.
 *
 * Wraps the provider's `generateEmbedding()` with RequestLogger tracking,
 * ensuring both HTTP `/embed` requests and internal callers (MemoryService,
 * SystemPromptAssembler) flow through the same path.
 */
const EmbeddingService = {
  /**
   * Generate an embedding and log the request.
   *
   * @param {string|Array|object} content - Text string or multimodal parts
   * @param {object} [options]
   * @param {string} [options.provider]    - Provider name (default: google)
   * @param {string} [options.model]       - Model name (default: gemini-embedding-2-preview)
   * @param {string} [options.taskType]    - e.g. SEMANTIC_SIMILARITY
   * @param {number} [options.dimensions]  - Output dimensionality
   * @param {string} [options.project]     - Project identifier (for request log)
   * @param {string} [options.username]    - Username (for request log)
   * @param {string} [options.clientIp]    - Client IP (for request log)
   * @param {string} [options.source]      - Caller identifier, e.g. "memory", "agent-memory", "skill-relevance", "api"
   * @param {string} [options.agent]       - Agent identifier (e.g. "CODING", "LUPOS")
   * @returns {Promise<{ embedding: number[], dimensions: number, provider: string, model: string }>}
   */
  async generate(content, options = {}) {
    const requestId = crypto.randomUUID();
    const requestStart = performance.now();

    // Resolve defaults from settings when no explicit provider/model given
    const embedConfig = await getEmbeddingConfig();
    const providerName = options.provider || embedConfig.provider;
    const resolvedModel =
      options.model ||
      getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING)?.[providerName] ||
      embedConfig.model;

    let result;
    let success = true;
    let errorMessage = null;

    try {
      const provider = getProvider(providerName);
      if (!provider.generateEmbedding) {
        throw new Error(
          `Provider "${providerName}" does not support embeddings`,
        );
      }

      const providerOptions = {};
      if (options.taskType) providerOptions.taskType = options.taskType;
      if (options.dimensions) providerOptions.dimensions = options.dimensions;

      result = await provider.generateEmbedding(
        content,
        resolvedModel,
        providerOptions,
      );
    } catch (err) {
      success = false;
      errorMessage = err.message;
      throw err;
    } finally {
      const totalSec = (performance.now() - requestStart) / 1000;

      // Cost estimation
      const pricing = getPricing(TYPES.TEXT, TYPES.EMBEDDING)[resolvedModel];
      const approxInputTokens =
        typeof content === "string" ? estimateTokens(content) : 100;
      let estimatedCost = null;
      if (pricing?.inputPerMillion) {
        estimatedCost = (approxInputTokens / 1_000_000) * pricing.inputPerMillion;
      }

      const source = options.source || "unknown";

      // Determine input content type for payload logging
      const contentType = typeof content === "string" ? "text"
        : Array.isArray(content) ? "multimodal"
          : "unknown";
      const inputCharacters = typeof content === "string" ? content.length : 0;

      logger.request(
        options.project || null,
        options.username || "system",
        options.clientIp || null,
        `[embed] ${providerName} model=${resolvedModel} source=${source} — ` +
          (success
            ? `dims: ${result?.dimensions}, total: ${totalSec.toFixed(2)}s`
            : `FAILED: ${errorMessage}`) +
          formatCostTag(estimatedCost),
      );

      RequestLogger.log({
        requestId,
        endpoint: options.endpoint || null,
        operation: `embed:${source}`,
        project: options.project || null,
        username: options.username || "system",
        clientIp: options.clientIp || null,
        agent: options.agent || null,
        provider: providerName,
        model: resolvedModel,
        sessionId: options.sessionId || null,
        success,
        errorMessage,
        estimatedCost,
        inputTokens: approxInputTokens,
        outputTokens: result?.dimensions || 0,
        tokensPerSec: calculateTokensPerSec(approxInputTokens, totalSec),
        inputCharacters,
        totalTime: parseFloat(totalSec.toFixed(3)),
        modalities: (() => {
          const mod = { embeddingOut: true };
          if (typeof content === "string") {
            mod.textIn = true;
          } else if (Array.isArray(content)) {
            for (const part of content) {
              if (part.text) mod.textIn = true;
              const mime = part.inlineData?.mimeType || "";
              if (mime.startsWith("image/")) mod.imageIn = true;
              else if (mime.startsWith("audio/")) mod.audioIn = true;
              else if (mime.startsWith("video/")) mod.videoIn = true;
              else if (mime === "application/pdf") mod.docIn = true;
            }
          }
          return mod;
        })(),
        requestPayload: {
          source,
          contentType,
          ...(options.taskType ? { taskType: options.taskType } : {}),
          ...(options.dimensions ? { dimensions: options.dimensions } : {}),
          ...(contentType === "text" ? { text: typeof content === "string" ? content : "" } : {}),
        },
        responsePayload: success
          ? {
              dimensions: result?.dimensions || null,
              embeddingPreview: result?.embedding?.slice(0, 5) || null,
            }
          : { error: errorMessage },
      });
    }

    return {
      embedding: result.embedding,
      dimensions: result.dimensions,
      provider: providerName,
      model: resolvedModel,
    };
  },

  /**
   * Convenience wrapper — returns just the embedding vector.
   * Used by internal callers that only need the float array.
   *
   * @param {string} text - Text to embed
   * @param {object} [options] - Same as generate()
   * @returns {Promise<number[]>}
   */
  async embed(text, options = {}) {
    const result = await this.generate(text, options);
    return result.embedding;
  },
};

export default EmbeddingService;

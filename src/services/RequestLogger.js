import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";
import { getTotalInputTokens } from "../utils/CostCalculator.js";
import { computeModalities } from "./ConversationService.js";

const COLLECTION = "requests";

const API_TO_CANONICAL = {
  googleSearch: "Google Search",
  googleSearchRetrieval: "Google Search",
  web_search: "Web Search",
  webSearch: "Web Search",
  webFetch: "Web Fetch",
  codeExecution: "Code Execution",
  code_execution: "Code Execution",
  computerUse: "Computer Use",
  computer_use: "Computer Use",
  fileSearch: "File Search",
  file_search: "File Search",
  urlContext: "URL Context",
  url_context: "URL Context",
  thinking: "Thinking",
  imageGeneration: "Image Generation",
  image_generation: "Image Generation",
};

function sanitizeMsg(m) {
  const sanitizeStr = (s) => (typeof s === "string" && s.startsWith("data:") ? `[base64 data]` : s);
  const sanitizeMedia = (val) => {
    if (Array.isArray(val)) return val.map(sanitizeStr);
    if (typeof val === "string") return sanitizeStr(val);
    return val;
  };

  return {
    role: m.role,
    content:
      typeof m.content === "string"
        ? m.content.length > 500
          ? m.content.slice(0, 500) + "…"
          : m.content
        : m.content,
    ...(m.images?.length ? { images: sanitizeMedia(m.images) } : {}),
    ...(m.audio ? { audio: sanitizeMedia(m.audio) } : {}),
    ...(m.video?.length ? { video: sanitizeMedia(m.video) } : {}),
    ...(m.pdf?.length ? { pdf: sanitizeMedia(m.pdf) } : {}),
  };
}

const RequestLogger = {
  /**
   * Log a text-to-text request to MongoDB (fire-and-forget).
   */
  async log({
    requestId,
    endpoint,
    project,
    username,
    clientIp = null,
    provider,
    model,
    conversationId = null,
    toolsUsed = false,
    toolNames = [],
    success,
    errorMessage = null,
    inputTokens = 0,
    outputTokens = 0,
    estimatedCost = null,
    tokensPerSec = null,
    temperature = null,
    maxTokens = null,
    topP = null,
    topK = null,
    frequencyPenalty = null,
    presencePenalty = null,
    stopSequences = null,
    messageCount = 0,
    inputCharacters = 0,
    outputCharacters = 0,
    timeToGeneration = null,
    generationTime = null,
    totalTime = null,
    requestPayload = null,
    responsePayload = null,
    modalities = null,
  }) {
    try {
      const client = MongoWrapper.getClient(MONGO_DB_NAME);
      if (!client) {
        logger.error("RequestLogger: MongoDB client not available");
        return;
      }

      const doc = {
        requestId,
        timestamp: new Date().toISOString(),
        endpoint,
        project,
        username,
        clientIp,
        provider,
        model,
        conversationId,
        toolsUsed,
        toolNames,
        success,
        errorMessage,
        inputTokens,
        outputTokens,
        estimatedCost,
        tokensPerSec,
        temperature,
        maxTokens,
        topP,
        topK,
        frequencyPenalty,
        presencePenalty,
        stopSequences,
        messageCount,
        inputCharacters,
        outputCharacters,
        timeToGeneration,
        generationTime,
        totalTime,
        requestPayload,
        responsePayload,
        modalities,
      };

      await client.db(MONGO_DB_NAME).collection(COLLECTION).insertOne(doc);
    } catch (error) {
      logger.error("RequestLogger: failed to save request", error.message);
    }
  },

  /**
   * High-level utility to format and log a chat-like generation.
   * Centralizes the formatting of request payloads, telemetry, and tokens.
   */
  async logChatGeneration({
    requestId,
    endpoint = "chat",
    project,
    username,
    clientIp = null,
    provider,
    model,
    conversationId = null,
    success = true,
    errorMessage = null,
    
    // Telemetry
    usage,
    estimatedCost = null,
    tokensPerSec = null,
    timeToGenerationSec = null,
    generationSec = null,
    totalSec = null,
    
    // Inputs
    options = {},
    messages = [],
    
    // Outputs
    text = null,
    thinking = null,
    images = [],
    toolCalls = [],
    outputCharacters = 0,
    audioRef = null,
    // Optional
    agenticIteration = null,
  }) {
    const inputTokens = usage ? getTotalInputTokens(usage) : 0;
    const outputTokens = usage ? (usage.outputTokens || 0) : 0;

    // Build synthetic message array for computeModalities (same function used by conversations)
    const syntheticMessages = [
      ...messages,
      {
        role: "assistant",
        content: text || null,
        ...(images && images.length > 0 ? { images } : {}),
        ...(audioRef ? { audio: audioRef } : {}),
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
        ...(thinking ? { thinking } : {}),
      },
    ];
    const modalities = computeModalities(syntheticMessages);

    // If the model produced output tokens but computeModalities didn't detect
    // textOut (e.g. tool-call-only iterations in agentic loops), infer it
    if (outputTokens > 0 && !modalities.textOut) {
      modalities.textOut = true;
    }

    return this.log({
      requestId,
      endpoint,
      project,
      username,
      clientIp,
      provider,
      model,
      conversationId,
      toolsUsed: toolCalls && toolCalls.length > 0,
      toolNames: toolCalls && toolCalls.length > 0 ? [...new Set(toolCalls.map((tc) => API_TO_CANONICAL[tc.name] || tc.name))] : [],
      success,
      errorMessage,
      inputTokens,
      outputTokens,
      estimatedCost,
      tokensPerSec,
      temperature: options?.temperature ?? null,
      maxTokens: options?.maxTokens ?? null,
      topP: options?.topP ?? null,
      topK: options?.topK ?? null,
      frequencyPenalty: options?.frequencyPenalty ?? null,
      presencePenalty: options?.presencePenalty ?? null,
      stopSequences: options?.stopSequences ?? null,
      messageCount: messages.length,
      inputCharacters: messages.reduce(
        (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
        0,
      ),
      outputCharacters,
      timeToGeneration: timeToGenerationSec !== null ? parseFloat(timeToGenerationSec.toFixed(3)) : null,
      generationTime: generationSec !== null ? parseFloat(generationSec.toFixed(3)) : null,
      totalTime: totalSec !== null ? parseFloat(totalSec.toFixed(3)) : null,
      requestPayload: {
        messages: messages.map(sanitizeMsg),
        ...(options?.tools ? { tools: options.tools.map((t) => t.name || t.function?.name) } : {}),
        ...(agenticIteration !== null ? { agenticIteration } : {}),
      },
      responsePayload: {
        text: text && text.length > 2000 ? text.slice(0, 2000) + "…" : text || null,
        thinking: thinking ? "[present]" : null,
        ...(images && images.length > 0 ? { images } : {}),
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls.map((tc) => ({ name: API_TO_CANONICAL[tc.name] || tc.name, id: tc.id, args: tc.args })) : null,
        ...(audioRef ? { audioRef } : {}),
        usage,
      },
      modalities,
    });
  },
};

export default RequestLogger;

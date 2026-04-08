import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import FileService from "./FileService.js";
import logger from "../utils/logger.js";
import RequestLogger from "./RequestLogger.js";
import { calculateImageCost } from "../utils/CostCalculator.js";
import { getModelByName } from "../config.js";

// ────────────────────────────────────────────────────────────
// Built-in tools — handled natively by the agentic loop
// instead of routing through tools-api.
// ────────────────────────────────────────────────────────────

const IMAGE_MODEL = "gemini-3.1-flash-image-preview";
const IMAGE_PROVIDER = "google";

/**
 * Tool schemas — same format as tools-api schemas (without endpoint metadata).
 * These get merged into the LLM's tool list alongside tools-api and MCP tools.
 */
const BUILT_IN_SCHEMAS = [
  {
    name: "generate_image",
    description:
      "Generate an image from a detailed text prompt using AI image generation. " +
      "Can also edit or redraw existing images from the conversation when reference images are available. " +
      "Always provide a highly detailed, descriptive prompt for best results — include specifics about style, " +
      "composition, subjects, colors, mood, lighting, and artistic direction. " +
      "The generated image will be delivered to the user automatically.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "A detailed text prompt describing the image to generate. " +
            "Be specific about style, composition, subjects, colors, mood, " +
            "lighting, perspective, and artistic direction. The more detail, the better the result.",
        },
      },
      required: ["prompt"],
    },
  },
];

const builtInMap = new Map(BUILT_IN_SCHEMAS.map((t) => [t.name, t]));

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

export default class BuiltInTools {
  /**
   * Get all built-in tool schemas (for merging into the LLM tool list).
   * @returns {Array<object>}
   */
  static getSchemas() {
    return BUILT_IN_SCHEMAS;
  }

  /**
   * Check if a tool name is a built-in tool.
   * @param {string} name
   * @returns {boolean}
   */
  static isBuiltIn(name) {
    return builtInMap.has(name);
  }

  /**
   * Execute a built-in tool.
   *
   * @param {string} name   - Tool name
   * @param {object} args   - Tool arguments
   * @param {object} ctx    - Execution context from AgenticLoopService
   * @param {Array}  ctx.messages  - Current conversation messages (with resolved image data URLs)
   * @param {string} ctx.project   - Project identifier
   * @param {string} ctx.username  - Username for tracking
   * @returns {Promise<object>} - Tool result (may contain _image for AgenticLoopService to handle)
   */
  static async execute(name, args, ctx) {
    if (name === "generate_image") {
      return BuiltInTools._executeGenerateImage(args, ctx);
    }
    return { error: `Unknown built-in tool: ${name}` };
  }

  // ────────────────────────────────────────────────────────────
  // generate_image implementation
  // ────────────────────────────────────────────────────────────

  /**
   * Generate an image using Google Gemini.
   *
   * Collects reference images from the conversation history so the model
   * can use them for image-to-image editing when relevant. Uploads the
   * result to MinIO and returns metadata + a private `_image` field that
   * AgenticLoopService picks up to emit the image event and track it.
   */
  static async _executeGenerateImage(args, ctx) {
    const { prompt } = args;
    const { messages, project, username, sessionId, conversationId, clientIp, requestId, agenticIteration } = ctx;

    if (!prompt) {
      return { error: "Missing required parameter: prompt" };
    }

    try {
      const provider = getProvider(IMAGE_PROVIDER);

      // Collect reference images from conversation — the most recent user
      // messages that have images attached. These are already resolved to
      // base64 data URLs by resolveImageRefs in chat.js.
      const referenceImages = [];
      for (const msg of messages) {
        if (msg.images && Array.isArray(msg.images)) {
          for (const img of msg.images) {
            if (typeof img === "string" && img.startsWith("data:")) {
              referenceImages.push(img);
            }
          }
        }
      }

      logger.info(
        `[BuiltInTools] generate_image: prompt="${prompt.slice(0, 80)}…" ` +
          `referenceImages=${referenceImages.length}`,
      );

      // Build messages for the image generation call
      const imageGenMessages = [
        {
          role: "user",
          content: prompt,
          ...(referenceImages.length > 0 && { images: referenceImages }),
        },
      ];

      // Call Google's non-streaming generateText — handles images natively
      // when the model has IMAGE output types. forceImageGeneration sets
      // responseModalities to ["IMAGE"] for image-only output.
      const toolRequestStart = performance.now();
      const result = await provider.generateText(
        imageGenMessages,
        IMAGE_MODEL,
        { forceImageGeneration: true },
      );
      const toolTotalSec = (performance.now() - toolRequestStart) / 1000;

      // Content safety block — Gemini refused
      if (result.safetyBlock) {
        return {
          success: false,
          error:
            "Image generation was blocked by content safety filters. " +
            "Try rephrasing the prompt to avoid potentially problematic content.",
        };
      }

      // No image in response
      if (!result.images || result.images.length === 0) {
        return {
          success: false,
          error:
            "No image was generated. The model may have returned text instead. " +
            "Try a more specific and descriptive prompt.",
        };
      }

      // Upload to MinIO
      const image = result.images[0];
      let minioRef = null;
      try {
        const dataUrl = `data:${image.mimeType || "image/png"};base64,${image.data}`;
        const { ref } = await FileService.uploadFile(
          dataUrl,
          "generations",
          project,
          username,
        );
        minioRef = ref;
      } catch (err) {
        logger.error(
          `[BuiltInTools] MinIO upload failed: ${err.message}`,
        );
      }

      logger.info(
        `[BuiltInTools] generate_image: success, minioRef=${minioRef || "none"}`,
      );

      // Log the image generation request so it appears in admin dashboard
      // with the correct model (Gemini) instead of the parent agent model.
      const modelDef = getModelByName(IMAGE_MODEL);
      const estimatedCost = calculateImageCost(
        prompt,
        modelDef?.pricing,
        referenceImages.length,
        modelDef?.imageTokensPerImage || 1120,
      );
      const usage = result.usage || { inputTokens: 0, outputTokens: 0 };
      const outputTokens = usage.outputTokens || 0;
      const tokensPerSec = toolTotalSec > 0 && outputTokens > 0
        ? parseFloat((outputTokens / toolTotalSec).toFixed(1))
        : null;

      RequestLogger.logChatGeneration({
        requestId: requestId ? `${requestId}-img-${agenticIteration || 0}` : crypto.randomUUID(),
        endpoint: "agent",
        operation: "agent:image",
        project,
        username,
        clientIp: clientIp || null,
        provider: IMAGE_PROVIDER,
        model: IMAGE_MODEL,
        conversationId: conversationId || null,
        sessionId: sessionId || null,
        success: true,
        usage,
        estimatedCost,
        tokensPerSec,
        totalSec: toolTotalSec,
        options: { forceImageGeneration: true },
        messages: imageGenMessages,
        images: [minioRef || "[generated]"],
        text: result.text || null,
        toolCalls: [],
        outputCharacters: result.text?.length || 0,
        agenticIteration: agenticIteration || null,
      }).catch((err) =>
        logger.error(`[BuiltInTools] Failed to log image generation request: ${err.message}`),
      );

      // Return the result with a private _image field.
      // AgenticLoopService picks this up to:
      //   1. Emit the image event to the client
      //   2. Track it in streamedImages for conversation persistence
      //   3. Strip _image from the tool result before it enters LLM context
      return {
        success: true,
        message: "Image generated and delivered to the user.",
        description: result.text || null,
        // Private — consumed by AgenticLoopService, NOT sent to LLM context
        _image: {
          data: image.data,
          mimeType: image.mimeType || "image/png",
          minioRef,
        },
      };
    } catch (err) {
      logger.error(`[BuiltInTools] generate_image failed: ${err.message}`);
      return { error: `Image generation failed: ${err.message}` };
    }
  }
}

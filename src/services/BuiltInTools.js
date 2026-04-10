import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import FileService from "./FileService.js";
import logger from "../utils/logger.js";
import RequestLogger from "./RequestLogger.js";
import { calculateImageCost, calculateTextCost } from "../utils/CostCalculator.js";
import { getModelByName } from "../config.js";
import { calculateTokensPerSec } from "../utils/math.js";

// ────────────────────────────────────────────────────────────
// Built-in tools — handled natively by the agentic loop
// instead of routing through tools-api.
// ────────────────────────────────────────────────────────────

const IMAGE_MODEL = "gemini-3.1-flash-image-preview";
const IMAGE_PROVIDER = "google";
const VISION_MODEL = "gemini-3-flash-preview";
const VISION_PROVIDER = "google";

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
      "The generated image will be delivered to the user automatically. " +
      "IMPORTANT: Do NOT call this tool unless the user's current message explicitly asks for an " +
      "image, drawing, painting, illustration, or artwork. Never call it for greetings, " +
      "questions, or casual conversation.",
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
  {
    name: "describe_image",
    description:
      "Describe the visual contents of one or more images (avatars, banners, photos, etc.) " +
      "by URL. Returns a text description of each image. Use this when you need to understand " +
      "what someone looks like (their avatar or banner) before generating artwork, or when " +
      "you need to describe any image from a URL. IMPORTANT: Always batch ALL image URLs " +
      "into a single call — pass all URLs in the imageUrls array at once. " +
      "Never make multiple separate calls for individual URLs.",
    parameters: {
      type: "object",
      properties: {
        imageUrls: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of image URLs to describe. Can be Discord avatar URLs, " +
            "banner URLs, or any publicly accessible image URL.",
        },
        context: {
          type: "string",
          enum: ["avatar", "banner", "photo", "general"],
          description:
            "What kind of image this is, to tailor the description. " +
            "Use 'avatar' for profile pictures, 'banner' for profile banners, " +
            "'photo' for user-uploaded photos, 'general' for anything else.",
        },
      },
      required: ["imageUrls"],
    },
  },
];

const builtInMap = new Map(BUILT_IN_SCHEMAS.map((t) => [t.name, t]));

// Per-request vision dedup cache: prevents the agent from describing the
// same image URL multiple times within one agentic session.
// Keyed by requestId → Map<url, description>
const visionCache = new Map();
const VISION_CACHE_TTL_MS = 5 * 60 * 1000; // Auto-cleanup after 5 min

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
    if (name === "describe_image") {
      return BuiltInTools._executeDescribeImage(args, ctx);
    }
    return { error: `Unknown built-in tool: ${name}` };
  }

  // ────────────────────────────────────────────────────────────
  // generate_image — content safety fallback (prompt softening)
  // ────────────────────────────────────────────────────────────

  /**
   * Maximum number of automatic retries when content safety filters block
   * image generation. Each retry progressively softens the prompt.
   */
  static MAX_SAFETY_RETRIES = 3;

  /**
   * Progressive prompt-softening substitutions applied on each safety retry.
   * Each tier is more conservative than the last. Substitutions are applied
   * cumulatively — tier 2 includes tier 1 changes, etc.
   *
   * This implements the "graceful degradation" pattern: the visual intent
   * is preserved while problematic content descriptors are replaced with
   * creatively equivalent, policy-compliant alternatives.
   */
  static SAFETY_SOFTENING_TIERS = [
    // ── Tier 1: Direct substitutions (nudity → clothing, violence → calm) ──
    [
      [/\bnaked\b/gi, "wearing flowing silk robes"],
      [/\bnude\b/gi, "draped in elegant fabric"],
      [/\bnudity\b/gi, "draped in flowing garments"],
      [/\btopless\b/gi, "in a strapless gown"],
      [/\bshirtless\b/gi, "in an open-collar shirt"],
      [/\bbare[\s-]?chest(ed)?\b/gi, "in a loosely unbuttoned shirt"],
      [/\bundress(ed|ing)?\b/gi, "in minimal elegant attire"],
      [/\bstrip(ping|ped)?\b/gi, "adjusting flowing robes"],
      [/\bexposed\s+(skin|body|flesh)\b/gi, "visible silhouette through sheer fabric"],
      [/\bseductive\b/gi, "alluring"],
      [/\bsexual(ly)?\b/gi, "romantically"],
      [/\bsensual\b/gi, "graceful"],
      [/\berotic\b/gi, "romantic"],
      [/\bprovocative\b/gi, "striking"],
      [/\bintimate\b/gi, "tender"],
      [/\blingerie\b/gi, "elegant nightwear"],
      [/\bunderwear\b/gi, "loungewear"],
      [/\bbikini\b/gi, "summer outfit"],
      [/\bskimpy\b/gi, "lightweight"],
      [/\bskin[\s-]?tight\b/gi, "form-fitting"],
      [/\bcleavage\b/gi, "neckline"],
      [/\bblood(y|ied)?\b/gi, "red-stained"],
      [/\bgore\b/gi, "aftermath"],
      [/\bviolent(ly)?\b/gi, "intense"],
      [/\bviolence\b/gi, "conflict"],
      [/\bkill(ing|ed|s)?\b/gi, "defeating"],
      [/\bmurder(ed|ing|s|ous)?\b/gi, "confronting"],
      [/\bdead\s+body\b/gi, "fallen figure"],
      [/\bcorpse\b/gi, "fallen figure"],
      [/\bweapon\b/gi, "tool"],
      [/\bgun\b/gi, "device"],
      [/\bdrunk(en)?\b/gi, "carefree"],
      [/\bsmoking\b/gi, "holding an ornate pipe"],
      [/\bdrug(s|ged)?\b/gi, "potion"],
    ],
    // ── Tier 2: Broader softening + artistic framing ──
    [
      [/\bbody\b/gi, "figure"],
      [/\bflesh\b/gi, "form"],
      [/\bskin\b/gi, "complexion"],
      [/\bcurves\b/gi, "silhouette"],
      [/\bcurvy\b/gi, "statuesque"],
      [/\btight\b/gi, "fitted"],
      [/\bsweat(y|ing)?\b/gi, "glistening"],
      [/\bwet\b/gi, "rain-kissed"],
      [/\bfight(ing|s)?\b/gi, "sparring"],
      [/\bstab(bing|bed)?\b/gi, "striking"],
      [/\battack(ing|ed|s)?\b/gi, "charging at"],
      [/\bdestroy(ing|ed|s)?\b/gi, "transforming"],
      [/\bexplod(e|ing|ed|es)\b/gi, "erupting with energy"],
      [/\bfire\b/gi, "golden light"],
      [/\bburning\b/gi, "glowing warmly"],
    ],
    // ── Tier 3: Nuclear option — wrap in fine-art framing ──
    [
      [/^/i, "A tasteful Renaissance-style oil painting depicting: "],
      [/\b(sexy|hot)\b/gi, "beautiful"],
      [/\b(ass|butt|buttocks)\b/gi, "figure from behind"],
      [/\bbreasts?\b/gi, "torso"],
      [/\bthigh(s)?\b/gi, "lower silhouette"],
      [/\bwaist\b/gi, "midsection"],
      [/\bhips?\b/gi, "form"],
      [/\bbed(room)?\b/gi, "chamber"],
      [/\bshower\b/gi, "waterfall scene"],
      [/\bbath(ing|e)?\b/gi, "near a serene pool"],
    ],
  ];

  /**
   * Apply a specific softening tier to a prompt string.
   * @param {string} prompt - The current prompt
   * @param {number} tier - 0-indexed tier to apply (0 = tier 1, etc.)
   * @returns {string} Softened prompt
   */
  static _softenPrompt(prompt, tier) {
    let softened = prompt;
    // Apply all tiers up to and including the requested one (cumulative)
    for (let t = 0; t <= tier && t < BuiltInTools.SAFETY_SOFTENING_TIERS.length; t++) {
      for (const [pattern, replacement] of BuiltInTools.SAFETY_SOFTENING_TIERS[t]) {
        softened = softened.replace(pattern, replacement);
      }
    }
    return softened;
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
   *
   * If content safety filters block the generation, the prompt is
   * progressively softened and retried up to MAX_SAFETY_RETRIES times
   * (graceful degradation / content policy fallback).
   */
  static async _executeGenerateImage(args, ctx) {
    const { prompt } = args;
    const { messages, project, username, sessionId, conversationId, clientIp, agent, requestId, agenticIteration } = ctx;

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

      // ── Attempt generation with progressive safety fallback ──
      let currentPrompt = prompt;
      let result = null;
      let toolRequestStart = null;
      let toolTotalSec = 0;
      let safetyRetries = 0;
      let imageGenMessages = null;

      for (let attempt = 0; attempt <= BuiltInTools.MAX_SAFETY_RETRIES; attempt++) {
        imageGenMessages = [
          {
            role: "user",
            content: currentPrompt,
            ...(referenceImages.length > 0 && { images: referenceImages }),
          },
        ];

        toolRequestStart = performance.now();
        result = await provider.generateText(
          imageGenMessages,
          IMAGE_MODEL,
          { forceImageGeneration: true },
        );
        toolTotalSec = (performance.now() - toolRequestStart) / 1000;

        // Success — we got an image
        if (!result.safetyBlock && result.images?.length > 0) {
          break;
        }

        // Safety block or no image — can we retry with a softer prompt?
        if (attempt < BuiltInTools.MAX_SAFETY_RETRIES) {
          safetyRetries++;
          const previousPrompt = currentPrompt;
          currentPrompt = BuiltInTools._softenPrompt(prompt, attempt);

          // If softening didn't change anything, no point retrying
          if (currentPrompt === previousPrompt) {
            logger.warn(
              `[BuiltInTools] generate_image: safety softening had no effect at tier ${attempt + 1}, stopping retries`,
            );
            break;
          }

          logger.info(
            `[BuiltInTools] generate_image: safety block on attempt ${attempt + 1}, ` +
              `retrying with softened prompt (tier ${attempt + 1}): "${currentPrompt.slice(0, 100)}…"`,
          );
        }
      }

      // All attempts exhausted — still blocked
      if (result.safetyBlock) {
        logger.warn(
          `[BuiltInTools] generate_image: all ${safetyRetries + 1} attempts blocked by safety filters`,
        );
        return {
          success: false,
          error:
            "Image generation was blocked by content safety filters after " +
            `${safetyRetries + 1} attempts (including softened prompts). ` +
            "The content may be too explicit to generate even with creative alternatives.",
        };
      }

      // No image in response (model returned text instead)
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
        `[BuiltInTools] generate_image: success` +
          `${safetyRetries > 0 ? ` (after ${safetyRetries} safety retries)` : ""}` +
          `, minioRef=${minioRef || "none"}`,
      );

      // Log the image generation request so it appears in admin dashboard
      // with the correct model (Gemini) instead of the parent agent model.
      const modelDef = getModelByName(IMAGE_MODEL);
      const estimatedCost = calculateImageCost(
        currentPrompt,
        modelDef?.pricing,
        referenceImages.length,
        modelDef?.imageTokensPerImage || 1120,
      );
      const usage = result.usage || { inputTokens: 0, outputTokens: 0 };
      const outputTokens = usage.outputTokens || 0;
      const tokensPerSec = calculateTokensPerSec(outputTokens, toolTotalSec);

      RequestLogger.logChatGeneration({
        requestId: requestId ? `${requestId}-img-${agenticIteration || 0}` : crypto.randomUUID(),
        endpoint: "/agent",
        operation: "agent:image",
        project,
        username,
        clientIp: clientIp || null,
        agent: agent || null,
        provider: IMAGE_PROVIDER,
        model: IMAGE_MODEL,
        conversationId: conversationId || null,
        sessionId: sessionId || null,
        success: true,
        usage,
        estimatedCost,
        tokensPerSec,
        totalSec: toolTotalSec,
        options: {
          forceImageGeneration: true,
          ...(safetyRetries > 0 && {
            safetyRetries,
            originalPrompt: prompt.slice(0, 200),
            softenedPrompt: currentPrompt.slice(0, 200),
          }),
        },
        messages: imageGenMessages,
        images: [minioRef || "[generated]"],
        text: result.text || null,
        toolCalls: [],
        outputCharacters: result.text?.length || 0,
        agenticIteration: agenticIteration || null,
      }).catch((err) =>
        logger.error(`[BuiltInTools] Failed to log image generation request: ${err.message}`),
      );

      // Build the tool result message — note if prompt was softened
      const resultMessage = safetyRetries > 0
        ? "Image generated and delivered to the user. Note: the original prompt was " +
          "automatically softened to comply with content safety filters (e.g., nudity " +
          "replaced with robes/clothing, violence with calmer alternatives). The image " +
          "captures the spirit of the request with a more tasteful interpretation."
        : "Image generated and delivered to the user.";

      // Return the result with a private _image field.
      // AgenticLoopService picks this up to:
      //   1. Emit the image event to the client
      //   2. Track it in streamedImages for conversation persistence
      //   3. Strip _image from the tool result before it enters LLM context
      return {
        success: true,
        message: resultMessage,
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

  // ────────────────────────────────────────────────────────────
  // describe_image implementation
  // ────────────────────────────────────────────────────────────

  /**
   * Describe the visual contents of one or more images via the vision API.
   * Returns text descriptions that the agent can use when composing image
   * generation prompts (e.g., to know what someone's avatar looks like).
   */
  static async _executeDescribeImage(args, ctx) {
    const { imageUrls, context = "general" } = args;
    const { project, username, sessionId, conversationId, clientIp, agent, requestId, agenticIteration } = ctx;

    if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
      return { error: "Missing required parameter: imageUrls (array of URLs)" };
    }

    // Tailor the prompt based on image context
    const prompts = {
      avatar: "Describe this profile picture/avatar. Focus on the person's appearance, " +
        "style, notable features, and any artistic elements. Make no mention about quality or resolution.",
      banner: "Describe this profile banner image. Focus on the scene, colors, mood, " +
        "and notable elements. Make no mention about quality or resolution.",
      photo: "Describe this image. Make no mention about the quality, resolution, or pixelation.",
      general: "Describe this image. Make no mention about the quality, resolution, or pixelation.",
    };
    const prompt = prompts[context] || prompts.general;

    try {
      const provider = getProvider(VISION_PROVIDER);
      const descriptions = [];

      // Get or create per-request cache (stores Promises for singleflight dedup)
      if (!visionCache.has(requestId)) {
        visionCache.set(requestId, new Map());
        // Auto-cleanup to prevent memory leaks
        setTimeout(() => visionCache.delete(requestId), VISION_CACHE_TTL_MS);
      }
      const urlCache = visionCache.get(requestId);

      // Deduplicate URLs within this call
      const uniqueUrls = [...new Set(imageUrls)];

      for (const url of uniqueUrls) {
        // Singleflight: if a request for this URL is already in-flight (from
        // a parallel tool call), await it instead of firing a duplicate.
        if (urlCache.has(url)) {
          const cached = await urlCache.get(url);
          descriptions.push({ url, description: cached });
          logger.info(`[BuiltInTools] describe_image: cache hit for ${url.slice(0, 60)}…`);
          continue;
        }

        // Store the promise IMMEDIATELY so parallel calls can await it
        const descriptionPromise = (async () => {
          const toolRequestStart = performance.now();
          const result = await provider.generateText(
            [{ role: "user", content: prompt, images: [url] }],
            VISION_MODEL,
            {},
          );
          const toolTotalSec = (performance.now() - toolRequestStart) / 1000;

          const text = result.text || "Unable to describe this image.";

          // Log each vision call
          const usage = result.usage || { inputTokens: 0, outputTokens: 0 };
          const tokensPerSec = calculateTokensPerSec(
            usage.outputTokens || 0,
            toolTotalSec,
          );

          // Calculate cost from pricing config (Google provider doesn't return estimatedCost)
          const modelDef = getModelByName(VISION_MODEL);
          const estimatedCost = calculateTextCost(usage, modelDef?.pricing);

          RequestLogger.logChatGeneration({
            requestId: requestId ? `${requestId}-vision-${agenticIteration || 0}` : crypto.randomUUID(),
            endpoint: "/agent",
            operation: "agent:vision",
            project,
            username,
            clientIp: clientIp || null,
            agent: agent || null,
            provider: VISION_PROVIDER,
            model: result.model || VISION_MODEL,
            conversationId: conversationId || null,
            sessionId: sessionId || null,
            success: true,
            usage,
            estimatedCost,
            tokensPerSec,
            totalSec: toolTotalSec,
            options: {},
            messages: [{ role: "user", content: prompt, images: [url] }],
            images: [],
            text,
            toolCalls: [],
            outputCharacters: text.length,
            agenticIteration: agenticIteration || null,
          }).catch((err) =>
            logger.error(`[BuiltInTools] Failed to log vision request: ${err.message}`),
          );

          return text;
        })();

        // Store promise in cache BEFORE awaiting — this is what makes singleflight work
        urlCache.set(url, descriptionPromise);

        const text = await descriptionPromise;
        descriptions.push({ url, description: text });
      }

      logger.info(
        `[BuiltInTools] describe_image: described ${descriptions.length} image(s), ` +
          `context=${context}`,
      );

      return {
        success: true,
        descriptions,
      };
    } catch (err) {
      logger.error(`[BuiltInTools] describe_image failed: ${err.message}`);
      return { error: `Image description failed: ${err.message}` };
    }
  }
}

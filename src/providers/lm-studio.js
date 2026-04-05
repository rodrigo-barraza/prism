// ─────────────────────────────────────────────────────────────
// LM Studio provider
// Models with explicit reasoning capability (capabilities.reasoning)
// support toggling via chat_template_kwargs.enable_thinking.
// Models WITHOUT it always emit <think> tags, so the parser runs
// regardless and the Retina UI locks the toggle on.
// ─────────────────────────────────────────────────────────────

import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { resolveArchParams } from "../utils/gguf-arch.js";
import { LM_STUDIO_BASE_URL } from "../../secrets.js";
import { TYPES, getDefaultModels } from "../config.js";
import { sleep } from "../utils/media.js";
import { writeFileSync } from "node:fs";
import {
  convertToolsToOpenAI,
  buildPayloadParams,
  prepareOpenAICompatMessages,
  processNonStreamingResponse,
  parseSSEStream,
  fetchOpenAICompat,
  MEDIA_STRATEGIES,
} from "../utils/openai-compat.js";

function getBaseUrl() {
  return LM_STUDIO_BASE_URL;
}

const lmStudioProvider = {
  name: "lm-studio",

  async generateText(
    messages,
    model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["lm-studio"],
    options = {},
  ) {
    const baseUrl = getBaseUrl();
    logger.provider(
      "LM Studio",
      `generateText model=${model} baseUrl=${baseUrl}`,
    );
    try {
      const prepared = prepareOpenAICompatMessages(messages, {
        mediaStrategy: MEDIA_STRATEGIES.IMAGES_ONLY,
      });

      const payload = {
        messages: prepared,
        model,
        ...buildPayloadParams(options),
        stream: false,
      };

      // Function calling tools
      const tools = convertToolsToOpenAI(options.tools);
      if (tools) payload.tools = tools;

      // Thinking toggle — pass to LM Studio via chat_template_kwargs
      if (options.thinkingEnabled === false) {
        payload.chat_template_kwargs = { enable_thinking: false };
      }

      const response = await fetchOpenAICompat(
        `${baseUrl}/v1/chat/completions`,
        payload,
      );
      const data = await response.json();
      const { text, thinking, usage, toolCalls } =
        processNonStreamingResponse(data);

      const result = { text, thinking, usage };
      if (toolCalls) result.toolCalls = toolCalls;
      return result;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("lm-studio", error.message, 500, error);
    }
  },

  // ── Streaming Text Generation (SSE) ──────────────────────

  async *generateTextStream(
    messages,
    model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["lm-studio"],
    options = {},
  ) {
    const baseUrl = getBaseUrl();
    logger.provider(
      "LM Studio",
      `generateTextStream model=${model} baseUrl=${baseUrl}`,
    );
    try {
      // Auto-load the model if not currently loaded
      try {
        if (options.signal?.aborted) return;
        const { models } = await this.listModels();
        if (options.signal?.aborted) return;
        const modelEntry = (models || []).find((m) => m.key === model);
        const isLoaded = modelEntry?.loaded_instances?.length > 0;
        if (!isLoaded) {
          // Unload any other loaded models first (single-model enforcement)
          for (const m of models || []) {
            if (options.signal?.aborted) return;
            for (const inst of m.loaded_instances || []) {
              yield { type: "status", message: "Unloading previous model…" };
              logger.info(`Auto-unloading ${inst.id} before loading ${model}`);
              await this.unloadModel(inst.id);
            }
          }

          if (options.signal?.aborted) return;
          logger.info(`Auto-loading model ${model} for streaming`);
          yield { type: "status", message: "Loading model… 0%" };

          // Start load (non-blocking) and poll for progress
          let loadDone = false;
          let loadError = null;
          const loadPromise = this.loadModel(model, {}, options.signal)
            .then(() => {
              loadDone = true;
            })
            .catch((err) => {
              loadDone = true;
              // Don't treat AbortError as a load failure
              if (err.name !== "AbortError") loadError = err;
            });

          const startTime = Date.now();
          const EXPECTED_LOAD_MS = 15_000;
          let lastPct = 0;

          while (!loadDone) {
            await sleep(500);
            if (options.signal?.aborted) {
              logger.info(`[LM-Studio] Aborted during model load for ${model}`);
              // Schedule background unload to free VRAM
              this.unloadModelByKey(model).catch((e) =>
                logger.warn(`[LM-Studio] Failed to unload ${model} after abort: ${e.message}`),
              );
              return;
            }
            if (loadDone) break;

            const elapsed = Date.now() - startTime;
            const pct = Math.min(
              95,
              Math.round((elapsed / (elapsed + EXPECTED_LOAD_MS)) * 100),
            );
            if (pct > lastPct) {
              lastPct = pct;
              yield { type: "status", message: `Loading model… ${pct}%` };
            }
          }

          await loadPromise;
          if (options.signal?.aborted) {
            // Model finished loading but we're aborting — unload it
            logger.info(`[LM-Studio] Model ${model} loaded but benchmark aborted — unloading`);
            this.unloadModelByKey(model).catch((e) =>
              logger.warn(`[LM-Studio] Failed to unload ${model} after abort: ${e.message}`),
            );
            return;
          }
          if (loadError) throw loadError;
          yield { type: "status", message: "Loading model… 100%" };
        }
      } catch (loadCheckErr) {
        // If model load explicitly failed, re-throw so the generator exits
        // cleanly. runSingleModel will catch it and record an error result,
        // allowing the benchmark to continue to the next model.
        if (loadCheckErr?.cause?.type === "model_load_failed" ||
            loadCheckErr.message?.includes("Failed to load") ||
            loadCheckErr.message?.includes("API error")) {
          throw loadCheckErr;
        }
        logger.warn(
          `Could not check/load model before streaming: ${loadCheckErr.message}`,
        );
      }

      if (options.signal?.aborted) return;

      const prepared = prepareOpenAICompatMessages(messages, {
        mediaStrategy: MEDIA_STRATEGIES.IMAGES_ONLY,
      });

      const payload = {
        messages: prepared,
        model,
        ...buildPayloadParams(options),
        stream: true,
        stream_options: { include_usage: true },
      };

      // Function calling tools
      const tools = convertToolsToOpenAI(options.tools);
      if (tools) payload.tools = tools;

      // Thinking toggle — pass to LM Studio via chat_template_kwargs
      if (options.thinkingEnabled === false) {
        payload.chat_template_kwargs = { enable_thinking: false };
      }

      const payloadStr = JSON.stringify(payload, null, 2);
      logger.info(
        `[LM-Studio] Payload: ${prepared.length} msgs, ${tools ? tools.length : 0} tools, ${payloadStr.length} chars total`,
      );
      for (const m of prepared) {
        const contentLen =
          typeof m.content === "string"
            ? m.content.length
            : JSON.stringify(m.content || "").length;
        logger.info(
          `[LM-Studio]   ${m.role}${m.tool_calls ? ` (${m.tool_calls.length} tool_calls)` : ""}: ${contentLen} chars`,
        );
      }
      // Write diagnostic payload to file
      const ts = Date.now();
      try {
        writeFileSync(`/tmp/lm-studio-payload-${ts}.json`, payloadStr);
      } catch {
        /* ignore */
      }

      // Pass abort signal so client disconnection cancels the upstream request
      const response = await fetchOpenAICompat(
        `${baseUrl}/v1/chat/completions`,
        payload,
        { signal: options.signal },
      );
      logger.info(`[LM-Studio] Response status: ${response.status}`);

      const reader = response.body.getReader();
      yield* parseSSEStream(reader, { signal: options.signal });
    } catch (error) {
      if (error.name === "AbortError") return; // Client disconnected
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("lm-studio", error.message, 500, error);
    }
  },

  async captionImage(
    images,
    prompt = "Describe this image.",
    model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["lm-studio"],
    systemPrompt,
  ) {
    const baseUrl = getBaseUrl();
    logger.provider(
      "LM Studio",
      `captionImage model=${model} baseUrl=${baseUrl}`,
    );
    try {
      const content = [
        { type: "text", text: prompt },
        ...images.map((img) => ({
          type: "image_url",
          image_url: { url: img },
        })),
      ];
      const messages = [];
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content });

      const response = await fetchOpenAICompat(
        `${baseUrl}/v1/chat/completions`,
        {
          messages,
          model,
          temperature: 0.7,
          max_tokens: -1,
          stream: false,
        },
      );

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || "";
      const usage = {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      };
      return { text, usage };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("lm-studio", error.message, 500, error);
    }
  },

  // ── Model Management ─────────────────────────────────────

  /**
   * List all models available in LM Studio.
   * Uses the proprietary GET /api/v1/models endpoint.
   */
  async listModels() {
    const baseUrl = getBaseUrl();
    logger.provider("LM Studio", "listModels");
    try {
      const response = await fetch(`${baseUrl}/api/v1/models`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();

      // Enrich each model with resolved architecture params for VRAM estimation
      if (data?.data) {
        for (const model of data.data) {
          const arch = model.architecture;
          const params = model.params_string;
          const sizeBytes = model.size_bytes || 0;
          const bpw = model.quantization?.bits_per_weight || 4;
          model.archParams = resolveArchParams(arch, params, sizeBytes, bpw);
        }
      }

      return data;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("lm-studio", error.message, 500, error);
    }
  },

  /**
   * Load a model into LM Studio memory.
   */
  async loadModel(model, options = {}, signal) {
    const baseUrl = getBaseUrl();
    logger.provider("LM Studio", `loadModel model=${model}`);
    try {
      const payload = { model, echo_load_config: true };
      if (options.context_length != null) payload.context_length = options.context_length;
      if (options.flash_attention != null) payload.flash_attention = options.flash_attention;
      if (options.offload_kv_cache_to_gpu != null) payload.offload_kv_cache_to_gpu = options.offload_kv_cache_to_gpu;

      const response = await fetch(`${baseUrl}/api/v1/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        ...(signal && { signal }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      return response.json();
    } catch (error) {
      if (error.name === "AbortError") throw error; // Let AbortError propagate
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("lm-studio", error.message, 500, error);
    }
  },

  /**
   * Unload a model from LM Studio by its model key.
   * Looks up the loaded instance ID and unloads it.
   */
  async unloadModelByKey(modelKey) {
    try {
      const { models } = await this.listModels();
      for (const m of models || []) {
        if (m.key !== modelKey) continue;
        for (const inst of m.loaded_instances || []) {
          logger.info(`[LM-Studio] Unloading ${inst.id} (cleanup after abort)`);
          await this.unloadModel(inst.id);
        }
      }
    } catch (err) {
      logger.warn(`[LM-Studio] unloadModelByKey(${modelKey}) failed: ${err.message}`);
    }
  },

  /**
   * Unload a model from LM Studio memory.
   */
  async unloadModel(instanceId) {
    const baseUrl = getBaseUrl();
    logger.provider("LM Studio", `unloadModel instanceId=${instanceId}`);
    try {
      const response = await fetch(`${baseUrl}/api/v1/models/unload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: instanceId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      return response.json();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("lm-studio", error.message, 500, error);
    }
  },
};

export default lmStudioProvider;

import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { LM_STUDIO_BASE_URL } from "../../secrets.js";
import { TYPES, getDefaultModels } from "../config.js";

function getBaseUrl() {
  return LM_STUDIO_BASE_URL;
}

/**
 * Convert messages with images to OpenAI-compatible multipart content format.
 * LM Studio uses the same format as OpenAI Chat Completions.
 */
function prepareLMStudioMessages(messages) {
  return messages.map((m) => {
    const { name: _name, id: _id, ...rest } = m;
    if (m.images && m.images.length > 0) {
      const content = [];
      for (const dataUrl of m.images) {
        content.push({ type: "image_url", image_url: { url: dataUrl } });
      }
      if (m.content) {
        content.push({ type: "text", text: m.content });
      }
      return { role: rest.role, content };
    }
    return { role: rest.role, content: rest.content };
  });
}

/** Small helper — resolves after `ms` milliseconds. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const lmStudioProvider = {
  name: "lm-studio",

  async generateText(
    messages,
    model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["lm-studio"],
    options = {},
  ) {
    const baseUrl = getBaseUrl();
    logger.provider("LM Studio", `generateText model=${model} baseUrl=${baseUrl}`);
    try {
      const prepared = prepareLMStudioMessages(messages);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: prepared,
          model,
          temperature:
            options.temperature !== undefined ? options.temperature : 0.7,
          top_p: options.topP !== undefined ? options.topP : undefined,
          frequency_penalty:
            options.frequencyPenalty !== undefined
              ? options.frequencyPenalty
              : undefined,
          presence_penalty:
            options.presencePenalty !== undefined
              ? options.presencePenalty
              : undefined,
          stop:
            options.stopSequences !== undefined
              ? options.stopSequences
              : undefined,
          max_tokens: options.maxTokens || -1,
          stream: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || "";
      return {
        text,
        usage: {
          inputTokens: data.usage?.prompt_tokens ?? 0,
          outputTokens: data.usage?.completion_tokens ?? 0,
        },
      };
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
    logger.provider("LM Studio", `generateTextStream model=${model} baseUrl=${baseUrl}`);
    try {
      // Auto-load the model if not currently loaded
      try {
        const { models } = await this.listModels();
        const modelEntry = (models || []).find((m) => m.key === model);
        const isLoaded = modelEntry?.loaded_instances?.length > 0;
        if (!isLoaded) {
          // Unload any other loaded models first (single-model enforcement)
          for (const m of models || []) {
            for (const inst of m.loaded_instances || []) {
              yield { type: "status", message: "Unloading previous model…" };
              logger.info(`Auto-unloading ${inst.id} before loading ${model}`);
              await this.unloadModel(inst.id);
            }
          }

          logger.info(`Auto-loading model ${model} for streaming`);
          yield { type: "status", message: "Loading model… 0%" };

          // Start load (non-blocking) and poll for progress
          let loadDone = false;
          let loadError = null;
          const loadPromise = this.loadModel(model)
            .then(() => { loadDone = true; })
            .catch((err) => { loadDone = true; loadError = err; });

          const startTime = Date.now();
          const EXPECTED_LOAD_MS = 15_000; // soft guess for the progress curve
          let lastPct = 0;

          while (!loadDone) {
            await sleep(500);
            if (loadDone) break;

            const elapsed = Date.now() - startTime;
            // Asymptotic curve: ramps quickly at first, caps at 95%
            const pct = Math.min(95, Math.round((elapsed / (elapsed + EXPECTED_LOAD_MS)) * 100));
            if (pct > lastPct) {
              lastPct = pct;
              yield { type: "status", message: `Loading model… ${pct}%` };
            }
          }

          // Ensure promise is settled
          await loadPromise;
          if (loadError) throw loadError;
          yield { type: "status", message: "Loading model… 100%" };
        }
      } catch (loadCheckErr) {
        logger.warn(`Could not check/load model before streaming: ${loadCheckErr.message}`);
      }

      const prepared = prepareLMStudioMessages(messages);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: prepared,
          model,
          temperature:
            options.temperature !== undefined ? options.temperature : 0.7,
          top_p: options.topP !== undefined ? options.topP : undefined,
          frequency_penalty:
            options.frequencyPenalty !== undefined
              ? options.frequencyPenalty
              : undefined,
          presence_penalty:
            options.presencePenalty !== undefined
              ? options.presencePenalty
              : undefined,
          stop:
            options.stopSequences !== undefined
              ? options.stopSequences
              : undefined,
          max_tokens: options.maxTokens || -1,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let usage = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue; // skip empty lines / comments
          if (trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));

            // Extract usage if present (some servers send it on the last chunk)
            if (json.usage) {
              usage = {
                inputTokens: json.usage.prompt_tokens ?? 0,
                outputTokens: json.usage.completion_tokens ?? 0,
              };
            }

            const content = json.choices?.[0]?.delta?.content || "";
            if (content) {
              yield content;
            }
          } catch {
            // skip malformed JSON lines
          }
        }
      }

      if (usage) {
        yield { type: "usage", usage };
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("lm-studio", error.message, 500, error);
    }
  },

  async captionImage(
    imageUrlOrBase64,
    prompt = "Describe this image.",
    model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["lm-studio"],
  ) {
    const baseUrl = getBaseUrl();
    logger.provider(
      "LM Studio",
      `captionImage model=${model} baseUrl=${baseUrl}`,
    );
    try {
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrlOrBase64 } },
          ],
        },
      ];

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          model,
          temperature: 0.7,
          max_tokens: -1,
          stream: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API error: ${response.status} ${errorText}`);
      }

      const data = await response.json();
      const text = data.choices?.[0]?.message?.content || "";
      return { text };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("lm-studio", error.message, 500, error);
    }
  },

  // ── LM Studio Model Management (v1 API) ─────────────────────

  /**
   * List all models available in LM Studio (loaded + downloaded).
   * GET /api/v1/models
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

      return response.json();
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError("lm-studio", error.message, 500, error);
    }
  },

  /**
   * Load a model into LM Studio memory.
   * POST /api/v1/models/load  { model }
   */
  async loadModel(model) {
    const baseUrl = getBaseUrl();
    logger.provider("LM Studio", `loadModel model=${model}`);
    try {
      const response = await fetch(`${baseUrl}/api/v1/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
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

  /**
   * Unload a model from LM Studio memory.
   * POST /api/v1/models/unload  { instance_id }
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

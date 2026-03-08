import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { LM_STUDIO_BASE_URL } from "../../secrets.js";
import { TYPES, getDefaultModels } from "../config.js";

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
    logger.provider("LM Studio", `generateText model=${model} baseUrl=${baseUrl}`);
    try {
      // Remove unsupported properties
      const cleaned = messages.map((m) => {
        const { name: _name, id: _id, ...rest } = m;
        return rest;
      });

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: cleaned,
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
      const cleaned = messages.map((m) => {
        const { name: _name, id: _id, ...rest } = m;
        return rest;
      });

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: cleaned,
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

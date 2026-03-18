import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { VLLM_BASE_URL } from "../../secrets.js";
import { TYPES, getDefaultModels } from "../config.js";

// ── Helpers ──────────────────────────────────────────────────

function getBaseUrl() {
    return VLLM_BASE_URL;
}

/**
 * Convert messages with images to OpenAI-compatible multipart content format.
 */
function prepareMessages(messages) {
    return messages.map((m) => {
        const base = { role: m.role };
        if (m.name) base.name = m.name;
        if (m.images && m.images.length > 0) {
            const content = [];
            for (const dataUrl of m.images) {
                content.push({ type: "image_url", image_url: { url: dataUrl } });
            }
            if (m.content) {
                content.push({ type: "text", text: m.content });
            }
            return { ...base, content };
        }
        return { ...base, content: m.content };
    });
}

// ── Provider ─────────────────────────────────────────────────

const vllmProvider = {
    name: "vllm",

    async generateText(
        messages,
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"],
        options = {},
    ) {
        const baseUrl = getBaseUrl();
        logger.provider("vLLM", `generateText model=${model} baseUrl=${baseUrl}`);
        try {
            const prepared = prepareMessages(messages);

            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    messages: prepared,
                    model,
                    temperature: options.temperature !== undefined ? options.temperature : 0.7,
                    top_p: options.topP !== undefined ? options.topP : undefined,
                    frequency_penalty: options.frequencyPenalty !== undefined ? options.frequencyPenalty : undefined,
                    presence_penalty: options.presencePenalty !== undefined ? options.presencePenalty : undefined,
                    stop: options.stopSequences !== undefined ? options.stopSequences : undefined,
                    max_tokens: options.maxTokens || -1,
                    stream: false,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API error: ${response.status} ${errorText}`);
            }

            const data = await response.json();
            const message = data.choices?.[0]?.message;
            const text = message?.content || "";
            const thinking = message?.reasoning || message?.reasoning_content || null;
            return {
                text,
                thinking,
                usage: {
                    inputTokens: data.usage?.prompt_tokens ?? 0,
                    outputTokens: data.usage?.completion_tokens ?? 0,
                },
            };
        } catch (error) {
            if (error instanceof ProviderError) throw error;
            throw new ProviderError("vllm", error.message, 500, error);
        }
    },

    // ── Streaming Text Generation (SSE) ──────────────────────

    async *generateTextStream(
        messages,
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["vllm"],
        options = {},
    ) {
        const baseUrl = getBaseUrl();
        logger.provider("vLLM", `generateTextStream model=${model} baseUrl=${baseUrl}`);
        try {
            const prepared = prepareMessages(messages);

            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    messages: prepared,
                    model,
                    temperature: options.temperature !== undefined ? options.temperature : 0.7,
                    top_p: options.topP !== undefined ? options.topP : undefined,
                    frequency_penalty: options.frequencyPenalty !== undefined ? options.frequencyPenalty : undefined,
                    presence_penalty: options.presencePenalty !== undefined ? options.presencePenalty : undefined,
                    stop: options.stopSequences !== undefined ? options.stopSequences : undefined,
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
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith(":")) continue;
                    if (trimmed === "data: [DONE]") continue;
                    if (!trimmed.startsWith("data: ")) continue;

                    try {
                        const json = JSON.parse(trimmed.slice(6));

                        if (json.usage) {
                            usage = {
                                inputTokens: json.usage.prompt_tokens ?? 0,
                                outputTokens: json.usage.completion_tokens ?? 0,
                            };
                        }

                        const delta = json.choices?.[0]?.delta;
                        const reasoning = delta?.reasoning || delta?.reasoning_content || "";
                        if (reasoning) {
                            yield { type: "thinking", content: reasoning };
                        }

                        const content = delta?.content || "";
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
            throw new ProviderError("vllm", error.message, 500, error);
        }
    },

    async captionImage(
        images,
        prompt = "Describe this image.",
        model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["vllm"],
        systemPrompt,
    ) {
        const baseUrl = getBaseUrl();
        logger.provider("vLLM", `captionImage model=${model} baseUrl=${baseUrl}`);
        try {
            const content = [
                { type: "text", text: prompt },
                ...images.map((img) => ({ type: "image_url", image_url: { url: img } })),
            ];
            const messages = [];
            if (systemPrompt) {
                messages.push({ role: "system", content: systemPrompt });
            }
            messages.push({ role: "user", content });

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
            const usage = {
                inputTokens: data.usage?.prompt_tokens || 0,
                outputTokens: data.usage?.completion_tokens || 0,
            };
            return { text, usage };
        } catch (error) {
            if (error instanceof ProviderError) throw error;
            throw new ProviderError("vllm", error.message, 500, error);
        }
    },

    // ── Model Listing ────────────────────────────────────────

    /**
     * List all models available from the vLLM server.
     * Uses the OpenAI-standard GET /v1/models endpoint.
     * Returns { models: [...] } normalized format.
     */
    async listModels() {
        const baseUrl = getBaseUrl();
        logger.provider("vLLM", "listModels");
        try {
            const response = await fetch(`${baseUrl}/v1/models`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API error: ${response.status} ${errorText}`);
            }
            const data = await response.json();
            const models = (data.data || []).map((m) => ({
                key: m.id,
                display_name: m.id,
                type: "llm",
                loaded_instances: [{ id: m.id }], // vLLM models are always loaded
            }));
            return { models };
        } catch (error) {
            if (error instanceof ProviderError) throw error;
            throw new ProviderError("vllm", error.message, 500, error);
        }
    },
};

export default vllmProvider;

import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { OLLAMA_BASE_URL } from "../../secrets.js";
import { TYPES, getDefaultModels } from "../config.js";

function getBaseUrl() {
    return OLLAMA_BASE_URL;
}

/**
 * Convert messages with images to OpenAI-compatible multipart content format.
 * Ollama uses the same format as OpenAI Chat Completions.
 */
function prepareOllamaMessages(messages) {
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

/**
 * Extract <think>…</think> blocks from a complete response string.
 * Returns { thinking, text } where thinking is the concatenated think content
 * and text is the remaining content with think tags removed.
 */
function extractThinkTags(raw) {
    const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
    const thinkParts = [];
    let match;
    while ((match = thinkRegex.exec(raw)) !== null) {
        thinkParts.push(match[1].trim());
    }
    const text = raw.replace(thinkRegex, "").trim();
    return {
        thinking: thinkParts.length > 0 ? thinkParts.join("\n\n") : null,
        text,
    };
}

/**
 * Stateful parser for streaming <think> tag detection.
 * Handles tags that arrive split across chunk boundaries.
 *
 * feed(chunk) returns an array of items:
 *   - { type: "thinking", content: string }
 *   - { type: "text", content: string }
 */
class ThinkTagParser {
    constructor() {
        this.insideThink = false;
        this.buffer = "";
    }

    feed(chunk) {
        this.buffer += chunk;
        const results = [];

        while (this.buffer.length > 0) {
            if (this.insideThink) {
                const closeIdx = this.buffer.indexOf("</think>");
                if (closeIdx !== -1) {
                    const thinkContent = this.buffer.slice(0, closeIdx);
                    if (thinkContent) {
                        results.push({ type: "thinking", content: thinkContent });
                    }
                    this.buffer = this.buffer.slice(closeIdx + "</think>".length);
                    this.insideThink = false;
                } else {
                    const partialMatch = this._partialEndTag(this.buffer);
                    if (partialMatch > 0) {
                        const safe = this.buffer.slice(0, this.buffer.length - partialMatch);
                        if (safe) {
                            results.push({ type: "thinking", content: safe });
                        }
                        this.buffer = this.buffer.slice(this.buffer.length - partialMatch);
                    } else {
                        results.push({ type: "thinking", content: this.buffer });
                        this.buffer = "";
                    }
                    break;
                }
            } else {
                const openIdx = this.buffer.indexOf("<think>");
                if (openIdx !== -1) {
                    const textBefore = this.buffer.slice(0, openIdx);
                    if (textBefore) {
                        results.push({ type: "text", content: textBefore });
                    }
                    this.buffer = this.buffer.slice(openIdx + "<think>".length);
                    this.insideThink = true;
                } else {
                    const partialMatch = this._partialStartTag(this.buffer);
                    if (partialMatch > 0) {
                        const safe = this.buffer.slice(0, this.buffer.length - partialMatch);
                        if (safe) {
                            results.push({ type: "text", content: safe });
                        }
                        this.buffer = this.buffer.slice(this.buffer.length - partialMatch);
                    } else {
                        results.push({ type: "text", content: this.buffer });
                        this.buffer = "";
                    }
                    break;
                }
            }
        }
        return results;
    }

    /** Check if the end of str is a partial match for "<think>" */
    _partialStartTag(str) {
        const tag = "<think>";
        for (let len = Math.min(tag.length - 1, str.length); len >= 1; len--) {
            if (str.endsWith(tag.slice(0, len))) {
                return len;
            }
        }
        return 0;
    }

    /** Check if the end of str is a partial match for "</think>" */
    _partialEndTag(str) {
        const tag = "</think>";
        for (let len = Math.min(tag.length - 1, str.length); len >= 1; len--) {
            if (str.endsWith(tag.slice(0, len))) {
                return len;
            }
        }
        return 0;
    }

    /** Flush any remaining buffered content. */
    flush() {
        if (!this.buffer) return [];
        const type = this.insideThink ? "thinking" : "text";
        const result = [{ type, content: this.buffer }];
        this.buffer = "";
        return result;
    }
}

const ollamaProvider = {
    name: "ollama",

    async generateText(
        messages,
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["ollama"],
        options = {},
    ) {
        const baseUrl = getBaseUrl();
        logger.provider("Ollama", `generateText model=${model} baseUrl=${baseUrl}`);
        try {
            const prepared = prepareOllamaMessages(messages);

            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    messages: prepared,
                    model,
                    temperature: options.temperature !== undefined ? options.temperature : 0.7,
                    top_p: options.topP !== undefined ? options.topP : undefined,
                    frequency_penalty:
                        options.frequencyPenalty !== undefined ? options.frequencyPenalty : undefined,
                    presence_penalty:
                        options.presencePenalty !== undefined ? options.presencePenalty : undefined,
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
            const rawText = data.choices?.[0]?.message?.content || "";
            const { thinking, text } = extractThinkTags(rawText);
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
            throw new ProviderError("ollama", error.message, 500, error);
        }
    },

    // ── Streaming Text Generation (SSE) ──────────────────────

    async *generateTextStream(
        messages,
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)["ollama"],
        options = {},
    ) {
        const baseUrl = getBaseUrl();
        logger.provider("Ollama", `generateTextStream model=${model} baseUrl=${baseUrl}`);
        try {
            const prepared = prepareOllamaMessages(messages);

            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    messages: prepared,
                    model,
                    temperature: options.temperature !== undefined ? options.temperature : 0.7,
                    top_p: options.topP !== undefined ? options.topP : undefined,
                    frequency_penalty:
                        options.frequencyPenalty !== undefined ? options.frequencyPenalty : undefined,
                    presence_penalty:
                        options.presencePenalty !== undefined ? options.presencePenalty : undefined,
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
            const thinkParser = new ThinkTagParser();

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop(); // keep incomplete line in buffer

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

                        const content = json.choices?.[0]?.delta?.content || "";
                        if (content) {
                            const parts = thinkParser.feed(content);
                            for (const part of parts) {
                                if (part.type === "thinking") {
                                    yield { type: "thinking", content: part.content };
                                } else {
                                    yield part.content;
                                }
                            }
                        }
                    } catch {
                        // skip malformed JSON lines
                    }
                }
            }

            // Flush any remaining buffered content from the think parser
            const remaining = thinkParser.flush();
            for (const part of remaining) {
                if (part.type === "thinking") {
                    yield { type: "thinking", content: part.content };
                } else {
                    yield part.content;
                }
            }

            if (usage) {
                yield { type: "usage", usage };
            }
        } catch (error) {
            if (error instanceof ProviderError) throw error;
            throw new ProviderError("ollama", error.message, 500, error);
        }
    },

    async captionImage(
        imageUrlOrBase64,
        prompt = "Describe this image.",
        model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)["ollama"],
    ) {
        const baseUrl = getBaseUrl();
        logger.provider("Ollama", `captionImage model=${model} baseUrl=${baseUrl}`);
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
            const usage = {
                inputTokens: data.usage?.prompt_tokens || 0,
                outputTokens: data.usage?.completion_tokens || 0,
            };
            return { text, usage };
        } catch (error) {
            if (error instanceof ProviderError) throw error;
            throw new ProviderError("ollama", error.message, 500, error);
        }
    },

    // ── Ollama Model Listing ─────────────────────

    /**
     * List all models available in Ollama.
     * GET /api/tags
     */
    async listModels() {
        const baseUrl = getBaseUrl();
        logger.provider("Ollama", "listModels");
        try {
            const response = await fetch(`${baseUrl}/api/tags`, {
                method: "GET",
                headers: { "Content-Type": "application/json" },
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API error: ${response.status} ${errorText}`);
            }

            const data = await response.json();
            // Ollama returns { models: [{ name, model, size, ... }] }
            return { models: data.models || [] };
        } catch (error) {
            if (error instanceof ProviderError) throw error;
            throw new ProviderError("ollama", error.message, 500, error);
        }
    },
};

export default ollamaProvider;

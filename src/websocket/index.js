import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import { GATEWAY_SECRET } from "../../secrets.js";
import {
    TYPES,
    getDefaultModels,
    getPricing,
    getModelByName,
} from "../config.js";
import { calculateTextCost, calculateImageCost } from "../utils/CostCalculator.js";
import logger from "../utils/logger.js";
import RequestLogger from "../services/RequestLogger.js";
import ConversationService from "../services/ConversationService.js";

/**
 * Set up WebSocket handlers on the HTTP server.
 * Routes:
 *   /text-to-text/stream     — Streaming text generation
 *   /text-to-speech/stream   — Streaming TTS (ElevenLabs only)
 */
export function setupWebSocket(wss) {
    wss.on("connection", (ws, req) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Auth — accept header or query param
        const secret =
            req.headers["x-api-secret"] || url.searchParams.get("secret");
        if (!secret || secret !== GATEWAY_SECRET) {
            logger.error(`WebSocket auth failed — ${pathname}`);
            ws.send(
                JSON.stringify({
                    type: "error",
                    message: "Unauthorized — missing or invalid secret",
                }),
            );
            ws.close();
            return;
        }

        const project =
            req.headers["x-project"] || url.searchParams.get("project") || "unknown";
        const username =
            req.headers["x-username"] ||
            url.searchParams.get("username") ||
            "unknown";
        logger.info(
            `WebSocket connection on ${pathname} (project: ${project}, user: ${username})`,
        );

        if (pathname === "/text-to-text/stream") {
            handleTextToTextStream(ws, project, username);
        } else if (pathname === "/text-to-speech/stream") {
            handleTextToSpeechStream(ws);
        } else {
            ws.send(
                JSON.stringify({
                    type: "error",
                    message: `Unknown WebSocket path: ${pathname}`,
                }),
            );
            ws.close();
        }
    });
}

/**
 * Handle streaming text generation.
 * Client sends: { provider, model?, messages, options?, conversationId?, userMessage? }
 * Server sends: { type: "chunk", content } | { type: "done", usage?, estimatedCost? } | { type: "error", message }
 *
 * When conversationId is provided, the user message and assistant response
 * are automatically appended to the conversation server-side on completion.
 */
function handleTextToTextStream(ws, project, username) {
    ws.on("message", async (rawData) => {
        const requestStart = performance.now();
        const requestId = crypto.randomUUID();
        let providerName = null;
        let resolvedModel = null;
        let messages = null;
        let options = null;
        let conversationId = null;
        let userMessage = null;

        let data;
        try {
            data = JSON.parse(rawData.toString());
        } catch {
            ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
            return;
        }

        providerName = data.provider;
        messages = data.messages;
        options = data.options || {};
        conversationId = data.conversationId || null;
        userMessage = data.userMessage || null;

        if (!providerName || !messages) {
            ws.send(
                JSON.stringify({
                    type: "error",
                    message: "Missing required fields: provider, messages",
                }),
            );
            return;
        }

        try {
            const provider = getProvider(providerName);
            if (!provider.generateTextStream) {
                ws.send(
                    JSON.stringify({
                        type: "error",
                        message: `Provider "${providerName}" does not support streaming`,
                    }),
                );
                return;
            }

            resolvedModel =
                data.model || getDefaultModels(TYPES.TEXT, TYPES.TEXT)[providerName];

            // Check if this is an image-generation model that needs the Images API
            const modelDef = getModelByName(resolvedModel);
            const isImageModel = modelDef?.imageAPI && provider.generateImage;

            if (isImageModel) {
                // Route through the Images API instead of streaming text
                const lastUserMsg = messages.filter((m) => m.role === "user").pop();
                const prompt = lastUserMsg?.content || "";

                // Collect all images from the conversation (user-uploaded + assistant-generated)
                const allImages = [];
                for (const msg of messages) {
                    if (msg.images && msg.images.length > 0) {
                        allImages.push(...msg.images);
                    }
                }
                const requestStart2 = performance.now();

                try {
                    const result = await provider.generateImage(
                        prompt,
                        allImages,
                        resolvedModel,
                    );
                    const totalSec = (performance.now() - requestStart2) / 1000;

                    // Calculate cost for image API models
                    const imgPricing = getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel]
                        || modelDef?.pricing;
                    const outputImgTokens = providerName === "openai" ? 1056 : 258;
                    const estimatedCost = calculateImageCost(
                        prompt, imgPricing, allImages.length, outputImgTokens,
                    );

                    if (ws.readyState === ws.OPEN) {
                        if (result.text) {
                            ws.send(JSON.stringify({ type: "chunk", content: result.text }));
                        }
                        ws.send(
                            JSON.stringify({
                                type: "image",
                                data: result.imageData,
                                mimeType: result.mimeType || "image/png",
                            }),
                        );
                        ws.send(
                            JSON.stringify({
                                type: "done",
                                usage: result.usage || null,
                                estimatedCost,
                                totalTime: totalSec,
                            }),
                        );
                    }
                } catch (imgError) {
                    logger.error(
                        `Image generation error (${providerName}):`,
                        imgError.message,
                    );
                    if (ws.readyState === ws.OPEN) {
                        ws.send(
                            JSON.stringify({ type: "error", message: imgError.message }),
                        );
                    }
                }
                return;
            }

            const stream = provider.generateTextStream(
                messages,
                resolvedModel,
                options,
            );
            let usage = null;
            let firstTokenTime = null;
            let generationEnd = null;
            let outputCharacters = 0;
            let fullStreamedText = "";
            const streamedImages = [];
            for await (const chunk of stream) {
                // Providers yield a { type: 'usage', usage } object as the final item
                if (chunk && typeof chunk === "object" && chunk.type === "usage") {
                    usage = chunk.usage;
                    continue;
                }
                // Thinking chunks from providers that support extended thinking
                if (chunk && typeof chunk === "object" && chunk.type === "thinking") {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(
                            JSON.stringify({ type: "thinking", content: chunk.content }),
                        );
                    }
                    continue;
                }
                // Image chunks from multimodal models
                if (chunk && typeof chunk === "object" && chunk.type === "image") {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(
                            JSON.stringify({
                                type: "image",
                                data: chunk.data,
                                mimeType: chunk.mimeType,
                            }),
                        );
                    }
                    // Accumulate image data URLs for conversation save
                    if (chunk.data) {
                        streamedImages.push(
                            `data:${chunk.mimeType || "image/png"};base64,${chunk.data}`,
                        );
                    }
                    continue;
                }
                // Code execution chunks
                if (
                    chunk &&
                    typeof chunk === "object" &&
                    chunk.type === "executableCode"
                ) {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(
                            JSON.stringify({
                                type: "executableCode",
                                code: chunk.code,
                                language: chunk.language,
                            }),
                        );
                    }
                    continue;
                }
                if (
                    chunk &&
                    typeof chunk === "object" &&
                    chunk.type === "codeExecutionResult"
                ) {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(
                            JSON.stringify({
                                type: "codeExecutionResult",
                                output: chunk.output,
                                outcome: chunk.outcome,
                            }),
                        );
                    }
                    continue;
                }
                // Web search result chunks (citations from Anthropic)
                if (
                    chunk &&
                    typeof chunk === "object" &&
                    chunk.type === "webSearchResult"
                ) {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(
                            JSON.stringify({
                                type: "webSearchResult",
                                results: chunk.results,
                            }),
                        );
                    }
                    continue;
                }
                // Status messages (e.g. "Loading model…")
                if (chunk && typeof chunk === "object" && chunk.type === "status") {
                    if (ws.readyState === ws.OPEN) {
                        ws.send(JSON.stringify({ type: "status", message: chunk.message }));
                    }
                    continue;
                }
                if (!firstTokenTime) {
                    firstTokenTime = performance.now();
                }
                generationEnd = performance.now();
                const chunkStr = typeof chunk === "string" ? chunk : "";
                outputCharacters += chunkStr.length;
                fullStreamedText += chunkStr;
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({ type: "chunk", content: chunk }));
                }
            }
            const now = performance.now();
            const timeToGenerationSec = firstTokenTime
                ? (firstTokenTime - requestStart) / 1000
                : null;
            const generationSec =
                firstTokenTime && generationEnd
                    ? (generationEnd - firstTokenTime) / 1000
                    : null;
            const totalSec = (now - requestStart) / 1000;

            // Log token usage + cost
            if (usage) {
                // When images were streamed (e.g. Gemini Flash Image), account
                // for image output tokens at the higher imageOutputPerMillion rate.
                const imageCount = streamedImages.length;
                let estimatedCost;
                if (imageCount > 0) {
                    const imgPricing = getPricing(TYPES.TEXT, TYPES.IMAGE)[resolvedModel]
                        || modelDef?.pricing;
                    if (imgPricing?.imageOutputPerMillion) {
                        // Split output tokens: image tokens (258 per image) at image rate,
                        // remainder at text rate.
                        const imageTokens = imageCount * 258;
                        const textOutputTokens = Math.max(0, usage.outputTokens - imageTokens);
                        const inputCost = (usage.inputTokens / 1_000_000) * (imgPricing.inputPerMillion || 0);
                        const textOutCost = (textOutputTokens / 1_000_000) * (imgPricing.outputPerMillion || 0);
                        const imageOutCost = (imageTokens / 1_000_000) * imgPricing.imageOutputPerMillion;
                        estimatedCost = parseFloat((inputCost + textOutCost + imageOutCost).toFixed(8));
                    } else {
                        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
                        estimatedCost = calculateTextCost(usage, pricing);
                    }
                } else {
                    const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
                    estimatedCost = calculateTextCost(usage, pricing);
                }
                const tokensPerSec =
                    generationSec && generationSec > 0
                        ? (usage.outputTokens / generationSec).toFixed(1)
                        : "N/A";
                logger.info(
                    `[${providerName}] ${resolvedModel} — ` +
                    `in: ${usage.inputTokens} tokens, out: ${usage.outputTokens} tokens, ` +
                    `speed: ${tokensPerSec} tok/s, ` +
                    `ttg: ${timeToGenerationSec !== null ? timeToGenerationSec.toFixed(2) + "s" : "N/A"}, ` +
                    `generation: ${generationSec !== null ? generationSec.toFixed(2) + "s" : "N/A"}, ` +
                    `total: ${totalSec.toFixed(2)}s` +
                    (estimatedCost !== null
                        ? `, cost: $${estimatedCost.toFixed(6)}`
                        : ""),
                );

                // Fire-and-forget DB log
                RequestLogger.log({
                    requestId,
                    endpoint: "text-to-text",
                    project,
                    username,
                    provider: providerName,
                    model: resolvedModel,
                    success: true,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    estimatedCost,
                    tokensPerSec: parseFloat(tokensPerSec) || null,
                    temperature: options?.temperature ?? null,
                    maxTokens: options?.maxTokens ?? null,
                    messageCount: messages.length,
                    inputCharacters: messages.reduce(
                        (sum, m) =>
                            sum + (typeof m.content === "string" ? m.content.length : 0),
                        0,
                    ),
                    outputCharacters,
                    timeToGeneration:
                        timeToGenerationSec !== null
                            ? parseFloat(timeToGenerationSec.toFixed(3))
                            : null,
                    generationTime:
                        generationSec !== null
                            ? parseFloat(generationSec.toFixed(3))
                            : null,
                    totalTime: parseFloat(totalSec.toFixed(3)),
                });

                if (ws.readyState === ws.OPEN) {
                    ws.send(
                        JSON.stringify({
                            type: "done",
                            usage,
                            estimatedCost,
                            tokensPerSec: parseFloat(tokensPerSec) || null,
                            timeToGeneration:
                                timeToGenerationSec !== null
                                    ? parseFloat(timeToGenerationSec.toFixed(3))
                                    : null,
                            generationTime:
                                generationSec !== null
                                    ? parseFloat(generationSec.toFixed(3))
                                    : null,
                            totalTime: parseFloat(totalSec.toFixed(3)),
                        }),
                    );
                }

                // Auto-append messages to conversation if conversationId is provided
                if (conversationId) {
                    const messagesToAppend = [];
                    if (userMessage) {
                        messagesToAppend.push({
                            role: "user",
                            ...userMessage,
                            timestamp: userMessage.timestamp || new Date().toISOString(),
                        });
                    }

                    messagesToAppend.push({
                        role: "assistant",
                        content: fullStreamedText,
                        ...(streamedImages.length > 0 && { images: streamedImages }),
                        model: resolvedModel,
                        provider: providerName,
                        timestamp: new Date().toISOString(),
                        usage,
                        totalTime: parseFloat(totalSec.toFixed(3)),
                        tokensPerSec: parseFloat(tokensPerSec) || null,
                        estimatedCost,
                    });

                    ConversationService.appendMessages(
                        conversationId,
                        project,
                        username,
                        messagesToAppend,
                    ).catch((err) =>
                        logger.error(
                            `Failed to append messages to conversation ${conversationId}: ${err.message}`,
                        ),
                    );
                }
            } else if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: "done" }));
            }
        } catch (error) {
            logger.error(`Stream error (${providerName}):`, error.message);
            const totalSec = (performance.now() - requestStart) / 1000;
            RequestLogger.log({
                requestId,
                endpoint: "text-to-text",
                project,
                username,
                provider: providerName,
                model: resolvedModel,
                success: false,
                errorMessage: error.message,
                messageCount: messages ? messages.length : 0,
                totalTime: totalSec,
            });
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: "error", message: error.message }));
            }
        }
    });
}

/**
 * Handle streaming text-to-speech.
 * Client sends text chunks as strings. First message must be JSON config:
 *   { provider, voiceId?, options? }
 * Subsequent messages are text strings to be converted to speech.
 * Server sends binary audio frames back.
 * Client sends "__END__" to signal end of text stream.
 */
function handleTextToSpeechStream(ws) {
    let configured = false;
    let providerName = null;
    let voiceId = null;
    let options = {};
    const textQueue = [];
    let resolveText = null;
    let textEnded = false;

    async function* textIterator() {
        while (true) {
            if (textQueue.length > 0) {
                const text = textQueue.shift();
                if (text === null) return; // End signal
                yield text;
            } else {
                if (textEnded) return;
                await new Promise((r) => (resolveText = r));
            }
        }
    }

    function pushText(text) {
        textQueue.push(text);
        if (resolveText) {
            const resolve = resolveText;
            resolveText = null;
            resolve();
        }
    }

    ws.on("message", async (rawData) => {
        const message = rawData.toString();

        if (!configured) {
            // First message is config
            try {
                const config = JSON.parse(message);
                providerName = config.provider || "elevenlabs";
                voiceId = config.voiceId || config.voice;
                options = config.options || {};
                configured = true;

                const provider = getProvider(providerName);
                if (!provider.generateSpeechStream) {
                    ws.send(
                        JSON.stringify({
                            type: "error",
                            message: `Provider "${providerName}" does not support streaming TTS`,
                        }),
                    );
                    ws.close();
                    return;
                }

                // Start streaming in background
                (async () => {
                    try {
                        const audioStream = provider.generateSpeechStream(
                            textIterator(),
                            voiceId,
                            options,
                        );
                        for await (const audioChunk of audioStream) {
                            if (ws.readyState === ws.OPEN) {
                                ws.send(audioChunk); // Binary audio frame
                            }
                        }
                        if (ws.readyState === ws.OPEN) {
                            ws.send(JSON.stringify({ type: "done" }));
                        }
                    } catch (error) {
                        logger.error(`TTS stream error (${providerName}):`, error.message);
                        if (ws.readyState === ws.OPEN) {
                            ws.send(
                                JSON.stringify({ type: "error", message: error.message }),
                            );
                        }
                    }
                })();

                ws.send(JSON.stringify({ type: "ready" }));
            } catch {
                ws.send(
                    JSON.stringify({
                        type: "error",
                        message:
                            "First message must be JSON config: { provider, voiceId?, options? }",
                    }),
                );
            }
            return;
        }

        // Subsequent messages are text chunks
        if (message === "__END__") {
            textEnded = true;
            pushText(null); // Signal end
        } else {
            pushText(message);
        }
    });

    ws.on("close", () => {
        textEnded = true;
        pushText(null);
    });
}

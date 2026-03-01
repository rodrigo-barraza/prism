import { getProvider } from '../providers/index.js';
import { GATEWAY_SECRET } from '../secrets.js';
import { TEXT2TEXT_PRICING } from '../pricing.js';
import { TEXT2TEXT_DEFAULT_MODELS } from '../config.js';
import logger from '../utils/logger.js';

/**
 * Set up WebSocket handlers on the HTTP server.
 * Routes:
 *   /text-to-text/stream     — Streaming text generation
 *   /text-to-speech/stream   — Streaming TTS (ElevenLabs only)
 */
export function setupWebSocket(wss) {
    wss.on('connection', (ws, req) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const pathname = url.pathname;

        // Auth — accept header or query param
        const secret = req.headers["x-api-secret"] || url.searchParams.get("secret");
        if (!secret || secret !== GATEWAY_SECRET) {
            logger.error(`WebSocket auth failed — ${pathname}`);
            ws.send(JSON.stringify({ type: "error", message: "Unauthorized — missing or invalid secret" }));
            ws.close();
            return;
        }

        const project = req.headers["x-project"] || url.searchParams.get("project") || "unknown";
        logger.info(`WebSocket connection on ${pathname} (project: ${project})`);

        if (pathname === '/text-to-text/stream') {
            handleTextToTextStream(ws);
        } else if (pathname === '/text-to-speech/stream') {
            handleTextToSpeechStream(ws);
        } else {
            ws.send(JSON.stringify({ type: 'error', message: `Unknown WebSocket path: ${pathname}` }));
            ws.close();
        }
    });
}

/**
 * Handle streaming text generation.
 * Client sends: { provider, model?, messages, options? }
 * Server sends: { type: "chunk", content } | { type: "done", usage?, estimatedCost? } | { type: "error", message }
 */
function handleTextToTextStream(ws) {
    ws.on('message', async (rawData) => {
        const requestStart = performance.now();
        let data;
        try {
            data = JSON.parse(rawData.toString());
        } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            return;
        }

        const { provider: providerName, model, messages, options } = data;

        if (!providerName || !messages) {
            ws.send(JSON.stringify({ type: 'error', message: 'Missing required fields: provider, messages' }));
            return;
        }

        try {
            const provider = getProvider(providerName);
            if (!provider.generateTextStream) {
                ws.send(JSON.stringify({ type: 'error', message: `Provider "${providerName}" does not support streaming` }));
                return;
            }

            const resolvedModel = model || TEXT2TEXT_DEFAULT_MODELS[providerName];
            const stream = provider.generateTextStream(messages, resolvedModel, options || {});
            let usage = null;
            let firstTokenTime = null;
            let generationEnd = null;
            for await (const chunk of stream) {
                // Providers yield a { type: 'usage', usage } object as the final item
                if (chunk && typeof chunk === 'object' && chunk.type === 'usage') {
                    usage = chunk.usage;
                    continue;
                }
                if (!firstTokenTime) {
                    firstTokenTime = performance.now();
                }
                generationEnd = performance.now();
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({ type: 'chunk', content: chunk }));
                }
            }
            const now = performance.now();
            const timeToGenerationSec = firstTokenTime ? (firstTokenTime - requestStart) / 1000 : null;
            const generationSec = firstTokenTime && generationEnd ? (generationEnd - firstTokenTime) / 1000 : null;
            const totalSec = (now - requestStart) / 1000;

            // Log token usage + cost (mirrors REST /text-to-text behaviour)
            if (usage) {
                const pricing = TEXT2TEXT_PRICING[resolvedModel];
                let estimatedCost = null;
                if (pricing) {
                    estimatedCost =
                        (usage.inputTokens / 1_000_000) * pricing.inputPerMillion +
                        (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
                }
                const tokensPerSec = generationSec && generationSec > 0 ? (usage.outputTokens / generationSec).toFixed(1) : "N/A";
                logger.info(
                    `[${providerName}] ${resolvedModel} — ` +
                    `in: ${usage.inputTokens} tokens, out: ${usage.outputTokens} tokens, ` +
                    `speed: ${tokensPerSec} tok/s, ` +
                    `ttg: ${timeToGenerationSec !== null ? timeToGenerationSec.toFixed(2) + "s" : "N/A"}, ` +
                    `generation: ${generationSec !== null ? generationSec.toFixed(2) + "s" : "N/A"}, ` +
                    `total: ${totalSec.toFixed(2)}s` +
                    (estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : ""),
                );
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify({ type: 'done', usage, estimatedCost, tokensPerSec: parseFloat(tokensPerSec) || null, timeToGeneration: timeToGenerationSec, generationTime: generationSec, totalTime: totalSec }));
                }
            } else if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'done' }));
            }
        } catch (error) {
            logger.error(`Stream error (${providerName}):`, error.message);
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: 'error', message: error.message }));
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

    ws.on('message', async (rawData) => {
        const message = rawData.toString();

        if (!configured) {
            // First message is config
            try {
                const config = JSON.parse(message);
                providerName = config.provider || 'elevenlabs';
                voiceId = config.voiceId || config.voice;
                options = config.options || {};
                configured = true;

                const provider = getProvider(providerName);
                if (!provider.generateSpeechStream) {
                    ws.send(
                        JSON.stringify({ type: 'error', message: `Provider "${providerName}" does not support streaming TTS` }),
                    );
                    ws.close();
                    return;
                }

                // Start streaming in background
                (async () => {
                    try {
                        const audioStream = provider.generateSpeechStream(textIterator(), voiceId, options);
                        for await (const audioChunk of audioStream) {
                            if (ws.readyState === ws.OPEN) {
                                ws.send(audioChunk); // Binary audio frame
                            }
                        }
                        if (ws.readyState === ws.OPEN) {
                            ws.send(JSON.stringify({ type: 'done' }));
                        }
                    } catch (error) {
                        logger.error(`TTS stream error (${providerName}):`, error.message);
                        if (ws.readyState === ws.OPEN) {
                            ws.send(JSON.stringify({ type: 'error', message: error.message }));
                        }
                    }
                })();

                ws.send(JSON.stringify({ type: 'ready' }));
            } catch {
                ws.send(
                    JSON.stringify({
                        type: 'error',
                        message: 'First message must be JSON config: { provider, voiceId?, options? }',
                    }),
                );
            }
            return;
        }

        // Subsequent messages are text chunks
        if (message === '__END__') {
            textEnded = true;
            pushText(null); // Signal end
        } else {
            pushText(message);
        }
    });

    ws.on('close', () => {
        textEnded = true;
        pushText(null);
    });
}

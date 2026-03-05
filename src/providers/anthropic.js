import Anthropic from '@anthropic-ai/sdk';
import { ProviderError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { ANTHROPIC_API_KEY } from '../secrets.js';
import { TYPES, getDefaultModels } from '../config.js';


// Default budget tokens mapped from effort level (for non-adaptive models)
const EFFORT_BUDGET_MAP = {
    low: 1024,
    medium: 4096,
    high: 10000,
};

let client = null;

function getClient() {
    if (!client) {
        if (!ANTHROPIC_API_KEY) {
            throw new ProviderError('anthropic', 'ANTHROPIC_API_KEY is not set', 401);
        }
        client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    }
    return client;
}

/**
 * Anthropic requires alternating user/assistant roles and handles system messages separately.
 * This helper extracts the system message and merges consecutive same-role messages.
 */
function prepareMessages(messages) {
    let systemMessage;

    // Extract system message
    const conversation = messages.map((m) => ({ ...m }));
    if (conversation.length > 0 && conversation[0].role === 'system') {
        systemMessage = conversation.shift().content;
    }

    // Remove unsupported properties and convert image content
    const cleaned = conversation
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => {
            const { name: _name, id: _id, images, ...rest } = m;
            // Convert messages with images to Anthropic content block format
            if (images && images.length > 0 && rest.role === 'user') {
                const contentBlocks = [];
                for (const img of images) {
                    // img is a base64 data URL: data:image/png;base64,....
                    const match = img.match(/^data:(image\/[\w+]+);base64,(.+)$/);
                    if (match) {
                        const data = match[2];
                        // Detect actual MIME type from base64 magic bytes
                        // (the data URL header can be wrong)
                        let mediaType = match[1];
                        if (data.startsWith('/9j/')) mediaType = 'image/jpeg';
                        else if (data.startsWith('iVBOR')) mediaType = 'image/png';
                        else if (data.startsWith('R0lG')) mediaType = 'image/gif';
                        else if (data.startsWith('UklG')) mediaType = 'image/webp';

                        contentBlocks.push({
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: mediaType,
                                data,
                            },
                        });
                    }
                }
                if (rest.content) {
                    contentBlocks.push({ type: 'text', text: rest.content });
                }
                return { role: rest.role, content: contentBlocks };
            }
            return rest;
        });

    // Merge consecutive same-role messages
    const merged = cleaned.reduce((acc, cur) => {
        if (acc.length && acc[acc.length - 1].role === cur.role) {
            const prev = acc[acc.length - 1];
            // Handle merging when content might be string or array
            if (typeof prev.content === 'string' && typeof cur.content === 'string') {
                prev.content += `\n\n${cur.content}`;
            } else {
                // Convert both to arrays and concat
                const prevBlocks = typeof prev.content === 'string'
                    ? [{ type: 'text', text: prev.content }]
                    : prev.content;
                const curBlocks = typeof cur.content === 'string'
                    ? [{ type: 'text', text: cur.content }]
                    : cur.content;
                prev.content = [...prevBlocks, ...curBlocks];
            }
        } else {
            acc.push({ ...cur });
        }
        return acc;
    }, []);

    // Ensure conversation starts with a user message
    if (merged.length > 0 && merged[0].role === 'assistant') {
        merged.shift();
    }

    return { systemMessage, messages: merged };
}

const anthropicProvider = {
    name: 'anthropic',

    async generateText(
        messages,
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).anthropic,
        options = {},
    ) {
        logger.provider('Anthropic', `generateText model=${model}`);
        try {
            const prepared = prepareMessages(messages);
            const payload = {
                system: prepared.systemMessage,
                model,
                messages: prepared.messages,
                max_tokens: options.maxTokens || 1000,
                temperature: options.temperature !== undefined ? options.temperature : undefined,
                top_p: options.temperature === undefined && options.topP !== undefined ? options.topP : undefined,
                top_k: options.topK !== undefined ? options.topK : undefined,
                stop_sequences: options.stopSequences !== undefined ? options.stopSequences : undefined,
            };


            if (options.thinkingBudget || options.reasoningEffort) {
                const budget = options.thinkingBudget
                    ? parseInt(options.thinkingBudget)
                    : (EFFORT_BUDGET_MAP[options.reasoningEffort] || EFFORT_BUDGET_MAP.high);
                payload.thinking = { type: 'enabled', budget_tokens: budget };
                if (payload.max_tokens <= budget) {
                    payload.max_tokens = budget + 1024;
                }
                // Anthropic requires temperature=1 and top_p/top_k unset when thinking is enabled
                payload.temperature = 1;
                delete payload.top_p;
                delete payload.top_k;
            }

            const response = await getClient().messages.create(payload);

            // When thinking is enabled, response.content contains multiple blocks:
            // [{ type: 'thinking', thinking: '...' }, { type: 'text', text: '...' }]
            const textBlock = response.content?.find((b) => b.type === 'text');
            const thinkingBlock = response.content?.find((b) => b.type === 'thinking');
            const text = textBlock?.text || '';
            const result = {
                text,
                usage: {
                    inputTokens: response.usage?.input_tokens ?? 0,
                    outputTokens: response.usage?.output_tokens ?? 0,
                },
            };
            if (thinkingBlock?.thinking) {
                result.thinking = thinkingBlock.thinking;
            }
            return result;
        } catch (error) {
            throw new ProviderError(
                'anthropic',
                error.message,
                error.status || 500,
                error,
            );
        }
    },

    async *generateTextStream(
        messages,
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).anthropic,
        options = {},
    ) {
        logger.provider('Anthropic', `generateTextStream model=${model}`);
        try {
            const prepared = prepareMessages(messages);
            const ObjectPayload = {
                system: prepared.systemMessage,
                model,
                messages: prepared.messages,
                max_tokens: options.maxTokens || 1000,
                temperature: options.temperature !== undefined ? options.temperature : undefined,
                top_p: options.temperature === undefined && options.topP !== undefined ? options.topP : undefined,
                top_k: options.topK !== undefined ? options.topK : undefined,
                stop_sequences: options.stopSequences !== undefined ? options.stopSequences : undefined,
            };


            if (options.thinkingBudget || options.reasoningEffort) {
                const budget = options.thinkingBudget
                    ? parseInt(options.thinkingBudget)
                    : (EFFORT_BUDGET_MAP[options.reasoningEffort] || EFFORT_BUDGET_MAP.high);
                ObjectPayload.thinking = { type: 'enabled', budget_tokens: budget };
                if (ObjectPayload.max_tokens <= budget) {
                    ObjectPayload.max_tokens = budget + 1024;
                }
                // Anthropic requires temperature=1 and top_p/top_k unset when thinking is enabled
                ObjectPayload.temperature = 1;
                delete ObjectPayload.top_p;
                delete ObjectPayload.top_k;
            }

            const stream = getClient().messages.stream(ObjectPayload);

            let usage = null;
            for await (const chunk of stream) {
                if (
                    chunk.type === 'content_block_delta' &&
                    chunk.delta.type === 'thinking_delta'
                ) {
                    yield { type: 'thinking', content: chunk.delta.thinking };
                }
                if (
                    chunk.type === 'content_block_delta' &&
                    chunk.delta.type === 'text_delta'
                ) {
                    yield chunk.delta.text;
                }
                if (chunk.type === 'message_delta' && chunk.usage) {
                    usage = {
                        inputTokens: 0,
                        outputTokens: chunk.usage.output_tokens ?? 0,
                    };
                }
            }
            // Get full usage from the finalized message
            const finalMessage = await stream.finalMessage();
            if (finalMessage?.usage) {
                usage = {
                    inputTokens: finalMessage.usage.input_tokens ?? 0,
                    outputTokens: finalMessage.usage.output_tokens ?? 0,
                };
            }
            if (usage) {
                yield { type: 'usage', usage };
            }
        } catch (error) {
            throw new ProviderError(
                'anthropic',
                error.message,
                error.status || 500,
                error,
            );
        }
    },
};

export default anthropicProvider;

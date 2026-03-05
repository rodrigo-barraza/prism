import OpenAI from 'openai';
import { ProviderError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { OPENAI_API_KEY } from '../secrets.js';
import { TYPES, DEFAULT_VOICES, getDefaultModels, getModelByName } from '../config.js';

let client = null;

function getClient() {
    if (!client) {
        if (!OPENAI_API_KEY) {
            throw new ProviderError('openai', 'OPENAI_API_KEY is not set', 401);
        }
        client = new OpenAI({ apiKey: OPENAI_API_KEY });
    }
    return client;
}
/**
 * Convert messages with images to OpenAI multimodal content format.
 */
function prepareOpenAIMessages(messages) {
    return messages.map((m) => {
        if (m.images && m.images.length > 0 && m.role === 'user') {
            const content = [];
            for (const img of m.images) {
                content.push({ type: 'image_url', image_url: { url: img } });
            }
            if (m.content) {
                content.push({ type: 'text', text: m.content });
            }
            return { role: m.role, content };
        }
        return { role: m.role, content: m.content };
    });
}

const openaiProvider = {
    name: 'openai',

    async generateText(
        messages,
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).openai,
        options = {},
    ) {
        logger.provider('OpenAI', `generateText model=${model}`);
        try {
            const modelDef = getModelByName(model);
            const isReasoning = modelDef?.thinking || model.includes('o1') || model.includes('o3');
            const prepared = prepareOpenAIMessages(messages);
            const payload = {
                model,
                messages: prepared,
            };
            if (isReasoning) {
                if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
                if (options.reasoningEffort) payload.reasoning_effort = options.reasoningEffort;
            } else {
                if (options.temperature !== undefined) payload.temperature = options.temperature;
                if (options.topP !== undefined) payload.top_p = options.topP;
                if (options.frequencyPenalty !== undefined) payload.frequency_penalty = options.frequencyPenalty;
                if (options.presencePenalty !== undefined) payload.presence_penalty = options.presencePenalty;
                if (options.stopSequences !== undefined) payload.stop = options.stopSequences;
                if (options.maxTokens) payload.max_tokens = options.maxTokens;
            }
            if (options.webSearch) {
                payload.tools = [{ type: 'web_search_preview' }];
            }

            const response = await getClient().chat.completions.create(payload);
            return {
                text: response.choices[0].message.content,
                usage: {
                    inputTokens: response.usage?.prompt_tokens ?? 0,
                    outputTokens: response.usage?.completion_tokens ?? 0,
                },
            };
        } catch (error) {
            throw new ProviderError(
                'openai',
                error.message,
                error.status || 500,
                error,
            );
        }
    },

    async *generateTextStream(
        messages,
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).openai,
        options = {},
    ) {
        logger.provider('OpenAI', `generateTextStream model=${model}`);
        try {
            const modelDef = getModelByName(model);
            const isReasoning = modelDef?.thinking || model.includes('o1') || model.includes('o3');
            const prepared = prepareOpenAIMessages(messages);
            const payload = {
                model,
                messages: prepared,
                stream: true,
                stream_options: { include_usage: true },
            };
            if (isReasoning) {
                if (options.maxTokens) payload.max_completion_tokens = options.maxTokens;
                if (options.reasoningEffort) payload.reasoning_effort = options.reasoningEffort;
            } else {
                if (options.temperature !== undefined) payload.temperature = options.temperature;
                if (options.topP !== undefined) payload.top_p = options.topP;
                if (options.frequencyPenalty !== undefined) payload.frequency_penalty = options.frequencyPenalty;
                if (options.presencePenalty !== undefined) payload.presence_penalty = options.presencePenalty;
                if (options.stopSequences !== undefined) payload.stop = options.stopSequences;
                if (options.maxTokens) payload.max_tokens = options.maxTokens;
            }
            if (options.webSearch) {
                payload.tools = [{ type: 'web_search_preview' }];
            }

            const stream = await getClient().chat.completions.create(payload);
            let usage = null;
            for await (const chunk of stream) {
                if (chunk.usage) {
                    usage = {
                        inputTokens: chunk.usage.prompt_tokens ?? 0,
                        outputTokens: chunk.usage.completion_tokens ?? 0,
                    };
                }
                const content = chunk.choices[0]?.delta?.content || '';
                if (content) {
                    yield content;
                }
            }
            if (usage) {
                yield { type: 'usage', usage };
            }
        } catch (error) {
            throw new ProviderError(
                'openai',
                error.message,
                error.status || 500,
                error,
            );
        }
    },

    async generateSpeech(text, voice = DEFAULT_VOICES.openai, options = {}) {
        logger.provider('OpenAI', `generateSpeech voice=${voice}`);
        try {
            const response = await getClient().audio.speech.create({
                model:
                    options.model || getDefaultModels(TYPES.TEXT, TYPES.AUDIO).openai,
                voice,
                input: text,
                instructions: options.instructions || undefined,
                response_format: options.format || 'mp3',
            });
            return { stream: response.body, contentType: 'audio/mpeg' };
        } catch (error) {
            throw new ProviderError(
                'openai',
                error.message,
                error.status || 500,
                error,
            );
        }
    },

    async captionImage(
        imageUrl,
        prompt = "What's in this image?",
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).openai,
    ) {
        logger.provider('OpenAI', `captionImage model=${model}`);
        try {
            const messages = [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: imageUrl } },
                    ],
                },
            ];
            const response = await getClient().chat.completions.create({
                model,
                messages,
                max_tokens: 1000,
            });
            return { text: response.choices[0].message.content };
        } catch (error) {
            throw new ProviderError(
                'openai',
                error.message,
                error.status || 500,
                error,
            );
        }
    },

    async generateEmbedding(
        text,
        model = getDefaultModels(TYPES.TEXT, TYPES.EMBEDDING).openai,
    ) {
        logger.provider('OpenAI', `generateEmbedding model=${model}`);
        try {
            const response = await getClient().embeddings.create({
                model,
                input: text,
            });
            return { embedding: response.data[0].embedding };
        } catch (error) {
            throw new ProviderError(
                'openai',
                error.message,
                error.status || 500,
                error,
            );
        }
    },
};

export default openaiProvider;

import OpenAI from 'openai';
import { ProviderError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { OPENAI_API_KEY } from '../secrets.js';
import {
    TEXT2TEXT_DEFAULT_MODELS,
    TEXT2SPEECH_DEFAULT_MODELS,
    TEXT2SPEECH_DEFAULT_VOICES,
    EMBEDDING_DEFAULT_MODELS,
} from '../config.js';

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

const openaiProvider = {
    name: 'openai',

    async generateText(messages, model = TEXT2TEXT_DEFAULT_MODELS.openai, options = {}) {
        logger.provider('OpenAI', `generateText model=${model}`);
        try {
            const response = await getClient().chat.completions.create({
                model,
                messages,
                max_tokens: options.maxTokens || undefined,
                temperature: options.temperature || undefined,
            });
            return { text: response.choices[0].message.content };
        } catch (error) {
            throw new ProviderError('openai', error.message, error.status || 500, error);
        }
    },

    async *generateTextStream(messages, model = TEXT2TEXT_DEFAULT_MODELS.openai, options = {}) {
        logger.provider('OpenAI', `generateTextStream model=${model}`);
        try {
            const stream = await getClient().chat.completions.create({
                model,
                messages,
                max_tokens: options.maxTokens || undefined,
                temperature: options.temperature || undefined,
                stream: true,
            });
            for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content || '';
                if (content) {
                    yield content;
                }
            }
        } catch (error) {
            throw new ProviderError('openai', error.message, error.status || 500, error);
        }
    },

    async generateSpeech(text, voice = TEXT2SPEECH_DEFAULT_VOICES.openai, options = {}) {
        logger.provider('OpenAI', `generateSpeech voice=${voice}`);
        try {
            const response = await getClient().audio.speech.create({
                model: options.model || TEXT2SPEECH_DEFAULT_MODELS.openai,
                voice,
                input: text,
                instructions: options.instructions || undefined,
                response_format: options.format || 'mp3',
            });
            return { stream: response.body, contentType: 'audio/mpeg' };
        } catch (error) {
            throw new ProviderError('openai', error.message, error.status || 500, error);
        }
    },

    async captionImage(imageUrl, prompt = "What's in this image?", model = TEXT2TEXT_DEFAULT_MODELS.openai) {
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
            throw new ProviderError('openai', error.message, error.status || 500, error);
        }
    },

    async generateEmbedding(text, model = EMBEDDING_DEFAULT_MODELS.openai) {
        logger.provider('OpenAI', `generateEmbedding model=${model}`);
        try {
            const response = await getClient().embeddings.create({
                model,
                input: text,
            });
            return { embedding: response.data[0].embedding };
        } catch (error) {
            throw new ProviderError('openai', error.message, error.status || 500, error);
        }
    },
};

export default openaiProvider;

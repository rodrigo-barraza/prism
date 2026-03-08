import { ProviderError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { OPENAI_COMPATIBLE_BASE_URL } from '../../secrets.js';
import { TYPES, getDefaultModels } from '../config.js';

function getBaseUrl() {
    return OPENAI_COMPATIBLE_BASE_URL;
}

const openaiCompatibleProvider = {
    name: 'openai-compatible',

    async generateText(
        messages,
        model = getDefaultModels(TYPES.TEXT, TYPES.TEXT)['openai-compatible'],
        options = {},
    ) {
        const baseUrl = getBaseUrl();
        logger.provider(
            'OpenAI-Compatible',
            `generateText model=${model} baseUrl=${baseUrl}`,
        );
        try {
            // Remove unsupported properties
            const cleaned = messages.map((m) => {
                const { name: _name, id: _id, ...rest } = m;
                return rest;
            });

            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messages: cleaned,
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
            const text = data.choices?.[0]?.message?.content || '';
            return {
                text,
                usage: {
                    inputTokens: data.usage?.prompt_tokens ?? 0,
                    outputTokens: data.usage?.completion_tokens ?? 0,
                },
            };
        } catch (error) {
            if (error instanceof ProviderError) throw error;
            throw new ProviderError('openai-compatible', error.message, 500, error);
        }
    },

    async captionImage(
        imageUrlOrBase64,
        prompt = 'Describe this image.',
        model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT)['openai-compatible'],
    ) {
        const baseUrl = getBaseUrl();
        logger.provider(
            'OpenAI-Compatible',
            `captionImage model=${model} baseUrl=${baseUrl}`,
        );
        try {
            const messages = [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: imageUrlOrBase64 } },
                    ],
                },
            ];

            const response = await fetch(`${baseUrl}/v1/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
            const text = data.choices?.[0]?.message?.content || '';
            return { text };
        } catch (error) {
            if (error instanceof ProviderError) throw error;
            throw new ProviderError('openai-compatible', error.message, 500, error);
        }
    },
};

export default openaiCompatibleProvider;

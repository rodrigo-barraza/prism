import { GoogleGenAI } from '@google/genai';
import { Readable } from 'stream';
import { ProviderError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { GOOGLE_API_KEY } from '../secrets.js';
import { TYPES, MODELS, DEFAULT_VOICES, getDefaultModels } from '../config.js';

let client = null;

function getClient() {
  if (!client) {
    if (!GOOGLE_API_KEY) {
      throw new ProviderError('google', 'GOOGLE_API_KEY is not set', 401);
    }
    client = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
  }
  return client;
}

/**
 * Add a WAV header to raw PCM audio data.
 */
function addWavHeader(buffer, sampleRate = 24000, numChannels = 1) {
  const headerLength = 44;
  const dataLength = buffer.length;
  const fileSize = dataLength + headerLength - 8;
  const header = Buffer.alloc(headerLength);

  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * numChannels * 2, 28);
  header.writeUInt16LE(numChannels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLength, 40);

  return Buffer.concat([header, buffer]);
}

/**
 * Convert OpenAI-style messages to Google GenAI content format.
 */
function convertMessages(messages) {
  return messages.map((item) => ({
    role: item.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: item.content }],
  }));
}

const googleProvider = {
  name: 'google',

  async generateText(
    messages,
    model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).google,
    options = {},
  ) {
    logger.provider('Google', `generateText model=${model}`);
    try {
      const contents = convertMessages(messages);
      const config = {};
      if (options.temperature !== undefined) {
        config.temperature = options.temperature;
      }
      if (options.maxTokens !== undefined) {
        config.maxOutputTokens = options.maxTokens;
      }

      const response = await getClient().models.generateContent({
        model,
        contents,
        config,
      });
      return {
        text: response.text,
        usage: {
          inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
        },
      };
    } catch (error) {
      throw new ProviderError('google', error.message, 500, error);
    }
  },

  async *generateTextStream(
    messages,
    model = getDefaultModels(TYPES.TEXT, TYPES.TEXT).google,
    options = {},
  ) {
    logger.provider('Google', `generateTextStream model=${model}`);
    try {
      const contents = convertMessages(messages);
      const config = {};
      if (options.temperature !== undefined) {
        config.temperature = options.temperature;
      }
      if (options.maxTokens !== undefined) {
        config.maxOutputTokens = options.maxTokens;
      }

      const responseStream = await getClient().models.generateContentStream({
        model,
        contents,
        config,
      });
      let usage = null;
      for await (const chunk of responseStream) {
        if (chunk.text) {
          yield chunk.text;
        }
        if (chunk.usageMetadata) {
          usage = {
            inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
            outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
          };
        }
      }
      if (usage) {
        yield { type: 'usage', usage };
      }
    } catch (error) {
      throw new ProviderError('google', error.message, 500, error);
    }
  },

  async captionImage(
    imageUrlOrBase64,
    prompt = 'Describe this image.',
    model = getDefaultModels(TYPES.IMAGE, TYPES.TEXT).google,
  ) {
    logger.provider('Google', `captionImage model=${model}`);
    try {
      let imageData = imageUrlOrBase64;
      let mimeType = 'image/jpeg';

      if (imageUrlOrBase64.startsWith('http')) {
        const response = await fetch(imageUrlOrBase64);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch image from URL: ${imageUrlOrBase64}`,
          );
        }
        const arrayBuffer = await response.arrayBuffer();
        imageData = Buffer.from(arrayBuffer).toString('base64');
        mimeType = response.headers.get('content-type') || 'image/jpeg';
      } else if (imageUrlOrBase64.includes(';base64,')) {
        const parts = imageUrlOrBase64.split(';base64,');
        mimeType = parts[0].split(':')[1];
        imageData = parts[1];
      }

      const contents = [
        {
          role: 'user',
          parts: [
            { inlineData: { data: imageData, mimeType } },
            { text: prompt },
          ],
        },
      ];

      const response = await getClient().models.generateContent({
        model,
        contents,
      });
      return { text: response.text };
    } catch (error) {
      throw new ProviderError('google', error.message, 500, error);
    }
  },

  async generateImage(
    prompt,
    images = [],
    model = MODELS.GEMINI_3_PRO_IMAGE.name,
  ) {
    logger.provider('Google', `generateImage model=${model}`);
    try {
      const config = {
        responseModalities: ['IMAGE'],
        imageConfig: { imageSize: '1K' },
      };

      const parts = [{ text: prompt }];
      if (images.length) {
        for (const image of images) {
          parts.push({
            inlineData: {
              data: image.imageData,
              mimeType: image.mimeType || 'image/jpeg',
            },
          });
        }
      }

      const contents = [{ role: 'user', parts }];
      const response = await getClient().models.generateContentStream({
        model,
        config,
        contents,
      });

      let combinedText = '';
      for await (const chunk of response) {
        if (!chunk.candidates?.[0]?.content?.parts) continue;
        if (chunk.candidates?.[0]?.finishReason === 'PROHIBITED_CONTENT') {
          throw new Error('Content was flagged as prohibited by Google AI');
        }
        const part = chunk.candidates[0].content.parts[0];
        if (part.inlineData) {
          return {
            imageData: part.inlineData.data,
            mimeType: part.inlineData.mimeType || 'image/png',
            text: combinedText,
          };
        } else if (chunk.text) {
          combinedText += chunk.text;
        }
      }
      throw new Error('No image data received from Google AI');
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('google', error.message, 500, error);
    }
  },

  async generateSpeech(text, voice = DEFAULT_VOICES.google, options = {}) {
    logger.provider('Google', `generateSpeech voice=${voice}`);
    try {
      const config = {
        temperature: 1,
        responseModalities: ['audio'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voice,
            },
          },
        },
      };

      const response = await getClient().models.generateContent({
        model:
          options.model || getDefaultModels(TYPES.TEXT, TYPES.AUDIO).google,
        contents: [
          {
            role: 'user',
            parts: [
              { text: options.prompt ? `${options.prompt}\n\n${text}` : text },
            ],
          },
        ],
        config,
      });

      const candidates = response.candidates;
      if (candidates?.[0]?.content?.parts?.[0]?.inlineData) {
        const inlineData = candidates[0].content.parts[0].inlineData;
        const audioBuffer = Buffer.from(inlineData.data || '', 'base64');

        if (
          inlineData.mimeType === 'audio/mpeg' ||
          inlineData.mimeType === 'audio/mp3'
        ) {
          return {
            stream: Readable.from(audioBuffer),
            contentType: 'audio/mpeg',
          };
        } else {
          const wavBuffer = addWavHeader(audioBuffer);
          return { stream: Readable.from(wavBuffer), contentType: 'audio/wav' };
        }
      } else {
        throw new Error('No audio content received from Google GenAI');
      }
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('google', error.message, 500, error);
    }
  },
};

export default googleProvider;

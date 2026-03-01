import Anthropic from '@anthropic-ai/sdk';
import { ProviderError } from '../utils/errors.js';
import logger from '../utils/logger.js';
import { ANTHROPIC_API_KEY } from '../secrets.js';
import { TYPES, getDefaultModels } from '../config.js';

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

  // Remove unsupported properties
  const cleaned = conversation
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const { name: _name, id: _id, ...rest } = m;
      return rest;
    });

  // Merge consecutive same-role messages
  const merged = cleaned.reduce((acc, cur) => {
    if (acc.length && acc[acc.length - 1].role === cur.role) {
      acc[acc.length - 1].content += `\n\n${cur.content}`;
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
      const response = await getClient().messages.create({
        system: prepared.systemMessage,
        model,
        messages: prepared.messages,
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || undefined,
      });

      const text = response.content?.[0]?.text || '';
      return {
        text,
        usage: {
          inputTokens: response.usage?.input_tokens ?? 0,
          outputTokens: response.usage?.output_tokens ?? 0,
        },
      };
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
      const stream = getClient().messages.stream({
        system: prepared.systemMessage,
        model,
        messages: prepared.messages,
        max_tokens: options.maxTokens || 1000,
        temperature: options.temperature || undefined,
      });

      let usage = null;
      for await (const chunk of stream) {
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

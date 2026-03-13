import express from "express";
import crypto from "crypto";
import { getProvider } from "../providers/index.js";
import { ProviderError } from "../utils/errors.js";
import ConversationService from "../services/ConversationService.js";
import FileService from "../services/FileService.js";
import logger from "../utils/logger.js";
import RequestLogger from "../services/RequestLogger.js";

const router = express.Router();

// ============================================================
// Shared core logic — used by both REST and WebSocket
// ============================================================

/**
 * Handle a voice (TTS) request.
 *
 * @param {Object}   params              Request parameters
 * @param {string}   params.provider     Provider name (required)
 * @param {string}   params.text         Text to synthesize (required)
 * @param {string}   [params.voice]      Voice identifier
 * @param {string}   [params.instructions] TTS instructions
 * @param {string}   [params.model]      Model name
 * @param {Object}   [params.options]    Extra options
 * @param {string}   [params.conversationId]  Auto-append to conversation
 * @param {Object}   [params.userMessage]     User message metadata
 * @param {string}   params.project      Project identifier
 * @param {string}   params.username     Username identifier
 * @param {Function} emitBinary          Callback for binary audio chunks: emitBinary(chunk)
 * @param {Function} emitJSON            Callback for JSON events: emitJSON({ type, ...data })
 * @returns {Promise<string>}            Content type of the audio
 */
export async function handleVoice(params, emitBinary, emitJSON) {
  const requestId = crypto.randomUUID();
  const requestStart = performance.now();
  const {
    provider: providerName,
    text,
    voice,
    instructions,
    model,
    options: extraOptions,
    conversationId,
    userMessage,
    project = "unknown",
    username = "unknown",
  } = params;

  try {
    if (!providerName) {
      throw new ProviderError(
        "server",
        "Missing required field: provider",
        400,
      );
    }
    if (!text) {
      throw new ProviderError("server", "Missing required field: text", 400);
    }

    const provider = getProvider(providerName);
    if (!provider.generateSpeech) {
      throw new ProviderError(
        providerName,
        `Provider "${providerName}" does not support text-to-speech`,
        400,
      );
    }

    const options = { instructions, model, ...extraOptions };
    const result = await provider.generateSpeech(text, voice, options);
    const totalSec = (performance.now() - requestStart) / 1000;
    const contentType = result.contentType || "audio/mpeg";

    // Collect audio chunks for MinIO upload when conversationId is provided
    const audioChunks = conversationId ? [] : null;

    if (result.stream.pipe) {
      // Node.js readable stream
      if (audioChunks) {
        result.stream.on("data", (chunk) => audioChunks.push(chunk));
      }
      for await (const chunk of result.stream) {
        emitBinary(chunk);
      }
    } else {
      // Web ReadableStream (from fetch)
      const reader = result.stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (audioChunks) audioChunks.push(Buffer.from(value));
        emitBinary(value);
      }
    }

    logger.info(
      `[voice] ${providerName} model=${model || "default"} — ` +
      `total: ${totalSec.toFixed(2)}s`,
    );

    RequestLogger.log({
      requestId,
      endpoint: "voice",
      project,
      username,
      provider: providerName,
      model: model || null,
      success: true,
      inputCharacters: text.length,
      totalTime: parseFloat(totalSec.toFixed(3)),
    });

    emitJSON({ type: "done" });

    // Auto-append to conversation
    if (conversationId && audioChunks) {
      let audioRef = null;
      try {
        const audioBuffer = Buffer.concat(audioChunks);
        const dataUrl = `data:${contentType};base64,${audioBuffer.toString("base64")}`;
        const { ref } = await FileService.uploadFile(
          dataUrl, "generations", project, username,
        );
        audioRef = ref;
      } catch (err) {
        logger.error(`Failed to upload TTS audio: ${err.message}`);
      }

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
        content: "",
        ...(audioRef && { audio: audioRef }),
        model: model || undefined,
        provider: providerName,
        voice: voice || undefined,
        timestamp: new Date().toISOString(),
        totalTime: parseFloat(totalSec.toFixed(3)),
      });

      ConversationService.appendMessages(
        conversationId, project, username, messagesToAppend,
      ).catch((err) =>
        logger.error(
          `Failed to append messages to conversation ${conversationId}: ${err.message}`,
        ),
      );
    }

    return contentType;
  } catch (error) {
    const totalSec = (performance.now() - requestStart) / 1000;
    RequestLogger.log({
      requestId,
      endpoint: "voice",
      project,
      username,
      provider: providerName,
      model: model || null,
      success: false,
      errorMessage: error.message,
      totalTime: totalSec,
    });
    emitJSON({ type: "error", message: error.message });
    throw error;
  }
}

// ============================================================
// REST endpoint — chunked binary audio
// ============================================================

/**
 * POST /voice
 * Body: { provider, text, voice?, instructions?, model?, options?, conversationId?, userMessage? }
 * Response: binary audio stream with content-type header
 */
router.post("/", async (req, res, next) => {
  try {
    let contentType = "audio/mpeg";

    const resultContentType = await handleVoice(
      {
        ...req.body,
        project: req.project,
        username: req.username,
      },
      (chunk) => {
        // Set headers on first chunk
        if (!res.headersSent) {
          res.setHeader("Content-Type", contentType);
          res.setHeader("Transfer-Encoding", "chunked");
        }
        res.write(chunk);
      },
      (_event) => { /* REST doesn't send JSON events to client */ },
    );

    if (resultContentType) {
      contentType = resultContentType;
    }

    res.end();
  } catch (error) {
    if (!res.headersSent) {
      next(error);
    }
  }
});

export default router;

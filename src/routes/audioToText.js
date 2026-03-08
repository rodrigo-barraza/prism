import express from "express";
import { getProvider } from "../providers/index.js";
import { ProviderError } from "../utils/errors.js";
import logger from "../utils/logger.js";
import { TYPES, getDefaultModels, getPricing } from "../config.js";

const router = express.Router();

/**
 * POST /audio-to-text
 * Body: { provider, audio, mimeType?, model?, language?, prompt? }
 *   - audio: base64-encoded audio data (or data URL)
 *   - mimeType: e.g. "audio/wav", "audio/mp3", "audio/webm" (default: "audio/wav")
 * Response: { text, usage?, estimatedCost? }
 */
router.post("/", async (req, res, next) => {
  try {
    const {
      provider: providerName,
      audio,
      mimeType: rawMimeType,
      model,
      language,
      prompt,
    } = req.body;

    if (!providerName) {
      throw new ProviderError(
        "server",
        "Missing required field: provider",
        400,
      );
    }
    if (!audio) {
      throw new ProviderError("server", "Missing required field: audio", 400);
    }

    const provider = getProvider(providerName);
    if (!provider.transcribeAudio) {
      throw new ProviderError(
        providerName,
        `Provider "${providerName}" does not support audio transcription`,
        400,
      );
    }

    // Parse audio data — support both raw base64 and data URLs
    let audioBase64 = audio;
    let mimeType = rawMimeType || "audio/wav";
    if (audio.startsWith("data:")) {
      const match = audio.match(/^data:([^;]+);base64,(.+)$/);
      if (match) {
        mimeType = match[1];
        audioBase64 = match[2];
      }
    }

    const audioBuffer = Buffer.from(audioBase64, "base64");
    const resolvedModel =
      model || getDefaultModels(TYPES.AUDIO, TYPES.TEXT)[providerName];

    logger.info(
      `[audio-to-text] ${providerName} model=${resolvedModel} size=${audioBuffer.length}b`,
    );

    const requestStart = performance.now();
    const result = await provider.transcribeAudio(
      audioBuffer,
      mimeType,
      resolvedModel,
      { language, prompt },
    );
    const totalSec = (performance.now() - requestStart) / 1000;

    // Estimate cost
    let estimatedCost = null;
    const pricing = getPricing(TYPES.AUDIO, TYPES.TEXT)[resolvedModel];
    if (pricing && result.usage) {
      if (pricing.perMinute && result.usage.durationSeconds) {
        estimatedCost =
          (result.usage.durationSeconds / 60) * pricing.perMinute;
      } else if (pricing.audioInputPerMillion && result.usage.inputTokens) {
        estimatedCost =
          (result.usage.inputTokens / 1_000_000) *
            pricing.audioInputPerMillion +
          ((result.usage.outputTokens || 0) / 1_000_000) *
            (pricing.outputPerMillion || 0);
      }
    }

    logger.info(
      `[audio-to-text] ${providerName} ${resolvedModel} — ` +
        `total: ${totalSec.toFixed(2)}s` +
        (estimatedCost !== null ? `, cost: $${estimatedCost.toFixed(6)}` : ""),
    );

    res.json({
      text: result.text,
      usage: result.usage || null,
      estimatedCost,
      totalTime: totalSec,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

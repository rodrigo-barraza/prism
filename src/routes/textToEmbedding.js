import express from "express";
import { getProvider } from "../providers/index.js";
import { ProviderError } from "../utils/errors.js";

const router = express.Router();

/**
 * POST /text-to-embedding
 * Body: { provider?, text, model? }
 * Response: { embedding, provider }
 */
router.post("/", async (req, res, next) => {
  try {
    const { provider: providerName = "openai", text, model } = req.body;

    if (!text) {
      throw new ProviderError("server", "Missing required field: text", 400);
    }

    const provider = getProvider(providerName);
    if (!provider.generateEmbedding) {
      throw new ProviderError(
        providerName,
        `Provider "${providerName}" does not support embeddings`,
        400,
      );
    }

    const result = await provider.generateEmbedding(text, model);
    res.json({
      embedding: result.embedding,
      provider: providerName,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

// ── GGUF Architecture Parameters ─────────────────────────────
// Lookup table for model architecture parameters required for
// VRAM estimation. Values verified from HuggingFace config.json.
//
// The KV cache formula is:
//   KV_bytes = 2 × effective_layers × kv_heads × head_dim × bytes_per_el × ctx_len
//
// For hybrid architectures (Mamba/SSM, linear attention), only a
// fraction of layers have KV caches (controlled by attnRatio).

const ARCH_DB = {
  // Llama family (Meta)
  llama: [
    { minB: 0, maxB: 2, layers: 16, kvHeads: 8, headDim: 64 },
    { minB: 2, maxB: 5, layers: 16, kvHeads: 8, headDim: 64 },
    { minB: 5, maxB: 10, layers: 32, kvHeads: 8, headDim: 128 },
    { minB: 10, maxB: 18, layers: 40, kvHeads: 8, headDim: 128 },
    { minB: 18, maxB: 28, layers: 48, kvHeads: 8, headDim: 128 },
    { minB: 28, maxB: 50, layers: 48, kvHeads: 8, headDim: 128 },
    { minB: 50, maxB: 80, layers: 80, kvHeads: 8, headDim: 128 },
    { minB: 80, maxB: 500, layers: 126, kvHeads: 8, headDim: 128 },
  ],
  mllama: [
    { minB: 0, maxB: 15, layers: 40, kvHeads: 8, headDim: 128 },
    { minB: 15, maxB: 100, layers: 100, kvHeads: 8, headDim: 128 },
  ],
  // Qwen2 family (Alibaba)
  qwen2: [
    { minB: 0, maxB: 2, layers: 24, kvHeads: 2, headDim: 64 },
    { minB: 2, maxB: 5, layers: 36, kvHeads: 4, headDim: 128 },
    { minB: 5, maxB: 10, layers: 28, kvHeads: 4, headDim: 128 },
    { minB: 10, maxB: 20, layers: 48, kvHeads: 4, headDim: 128 },
    { minB: 20, maxB: 40, layers: 64, kvHeads: 8, headDim: 128 },
    { minB: 40, maxB: 80, layers: 80, kvHeads: 8, headDim: 128 },
  ],
  qwen2vl: [
    { minB: 0, maxB: 5, layers: 28, kvHeads: 4, headDim: 128 },
    { minB: 5, maxB: 10, layers: 28, kvHeads: 4, headDim: 128 },
    { minB: 10, maxB: 80, layers: 80, kvHeads: 8, headDim: 128 },
  ],
  // Qwen3 family
  qwen3: [
    { minB: 0, maxB: 1, layers: 28, kvHeads: 2, headDim: 64 },
    { minB: 1, maxB: 3, layers: 28, kvHeads: 4, headDim: 64 },
    { minB: 3, maxB: 6, layers: 36, kvHeads: 8, headDim: 128 },
    { minB: 6, maxB: 12, layers: 36, kvHeads: 8, headDim: 128 },
    { minB: 12, maxB: 20, layers: 40, kvHeads: 8, headDim: 128 },
    { minB: 20, maxB: 40, layers: 64, kvHeads: 8, headDim: 128 },
    { minB: 40, maxB: 80, layers: 94, kvHeads: 8, headDim: 128 },
    { minB: 80, maxB: 300, layers: 94, kvHeads: 8, headDim: 128 },
  ],
  qwen3moe: [
    { minB: 0, maxB: 40, layers: 48, kvHeads: 4, headDim: 128 },
  ],
  // Qwen3.5 (hybrid: linear_attention + full_attention)
  qwen35: [
    { minB: 0, maxB: 12, layers: 32, kvHeads: 4, headDim: 256, attnRatio: 0.25 },
    { minB: 12, maxB: 25, layers: 40, kvHeads: 4, headDim: 256, attnRatio: 0.25 },
    { minB: 25, maxB: 40, layers: 64, kvHeads: 4, headDim: 256, attnRatio: 0.25 },
  ],
  qwen35moe: [
    { minB: 0, maxB: 50, layers: 48, kvHeads: 4, headDim: 128, attnRatio: 0.25 },
  ],
  qwen3vl: [
    { minB: 0, maxB: 5, layers: 32, kvHeads: 4, headDim: 128 },
    { minB: 5, maxB: 12, layers: 32, kvHeads: 4, headDim: 128 },
  ],
  qwen3vlmoe: [
    { minB: 0, maxB: 50, layers: 48, kvHeads: 4, headDim: 128 },
  ],
  // Gemma family (Google) — verified from HF config
  gemma3: [
    { minB: 0, maxB: 3, layers: 26, kvHeads: 4, headDim: 256 },
    { minB: 3, maxB: 6, layers: 34, kvHeads: 4, headDim: 256 },
    { minB: 6, maxB: 16, layers: 48, kvHeads: 4, headDim: 256 },
    { minB: 16, maxB: 50, layers: 62, kvHeads: 16, headDim: 128 },
  ],
  gemma4: [
    { minB: 0, maxB: 16, layers: 34, kvHeads: 4, headDim: 256 },
    { minB: 16, maxB: 50, layers: 48, kvHeads: 4, headDim: 256 },
  ],
  // Granite (IBM)
  granite: [
    { minB: 0, maxB: 5, layers: 32, kvHeads: 8, headDim: 128 },
    { minB: 5, maxB: 12, layers: 40, kvHeads: 8, headDim: 128 },
    { minB: 12, maxB: 40, layers: 52, kvHeads: 8, headDim: 128 },
  ],
  // GraniteHybrid: Mamba-2 + attention (9:1 ratio) — verified from HF config
  granitehybrid: [
    { minB: 0, maxB: 12, layers: 40, kvHeads: 4, headDim: 128, attnRatio: 0.1 },
    { minB: 12, maxB: 40, layers: 40, kvHeads: 8, headDim: 128, attnRatio: 0.1 },
  ],
  // Mistral family
  mistral: [
    { minB: 0, maxB: 10, layers: 32, kvHeads: 8, headDim: 128 },
    { minB: 10, maxB: 30, layers: 56, kvHeads: 8, headDim: 128 },
  ],
  mistral3: [
    { minB: 0, maxB: 30, layers: 56, kvHeads: 8, headDim: 128 },
  ],
  // Nemotron (NVIDIA) — Mamba-2 hybrid — verified from HF config
  nemotron_h: [
    { minB: 0, maxB: 6, layers: 32, kvHeads: 8, headDim: 128, attnRatio: 0.08 },
    { minB: 6, maxB: 12, layers: 52, kvHeads: 8, headDim: 128, attnRatio: 0.08 },
  ],
  nemotron_h_moe: [
    { minB: 0, maxB: 40, layers: 54, kvHeads: 8, headDim: 128, attnRatio: 0.08 },
  ],
  // LFM2 (Liquid AI) — Hybrid architecture
  lfm2: [
    { minB: 0, maxB: 2, layers: 24, kvHeads: 4, headDim: 64, attnRatio: 0.25 },
    { minB: 2, maxB: 5, layers: 28, kvHeads: 4, headDim: 80, attnRatio: 0.25 },
  ],
};

/**
 * Resolve architecture parameters for a GGUF model.
 *
 * @param {string|null} architecture — GGUF architecture name (e.g. "qwen3", "granitehybrid")
 * @param {string|null} paramsString — e.g. "9B", "26B-A4B"
 * @param {number} sizeBytes — file size in bytes
 * @param {number} [bitsPerWeight=4] — quantization bits per weight
 * @returns {{ layers: number, kvHeads: number, headDim: number, attnRatio: number, isKnown: boolean }}
 */
export function resolveArchParams(architecture, paramsString, sizeBytes, bitsPerWeight = 4) {
  let billions = 0;
  if (paramsString) {
    const match = paramsString.match(/([\d.]+)\s*[Bb]/);
    if (match) billions = parseFloat(match[1]);
  }
  if (!billions && sizeBytes > 0 && bitsPerWeight > 0) {
    billions = (sizeBytes * 8) / (bitsPerWeight * 1e9);
  }
  if (billions <= 0) billions = 7;

  const archKey = architecture?.toLowerCase() || "";
  const variants = ARCH_DB[archKey];
  if (variants) {
    for (const v of variants) {
      if (billions >= v.minB && billions < v.maxB) {
        return {
          layers: v.layers,
          kvHeads: v.kvHeads,
          headDim: v.headDim,
          attnRatio: v.attnRatio ?? 1.0,
          isKnown: true,
        };
      }
    }
    const last = variants[variants.length - 1];
    return {
      layers: last.layers,
      kvHeads: last.kvHeads,
      headDim: last.headDim,
      attnRatio: last.attnRatio ?? 1.0,
      isKnown: true,
    };
  }

  // Fallback: generic estimate from param count
  let layers, kvHeads, headDim;
  if (billions < 2) {
    layers = 24; kvHeads = 4; headDim = 64;
  } else if (billions < 5) {
    layers = 32; kvHeads = 4; headDim = 128;
  } else if (billions < 10) {
    layers = 32; kvHeads = 8; headDim = 128;
  } else if (billions < 20) {
    layers = 40; kvHeads = 8; headDim = 128;
  } else if (billions < 40) {
    layers = 64; kvHeads = 8; headDim = 128;
  } else if (billions < 80) {
    layers = 80; kvHeads = 8; headDim = 128;
  } else {
    layers = 96; kvHeads = 8; headDim = 128;
  }
  return { layers, kvHeads, headDim, attnRatio: 1.0, isKnown: false };
}

const GiB = 1024 ** 3;

/**
 * Estimate VRAM usage for a GGUF model.
 *
 * @param {object} opts
 * @param {number} opts.sizeBytes — model file size in bytes
 * @param {object} opts.archParams — resolved architecture params { layers, kvHeads, headDim, attnRatio }
 * @param {number} opts.gpuLayers — number of layers offloaded to GPU
 * @param {number} opts.contextLength — context length in tokens
 * @param {boolean} [opts.offloadKvCache=true] — whether KV cache is on GPU
 * @param {boolean} [opts.flashAttention=true] — flash attention enabled (Q8_0 KV vs FP32)
 * @returns {{ gpuGiB: number, totalGiB: number }}
 */
export function estimateMemory({
  sizeBytes,
  archParams,
  gpuLayers,
  contextLength,
  offloadKvCache = true,
  flashAttention = true,
}) {
  if (!sizeBytes || !archParams) return { gpuGiB: 0, totalGiB: 0 };

  const { layers, kvHeads, headDim, attnRatio } = archParams;
  const fileSizeGiB = sizeBytes / GiB;
  const ratio = Math.min(gpuLayers / layers, 1);

  const weightsOnGPU = fileSizeGiB * ratio;
  const weightsOnCPU = fileSizeGiB * (1 - ratio);

  // KV cache: 2 (K+V) × effective_layers × kv_heads × head_dim × bytes_per_el × ctx_len
  // Flash attention → Q8_0 (1 byte), no flash → FP32 (4 bytes)
  const effectiveKvLayers = Math.round(layers * attnRatio);
  const bytesPerElement = flashAttention ? 1 : 4;
  const kvCacheGiB =
    (2 * effectiveKvLayers * kvHeads * headDim * bytesPerElement * contextLength) / GiB;

  // CUDA context + compute buffer overhead
  const overhead = gpuLayers > 0 ? 0.5 : 0;

  const gpuGiB = weightsOnGPU + (offloadKvCache ? kvCacheGiB : 0) + overhead;
  const totalGiB = gpuGiB + weightsOnCPU + (!offloadKvCache ? kvCacheGiB : 0);

  return {
    gpuGiB: Math.max(0, gpuGiB),
    totalGiB: Math.max(0, totalGiB),
  };
}

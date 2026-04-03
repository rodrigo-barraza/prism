#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// VRAM Benchmark — Local Model Profiler
// ═══════════════════════════════════════════════════════════════
//
// Measures REAL GPU VRAM consumption for every locally-served
// model, across varying context lengths AND load settings.
// Compares against our estimated VRAM calculations from
// gguf-arch.js.
//
// Supports:
//   ✓ LM Studio (primary — all load settings tested)
//   ✓ Ollama  (adapter ready)
//   ✓ vLLM    (planned)
//   ✓ llama.cpp server (planned)
//
// Usage:
//   node scripts/vram-bench.js [options]
//
// Options:
//   --provider=lm-studio        Provider to test (default: lm-studio)
//   --model=<key>               Test a single model by key
//   --max-size=<GB>             Max model file size in GB (default: 22)
//   --contexts=2k,4k,8k        Comma-separated context lengths
//   --skip-large                Skip models > 16GB file size
//   --skip-settings             Only test default settings (skip matrix)
//   --skip-existing             Skip runs already saved in MongoDB
//   --rewrite                   Overwrite existing results in MongoDB
//   --no-db                     Skip MongoDB persistence
//   --json-only                 Only output JSON, no console tables
//   --out=<path>                Output JSON path (default: /tmp/vram-bench-<ts>.json)
//   --settle=<ms>               GPU settle time after load (default: 3000)
//   --sample=<ms>               GPU sample window duration (default: 5000)
//
// LM Studio Load Settings (tested per model):
//   flash_attention       true/false — Q8_0 vs FP32 KV cache
//   offload_kv_cache      true/false — KV cache on GPU vs CPU
//   eval_batch_size       128/512    — batch size for prompt eval
//   parallel              1/4        — concurrent request slots
//
// ═══════════════════════════════════════════════════════════════

import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { MongoClient } from "mongodb";
import { resolveArchParams, estimateMemory } from "../src/utils/gguf-arch.js";
import { MONGO_URI, MONGO_DB_NAME } from "../secrets.js";

// ── CLI Argument Parsing ─────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split("=").slice(1).join("=") : fallback;
}
const hasFlag = (name) => args.includes(`--${name}`);

const PROVIDER = getArg("provider", "lm-studio");
const SINGLE_MODEL = getArg("model", null);
const MAX_SIZE_GB = parseFloat(getArg("max-size", "22"));
const CONTEXT_LIST = getArg("contexts", "2k,4k,8k,16k")
  .split(",")
  .map((s) => {
    const n = parseFloat(s.replace(/k$/i, ""));
    return s.toLowerCase().endsWith("k") ? n * 1024 : n;
  });
const SKIP_LARGE = hasFlag("skip-large");
const SKIP_SETTINGS = hasFlag("skip-settings");
const SKIP_EXISTING = hasFlag("skip-existing");
const REWRITE = hasFlag("rewrite");
const NO_DB = hasFlag("no-db");
const JSON_ONLY = hasFlag("json-only");
const OUT_PATH = getArg("out", `/tmp/vram-bench-${Date.now()}.json`);
const SETTLE_MS = parseInt(getArg("settle", "3000"));
const SAMPLE_MS = parseInt(getArg("sample", "5000"));

const BENCH_COLLECTION = "vram_benchmarks";

// Prompt used for generation — short enough to keep focus on VRAM, not gen time
const BENCH_PROMPT =
  "Explain what a neural network is in exactly two sentences.";
const BENCH_MAX_TOKENS = 128;

// ── Settings Matrix ──────────────────────────────────────────
// These are the actual LM Studio load-time settings discovered via the API.
// Each model is loaded with each combo to measure the VRAM impact.
//
// Verified accepted params (POST /api/v1/models/load):
//   context_length, flash_attention, offload_kv_cache_to_gpu,
//   eval_batch_size, parallel, echo_load_config

function buildSettingsMatrix() {
  if (SKIP_SETTINGS) {
    return [
      {
        label: "default",
        flash_attention: true,
        offload_kv_cache_to_gpu: true,
        eval_batch_size: 512,
        parallel: 4,
      },
    ];
  }

  return [
    // ① Default — optimal for most use cases
    {
      label: "default",
      flash_attention: true,
      offload_kv_cache_to_gpu: true,
      eval_batch_size: 512,
      parallel: 4,
    },

    // ② Flash attention OFF → FP32 KV cache (4× more VRAM per token)
    {
      label: "no-flash-attn",
      flash_attention: false,
      offload_kv_cache_to_gpu: true,
      eval_batch_size: 512,
      parallel: 4,
    },

    // ③ KV cache on CPU → saves GPU VRAM, hurts latency
    {
      label: "kv-on-cpu",
      flash_attention: true,
      offload_kv_cache_to_gpu: false,
      eval_batch_size: 512,
      parallel: 4,
    },

    // ④ Single slot — less concurrent VRAM allocation
    {
      label: "single-slot",
      flash_attention: true,
      offload_kv_cache_to_gpu: true,
      eval_batch_size: 512,
      parallel: 1,
    },

    // ⑤ Small batch — less prompt eval VRAM
    {
      label: "small-batch",
      flash_attention: true,
      offload_kv_cache_to_gpu: true,
      eval_batch_size: 128,
      parallel: 4,
    },

    // ⑥ Minimal VRAM — KV on CPU + single slot + small batch
    {
      label: "min-vram",
      flash_attention: true,
      offload_kv_cache_to_gpu: false,
      eval_batch_size: 128,
      parallel: 1,
    },

    // ⑦ Maximum quality — no flash (FP32 KV) + max batch
    {
      label: "max-quality",
      flash_attention: false,
      offload_kv_cache_to_gpu: true,
      eval_batch_size: 512,
      parallel: 1,
    },
  ];
}

// ── Provider Adapters ────────────────────────────────────────

const PROVIDERS = {
  "lm-studio": {
    name: "LM Studio",
    baseUrl: "http://localhost:1234",

    async listModels() {
      const res = await fetch(`${this.baseUrl}/api/v1/models`);
      if (!res.ok) throw new Error(`LM Studio not responding: ${res.status}`);
      const data = await res.json();
      return (data.models || data.data || [])
        .filter((m) => m.type === "llm")
        .map((m) => ({
          key: m.key || m.id,
          displayName: m.display_name || m.key || m.id,
          architecture: m.architecture || null,
          quantization: m.quantization?.name || null,
          bitsPerWeight: m.quantization?.bits_per_weight || 4,
          sizeBytes: m.size_bytes || 0,
          paramsString: m.params_string || null,
          maxContextLength: m.max_context_length || 0,
          vision: m.capabilities?.vision || false,
          tools: m.capabilities?.trained_for_tool_use || false,
          reasoning: !!m.capabilities?.reasoning,
          rawCapabilities: m.capabilities || {},
          variants: m.variants || [],
          selectedVariant: m.selected_variant || null,
        }));
    },

    async loadModel(key, contextLength, settings = {}) {
      await this.unloadAll();
      await sleep(2000);

      const payload = {
        model: key,
        context_length: contextLength,
        echo_load_config: true,
      };

      // Apply all available load settings
      if (settings.flash_attention !== undefined)
        payload.flash_attention = settings.flash_attention;
      if (settings.offload_kv_cache_to_gpu !== undefined)
        payload.offload_kv_cache_to_gpu = settings.offload_kv_cache_to_gpu;
      if (settings.eval_batch_size !== undefined)
        payload.eval_batch_size = settings.eval_batch_size;
      if (settings.parallel !== undefined)
        payload.parallel = settings.parallel;

      const res = await fetch(`${this.baseUrl}/api/v1/models/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Load failed: ${res.status} — ${text.slice(0, 300)}`,
        );
      }

      await sleep(SETTLE_MS);

      let result;
      try {
        result = await res.json();
      } catch {
        result = {};
      }
      return result;
    },

    async unloadAll() {
      try {
        const res = await fetch(`${this.baseUrl}/api/v1/models`);
        if (!res.ok) return;
        const data = await res.json();
        for (const m of data.models || data.data || []) {
          for (const inst of m.loaded_instances || []) {
            await fetch(`${this.baseUrl}/api/v1/models/unload`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ instance_id: inst.id }),
            });
          }
        }
      } catch {
        // Best-effort
      }
      await sleep(2000);
    },

    async generate(key, prompt, maxTokens) {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: key,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.7,
          stream: false,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Generate failed: ${res.status} — ${text.slice(0, 200)}`,
        );
      }
      const data = await res.json();
      return {
        text: data.choices?.[0]?.message?.content || "",
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0,
      };
    },
  },

  // ── Ollama Adapter ────────────────────────────────────────
  ollama: {
    name: "Ollama",
    baseUrl: "http://localhost:11434",
    async listModels() {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) throw new Error(`Ollama not responding: ${res.status}`);
      const data = await res.json();
      return (data.models || []).map((m) => ({
        key: m.name,
        displayName: m.name,
        architecture: null,
        quantization: null,
        bitsPerWeight: 4,
        sizeBytes: m.size || 0,
        paramsString: null,
        maxContextLength: 0,
        vision: false,
        tools: false,
        reasoning: false,
        rawCapabilities: {},
        variants: [],
        selectedVariant: null,
      }));
    },
    async loadModel(_key) {
      await this.unloadAll();
      return {};
    },
    async unloadAll() {
      try {
        await fetch(`${this.baseUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "_", keep_alive: 0 }),
        });
      } catch {
        /* ignore */
      }
      await sleep(2000);
    },
    async generate(key, prompt, maxTokens) {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: key,
          messages: [{ role: "user", content: prompt }],
          options: { num_predict: maxTokens },
          stream: false,
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          `Generate failed: ${res.status} — ${text.slice(0, 200)}`,
        );
      }
      const data = await res.json();
      return {
        text: data.message?.content || "",
        inputTokens: data.prompt_eval_count || 0,
        outputTokens: data.eval_count || 0,
        totalTokens:
          (data.prompt_eval_count || 0) + (data.eval_count || 0),
      };
    },
  },
};

// ── GPU Monitoring ───────────────────────────────────────────

function queryGPU() {
  try {
    const raw = execSync(
      "nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits",
      { encoding: "utf-8", timeout: 5000 },
    ).trim();
    const parts = raw.split(",").map((s) => s.trim());
    return {
      name: parts[0],
      totalMiB: parseInt(parts[1]),
      usedMiB: parseInt(parts[2]),
      freeMiB: parseInt(parts[3]),
      utilPct: parseInt(parts[4]),
      tempC: parseInt(parts[5]),
      powerW: parseFloat(parts[6]),
      timestamp: Date.now(),
    };
  } catch {
    return null;
  }
}

/**
 * Sample GPU VRAM multiple times and return the peak.
 * Models may still be allocating KV cache buffers post-load,
 * so we sample over a window to capture actual peak usage.
 */
async function sampleGPU(durationMs = SAMPLE_MS, intervalMs = 250) {
  const samples = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const gpu = queryGPU();
    if (gpu) samples.push(gpu);
    await sleep(intervalMs);
  }
  if (samples.length === 0) return queryGPU();
  return samples.reduce((max, s) =>
    s.usedMiB > max.usedMiB ? s : max,
  );
}

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function mibToGiB(mib) {
  return mib / 1024;
}

function fmtGiB(gib) {
  return `${gib.toFixed(2)} GiB`;
}

function fmtMiB(mib) {
  return `${mib} MiB`;
}

// ── Logging ──────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
};

function log(msg = "") {
  if (!JSON_ONLY) process.stdout.write(msg + "\n");
}

function logHeader(title) {
  const pad = 62;
  log(
    `\n${C.cyan}╔${"═".repeat(pad)}╗${C.reset}`,
  );
  log(
    `${C.cyan}║${C.bold}${C.white}  ${title.padEnd(pad - 2)}${C.reset}${C.cyan}║${C.reset}`,
  );
  log(
    `${C.cyan}╚${"═".repeat(pad)}╝${C.reset}`,
  );
}

function logSection(title) {
  log(`\n${C.magenta}${C.bold}  ▸ ${title}${C.reset}`);
}

function logKV(key, value, indent = 4) {
  log(`${" ".repeat(indent)}${C.dim}${key}:${C.reset} ${value}`);
}

// ── MongoDB Persistence ──────────────────────────────────────

let _db = null;

async function connectDB() {
  if (NO_DB || !MONGO_URI || !MONGO_DB_NAME) return null;
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    _db = client.db(MONGO_DB_NAME);

    // Ensure indexes on the benchmark collection
    await _db.collection(BENCH_COLLECTION).createIndex(
      { provider: 1, model: 1, contextLength: 1, "settings.label": 1 },
      { unique: true },
    );
    log(`${C.dim}    Connected to MongoDB (${MONGO_DB_NAME})${C.reset}`);
    return _db;
  } catch (err) {
    log(`${C.yellow}    MongoDB unavailable: ${err.message} — results will be JSON-only${C.reset}`);
    return null;
  }
}

/** Check if a benchmark run already exists in MongoDB */
async function existsInDB(provider, model, contextLength, settingsLabel) {
  if (!_db) return false;
  const doc = await _db.collection(BENCH_COLLECTION).findOne({
    provider,
    model,
    contextLength,
    "settings.label": settingsLabel,
  });
  return !!doc;
}

/** Upsert a benchmark result into MongoDB */
async function saveResult(entry) {
  if (!_db) return;
  const filter = {
    provider: PROVIDER,
    model: entry.model,
    contextLength: entry.contextLength,
    "settings.label": entry.settings.label,
  };
  await _db.collection(BENCH_COLLECTION).updateOne(
    filter,
    {
      $set: {
        ...entry,
        provider: PROVIDER,
        updatedAt: new Date().toISOString(),
      },
      $setOnInsert: {
        createdAt: new Date().toISOString(),
      },
    },
    { upsert: true },
  );
}

/** Load all existing results from MongoDB for this provider */
async function _loadExistingResults() {
  if (!_db) return [];
  return _db.collection(BENCH_COLLECTION).find({ provider: PROVIDER }).toArray();
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  const startTime = Date.now();
  const provider = PROVIDERS[PROVIDER];
  if (!provider) {
    console.error(
      `Unknown provider: ${PROVIDER}. Available: ${Object.keys(PROVIDERS).join(", ")}`,
    );
    process.exit(1);
  }

  logHeader(`VRAM Benchmark — ${provider.name}`);

  // ── Step 0: Connect to MongoDB ───────────────────────────
  await connectDB();

  // ── Step 1: GPU Baseline ─────────────────────────────────

  logSection("GPU Baseline (idle + 5× 4K displays)");

  log(
    `${C.dim}    Unloading all models for baseline measurement…${C.reset}`,
  );
  await provider.unloadAll();
  await sleep(3000);

  const baselineGPU = await sampleGPU(4000, 500);
  if (!baselineGPU) {
    console.error("Could not read GPU via nvidia-smi. Aborting.");
    process.exit(1);
  }

  const baselineVramMiB = baselineGPU.usedMiB;
  const totalVramMiB = baselineGPU.totalMiB;
  const availableForModelsMiB = totalVramMiB - baselineVramMiB;

  logKV("GPU", `${C.bold}${baselineGPU.name}${C.reset}`);
  logKV("Total VRAM", fmtMiB(totalVramMiB));
  logKV(
    "Idle VRAM (5× 4K displays)",
    `${C.yellow}${fmtMiB(baselineVramMiB)}${C.reset} (${fmtGiB(mibToGiB(baselineVramMiB))})`,
  );
  logKV(
    "Available for models",
    `${C.green}${fmtMiB(availableForModelsMiB)}${C.reset} (${fmtGiB(mibToGiB(availableForModelsMiB))})`,
  );
  logKV("Temp", `${baselineGPU.tempC}°C`);
  logKV("Power", `${baselineGPU.powerW}W`);

  // ── Step 2: Discover Models ──────────────────────────────

  logSection("Discovering Models");

  let models;
  try {
    models = await provider.listModels();
  } catch (err) {
    console.error(`Failed to list models: ${err.message}`);
    process.exit(1);
  }

  if (SINGLE_MODEL) {
    models = models.filter((m) => m.key === SINGLE_MODEL);
    if (models.length === 0) {
      console.error(`Model not found: ${SINGLE_MODEL}`);
      process.exit(1);
    }
  }

  models = models.filter((m) => {
    const sizeGB = m.sizeBytes / 1e9;
    if (SKIP_LARGE && sizeGB > 16) return false;
    return sizeGB <= MAX_SIZE_GB;
  });

  // Sort smallest → largest (fastest to bench first)
  models.sort((a, b) => a.sizeBytes - b.sizeBytes);

  logKV("Models found", `${C.bold}${models.length}${C.reset}`);
  for (const m of models) {
    const sizeGB = (m.sizeBytes / 1e9).toFixed(1);
    const tags = [
      m.vision ? "👁" : "",
      m.tools ? "🔧" : "",
      m.reasoning ? "🧠" : "",
    ]
      .filter(Boolean)
      .join(" ");
    log(
      `${C.dim}      ${m.key.padEnd(45)}${C.reset} ${sizeGB.padStart(6)}GB  ${m.architecture || "?"} ${m.quantization || "?"} ${tags}`,
    );
  }

  // ── Step 3: Build Test Plan ──────────────────────────────

  const settingsMatrix = buildSettingsMatrix();

  const testPlan = [];
  for (const model of models) {
    for (const settings of settingsMatrix) {
      for (const ctx of CONTEXT_LIST) {
        if (model.maxContextLength > 0 && ctx > model.maxContextLength)
          continue;
        testPlan.push({ model, ctx, settings });
      }
    }
  }

  logSection("Test Matrix");
  logKV("Context lengths", CONTEXT_LIST.join(", "));
  logKV(
    "Settings per model",
    `${settingsMatrix.length} (${settingsMatrix.map((s) => s.label).join(", ")})`,
  );
  logKV("Total runs", `${C.bold}${testPlan.length}${C.reset}`);
  logKV("Prompt", `"${BENCH_PROMPT.slice(0, 50)}…"`);
  logKV("Max tokens", BENCH_MAX_TOKENS);
  logKV("GPU settle time", `${SETTLE_MS}ms`);
  logKV("Sample window", `${SAMPLE_MS}ms`);
  logKV("MongoDB", _db ? `${C.green}connected${C.reset}` : `${C.dim}disabled${C.reset}`);
  logKV("Skip existing", SKIP_EXISTING ? `${C.green}yes${C.reset}` : "no");
  logKV("Rewrite", REWRITE ? `${C.yellow}yes${C.reset}` : "no");

  log(`\n${C.dim}    Settings Matrix:${C.reset}`);
  for (const s of settingsMatrix) {
    log(
      `${C.dim}      • ${s.label.padEnd(16)} flash=${String(s.flash_attention).padEnd(5)} kv_gpu=${String(s.offload_kv_cache_to_gpu).padEnd(5)} batch=${String(s.eval_batch_size).padEnd(4)} parallel=${s.parallel}${C.reset}`,
    );
  }

  // ── Step 4: Run Benchmarks ───────────────────────────────

  logHeader("Running Benchmarks");

  const results = [];
  let lastModelKey = null;
  let modelIndex = 0;

  for (let ti = 0; ti < testPlan.length; ti++) {
    const { model, ctx, settings } = testPlan[ti];

    // Print model header when switching models
    if (model.key !== lastModelKey) {
      modelIndex++;
      lastModelKey = model.key;
      const archParams = resolveArchParams(
        model.architecture,
        model.paramsString,
        model.sizeBytes,
        model.bitsPerWeight,
      );

      log(
        `\n${C.bgBlue}${C.white}${C.bold}  [${modelIndex}/${models.length}] ${model.displayName}  ${C.reset}`,
      );
      logKV("Key", model.key);
      logKV(
        "Arch",
        `${model.architecture || "?"} — ${archParams.isKnown ? "known" : "fallback estimate"}`,
      );
      logKV(
        "Quant",
        `${model.quantization || "?"} (${model.bitsPerWeight} bpw)`,
      );
      logKV("File size", `${(model.sizeBytes / 1e9).toFixed(2)} GB`);
      logKV(
        "Arch params",
        `L=${archParams.layers} KVH=${archParams.kvHeads} HD=${archParams.headDim} attn=${archParams.attnRatio}`,
      );
      if (model.rawCapabilities.reasoning) {
        logKV(
          "Reasoning",
          `${model.rawCapabilities.reasoning.allowed_options?.join(", ")} (default: ${model.rawCapabilities.reasoning.default})`,
        );
      }
      if (model.variants?.length > 1) {
        logKV("Variants", model.variants.join(", "));
      }
    }

    const archParams = resolveArchParams(
      model.architecture,
      model.paramsString,
      model.sizeBytes,
      model.bitsPerWeight,
    );

    const entry = {
      model: model.key,
      displayName: model.displayName,
      architecture: model.architecture,
      quantization: model.quantization,
      bitsPerWeight: model.bitsPerWeight,
      fileSizeBytes: model.sizeBytes,
      fileSizeGB: +(model.sizeBytes / 1e9).toFixed(2),
      contextLength: ctx,
      archParams,

      // Settings applied for this run
      settings: {
        label: settings.label,
        flash_attention: settings.flash_attention,
        offload_kv_cache_to_gpu: settings.offload_kv_cache_to_gpu,
        eval_batch_size: settings.eval_batch_size,
        parallel: settings.parallel,
      },

      // Measurements (to be filled)
      baselineVramMiB,
      loadedVramMiB: 0,
      modelVramMiB: 0,
      modelVramGiB: 0,
      estimatedGiB: 0,
      deltaGiB: 0,
      fitsInVram: false,

      generation: null,
      tokensPerSecond: 0,
      loadTimeMs: 0,
      error: null,

      gpu: { temp: 0, power: 0, utilization: 0 },
      loadConfig: null,
    };

    try {
      // Skip if already benchmarked and --skip-existing is set
      if (SKIP_EXISTING && !REWRITE) {
        const exists = await existsInDB(PROVIDER, model.key, ctx, settings.label);
        if (exists) {
          log(
            `    ${C.dim}[${settings.label}] ctx=${ctx} → skipped (already in DB)${C.reset}`,
          );
          continue;
        }
      }

      // Compute VRAM estimate
      const estimated = estimateMemory({
        sizeBytes: model.sizeBytes,
        archParams,
        gpuLayers: archParams.layers, // LM Studio auto-offloads max
        contextLength: ctx,
        offloadKvCache: settings.offload_kv_cache_to_gpu,
        flashAttention: settings.flash_attention,
        vision: model.vision,
      });
      entry.estimatedGiB = +estimated.gpuGiB.toFixed(3);
      entry.fitsInVram =
        estimated.gpuGiB <= mibToGiB(availableForModelsMiB);

      // Skip if would clearly OOM (1.5 GiB safety margin)
      if (
        estimated.gpuGiB >
        mibToGiB(availableForModelsMiB) + 1.5
      ) {
        entry.error = `SKIP: est. ${fmtGiB(estimated.gpuGiB)} > avail. ${fmtGiB(mibToGiB(availableForModelsMiB))}`;
        log(
          `    ${C.dim}[${settings.label}]${C.reset} ctx=${ctx} → ${C.red}${entry.error}${C.reset}`,
        );
        results.push(entry);
        continue;
      }

      // Load model with settings
      process.stdout.write(
        `    ${C.yellow}[${settings.label}]${C.reset} ctx=${ctx} → loading…`,
      );
      const loadStart = Date.now();

      const loadResult = await provider.loadModel(
        model.key,
        ctx,
        settings,
      );
      entry.loadConfig = loadResult?.load_config || null;
      entry.loadTimeMs = Date.now() - loadStart;

      process.stdout.write(
        ` ${C.dim}(${(entry.loadTimeMs / 1000).toFixed(1)}s)${C.reset}`,
      );

      // Sample GPU VRAM after settling
      await sleep(1000);
      const loadedGPU = await sampleGPU(SAMPLE_MS, 250);
      entry.loadedVramMiB = loadedGPU?.usedMiB || 0;
      entry.modelVramMiB = entry.loadedVramMiB - baselineVramMiB;
      entry.modelVramGiB = +mibToGiB(entry.modelVramMiB).toFixed(3);
      entry.deltaGiB = +(
        entry.modelVramGiB - entry.estimatedGiB
      ).toFixed(3);
      entry.gpu.temp = loadedGPU?.tempC || 0;
      entry.gpu.power = loadedGPU?.powerW || 0;
      entry.gpu.utilization = loadedGPU?.utilPct || 0;

      // Generate to warm up KV cache + measure throughput
      process.stdout.write(` gen…`);
      const genStart = Date.now();
      const gen = await provider.generate(
        model.key,
        BENCH_PROMPT,
        BENCH_MAX_TOKENS,
      );
      const genMs = Date.now() - genStart;
      entry.generation = {
        inputTokens: gen.inputTokens,
        outputTokens: gen.outputTokens,
        totalTokens: gen.totalTokens,
        textLength: gen.text?.length || 0,
      };
      entry.tokensPerSecond =
        gen.outputTokens > 0
          ? +(gen.outputTokens / (genMs / 1000)).toFixed(1)
          : 0;

      // Post-generation GPU sample (KV cache is now warm)
      const postGenGPU = await sampleGPU(3000, 250);
      if (postGenGPU && postGenGPU.usedMiB > entry.loadedVramMiB) {
        entry.loadedVramMiB = postGenGPU.usedMiB;
        entry.modelVramMiB = postGenGPU.usedMiB - baselineVramMiB;
        entry.modelVramGiB = +mibToGiB(
          entry.modelVramMiB,
        ).toFixed(3);
        entry.deltaGiB = +(
          entry.modelVramGiB - entry.estimatedGiB
        ).toFixed(3);
        entry.gpu.temp = postGenGPU.tempC;
        entry.gpu.power = postGenGPU.powerW;
      }

      process.stdout.write(` ${C.green}done${C.reset}\n`);

      // Per-run metrics
      const dc =
        Math.abs(entry.deltaGiB) < 0.5
          ? C.green
          : Math.abs(entry.deltaGiB) < 1.5
            ? C.yellow
            : C.red;
      log(
        `${C.dim}        actual=${C.reset}${C.cyan}${fmtGiB(entry.modelVramGiB)}${C.reset}${C.dim}  est=${C.reset}${fmtGiB(entry.estimatedGiB)}${C.dim}  Δ=${C.reset}${dc}${entry.deltaGiB >= 0 ? "+" : ""}${entry.deltaGiB.toFixed(2)}${C.reset}${C.dim}  ${entry.tokensPerSecond} tok/s  ${entry.gpu.temp}°C ${entry.gpu.power}W${C.reset}`,
      );
    } catch (err) {
      entry.error = err.message;
      process.stdout.write(` ${C.red}FAILED${C.reset}\n`);
      log(
        `${C.red}        Error: ${err.message.slice(0, 120)}${C.reset}`,
      );
    }

    results.push(entry);

    // Persist to MongoDB
    await saveResult(entry);
  }

  // ── Step 5: Summary Report ──────────────────────────────

  logHeader("Summary Report");

  // Group by model
  const byModel = {};
  for (const r of results) {
    if (!byModel[r.model]) byModel[r.model] = [];
    byModel[r.model].push(r);
  }

  // ── Per-model default settings comparison
  logSection("Per-Model VRAM (default settings, smallest context)");
  log(
    `  ${"Model".padEnd(45)} │ ${"Actual".padStart(10)} │ ${"Est.".padStart(10)} │ ${"Δ".padStart(8)} │ ${"tok/s".padStart(7)}`,
  );
  log(
    `  ${"─".repeat(45)}─┼${"─".repeat(12)}┼${"─".repeat(12)}┼${"─".repeat(10)}┼${"─".repeat(9)}`,
  );

  for (const [, runs] of Object.entries(byModel)) {
    const defaultRuns = runs.filter(
      (r) => r.settings.label === "default" && !r.error,
    );
    const run =
      defaultRuns[0] || runs.find((r) => !r.error) || runs[0];

    const status = run.error
      ? `${C.red}✗${C.reset}`
      : `${C.green}✓${C.reset}`;
    const actual = fmtGiB(run.modelVramGiB).padStart(10);
    const est = fmtGiB(run.estimatedGiB).padStart(10);
    const deltaStr =
      (run.deltaGiB >= 0 ? "+" : "") + run.deltaGiB.toFixed(2);
    const dc =
      Math.abs(run.deltaGiB) < 0.5
        ? C.green
        : Math.abs(run.deltaGiB) < 1.5
          ? C.yellow
          : C.red;
    const tps = String(run.tokensPerSecond || "-").padStart(7);

    log(
      `  ${status} ${C.bold}${run.model.padEnd(43).slice(0, 43)}${C.reset} │ ${C.cyan}${actual}${C.reset} │ ${est} │ ${dc}${deltaStr.padStart(8)}${C.reset} │ ${tps}`,
    );
  }

  // ── Settings impact analysis
  if (!SKIP_SETTINGS) {
    logSection("Settings Impact (VRAM delta from default)");

    for (const [modelKey, runs] of Object.entries(byModel)) {
      const defaultRun = runs.find(
        (r) => r.settings.label === "default" && !r.error,
      );
      if (!defaultRun) continue;

      const baseCtx = defaultRun.contextLength;
      const others = runs.filter(
        (r) =>
          r.contextLength === baseCtx &&
          r.settings.label !== "default" &&
          !r.error,
      );
      if (others.length === 0) continue;

      log(`\n    ${C.bold}${modelKey}${C.reset} (ctx=${baseCtx})`);
      log(
        `      ${"Setting".padEnd(18)} │ ${"VRAM".padStart(10)} │ ${"vs Default".padStart(12)} │ ${"tok/s".padStart(7)}`,
      );
      log(
        `      ${"─".repeat(18)}─┼${"─".repeat(12)}┼${"─".repeat(14)}┼${"─".repeat(9)}`,
      );
      log(
        `      ${"default".padEnd(18)} │ ${fmtGiB(defaultRun.modelVramGiB).padStart(10)} │ ${"baseline".padStart(12)} │ ${String(defaultRun.tokensPerSecond).padStart(7)}`,
      );

      for (const r of others) {
        const diff = r.modelVramGiB - defaultRun.modelVramGiB;
        const diffStr =
          (diff >= 0 ? "+" : "") + diff.toFixed(2) + " GiB";
        const dc =
          diff < -0.5
            ? C.green
            : diff > 0.5
              ? C.red
              : C.yellow;
        const tpsDiff =
          r.tokensPerSecond - defaultRun.tokensPerSecond;
        const tpsColor =
          tpsDiff > 2 ? C.green : tpsDiff < -2 ? C.red : C.dim;

        log(
          `      ${r.settings.label.padEnd(18)} │ ${fmtGiB(r.modelVramGiB).padStart(10)} │ ${dc}${diffStr.padStart(12)}${C.reset} │ ${tpsColor}${String(r.tokensPerSecond).padStart(7)}${C.reset}`,
        );
      }
    }
  }

  // ── Estimation accuracy
  const successfulRuns = results.filter(
    (r) => !r.error && r.modelVramGiB > 0,
  );
  if (successfulRuns.length > 0) {
    const deltas = successfulRuns.map((r) => Math.abs(r.deltaGiB));
    const avgDelta =
      deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const maxDelta = Math.max(...deltas);
    const within05 = deltas.filter((d) => d < 0.5).length;
    const within15 = deltas.filter((d) => d < 1.5).length;

    logSection("Estimation Accuracy");
    logKV("Total runs", successfulRuns.length);
    logKV("Avg |Δ|", `${avgDelta.toFixed(3)} GiB`);
    logKV("Max |Δ|", `${maxDelta.toFixed(3)} GiB`);
    logKV(
      "Within ±0.5 GiB",
      `${within05}/${successfulRuns.length} (${((within05 / successfulRuns.length) * 100).toFixed(0)}%)`,
    );
    logKV(
      "Within ±1.5 GiB",
      `${within15}/${successfulRuns.length} (${((within15 / successfulRuns.length) * 100).toFixed(0)}%)`,
    );
  }

  // ── Context scaling
  logSection("Context Length Scaling (VRAM increase per model)");
  for (const [modelKey, runs] of Object.entries(byModel)) {
    const defaults = runs
      .filter(
        (r) =>
          r.settings.label === "default" &&
          !r.error &&
          r.modelVramGiB > 0,
      )
      .sort((a, b) => a.contextLength - b.contextLength);
    if (defaults.length < 2) continue;

    log(`    ${C.bold}${modelKey}${C.reset}`);
    for (let i = 1; i < defaults.length; i++) {
      const prev = defaults[i - 1];
      const curr = defaults[i];
      const vramDiff = curr.modelVramGiB - prev.modelVramGiB;
      log(
        `      ${prev.contextLength}→${curr.contextLength}: ${vramDiff >= 0 ? "+" : ""}${vramDiff.toFixed(2)} GiB`,
      );
    }
  }

  // ── VRAM budget
  logSection("VRAM Budget");
  logKV("GPU", baselineGPU.name);
  logKV("Total", fmtGiB(mibToGiB(totalVramMiB)));
  logKV(
    "Idle (5× 4K displays)",
    `${C.yellow}${fmtGiB(mibToGiB(baselineVramMiB))}${C.reset}`,
  );
  logKV(
    "Available",
    `${C.green}${fmtGiB(mibToGiB(availableForModelsMiB))}${C.reset}`,
  );

  log(`\n    Models that fit (default settings):`);
  for (const ctx of CONTEXT_LIST) {
    const fitting = results.filter(
      (r) =>
        r.contextLength === ctx &&
        r.settings.label === "default" &&
        !r.error &&
        r.modelVramGiB > 0 &&
        r.modelVramGiB <= mibToGiB(availableForModelsMiB),
    );
    const notFitting = results.filter(
      (r) =>
        r.contextLength === ctx &&
        r.settings.label === "default" &&
        (r.error?.startsWith("SKIP") ||
          r.modelVramGiB > mibToGiB(availableForModelsMiB)),
    );
    log(
      `      ${C.bold}ctx=${ctx}${C.reset}: ${C.green}${fitting.length} fit${C.reset}, ${C.red}${notFitting.length} won't${C.reset}`,
    );
  }

  // ── Step 6: Write JSON Report ────────────────────────────

  const report = {
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    provider: PROVIDER,
    gpu: {
      name: baselineGPU.name,
      totalMiB: totalVramMiB,
      totalGiB: +mibToGiB(totalVramMiB).toFixed(2),
      baselineMiB: baselineVramMiB,
      baselineGiB: +mibToGiB(baselineVramMiB).toFixed(2),
      availableMiB: availableForModelsMiB,
      availableGiB: +mibToGiB(availableForModelsMiB).toFixed(2),
      baselineNote:
        "Includes 5× 4K display compositing overhead",
    },
    settings: {
      contextLengths: CONTEXT_LIST,
      settingsMatrix: settingsMatrix.map((s) => ({
        label: s.label,
        flash_attention: s.flash_attention,
        offload_kv_cache_to_gpu: s.offload_kv_cache_to_gpu,
        eval_batch_size: s.eval_batch_size,
        parallel: s.parallel,
      })),
      prompt: BENCH_PROMPT,
      maxTokens: BENCH_MAX_TOKENS,
      settleMs: SETTLE_MS,
      sampleMs: SAMPLE_MS,
    },
    modelsTotal: models.length,
    runsTotal: results.length,
    runsSuccessful: successfulRuns.length,
    results,
  };

  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));
  log(
    `\n${C.green}${C.bold}  ✓ JSON report saved:${C.reset} ${OUT_PATH}`,
  );
  log(
    `${C.dim}    Duration: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes${C.reset}\n`,
  );

  // Summary of MongoDB persistence
  if (_db) {
    const dbCount = await _db.collection(BENCH_COLLECTION).countDocuments({ provider: PROVIDER });
    log(`${C.green}${C.bold}  ✓ MongoDB:${C.reset} ${dbCount} total benchmark results for ${PROVIDER}`);
  }

  // Final cleanup
  await provider.unloadAll();

  // Close MongoDB
  if (_db) {
    try { await _db.client.close(); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error(`\nFatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});

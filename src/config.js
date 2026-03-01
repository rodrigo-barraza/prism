// ============================================================
// Prism the AI Gateway — Configuration & Reference Catalog
// ============================================================

// PROVIDERS
const PROVIDERS = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GOOGLE: 'google',
  ELEVENLABS: 'elevenlabs',
  OPENAI_COMPATIBLE: 'openai-compatible',
};

const PROVIDER_LIST = Object.values(PROVIDERS);

// ============================================================
// TEXT-TO-TEXT MODELS
// ============================================================
// Each model is defined once with all its metadata.
// MODEL_OPTIONS, DEFAULT_MODELS, and PRICING are derived below.

const TEXT2TEXT_MODELS = {
  // OpenAI
  GPT_5_2: {
    name: 'gpt-5.2',
    label: 'GPT 5.2',
    provider: PROVIDERS.OPENAI,
    pricing: { inputPerMillion: 1.75, outputPerMillion: 14.0 },
  },
  GPT_5_MINI: {
    name: 'gpt-5-mini',
    label: 'GPT 5 Mini',
    provider: PROVIDERS.OPENAI,
    default: true,
    pricing: { inputPerMillion: 0.25, outputPerMillion: 2.0 },
  },
  GPT_5_NANO: {
    name: 'gpt-5-nano',
    label: 'GPT 5 Nano',
    provider: PROVIDERS.OPENAI,
    pricing: { inputPerMillion: 0.05, outputPerMillion: 0.4 },
  },

  // Anthropic
  HAIKU_45: {
    name: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    provider: PROVIDERS.ANTHROPIC,
    pricing: { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  },
  SONNET_45: {
    name: 'claude-sonnet-4-5-20250929',
    label: 'Sonnet 4.5',
    provider: PROVIDERS.ANTHROPIC,
    default: true,
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  },
  SONNET_46: {
    name: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    provider: PROVIDERS.ANTHROPIC,
    pricing: { inputPerMillion: 3.0, outputPerMillion: 15.0 },
  },
  OPUS_45: {
    name: 'claude-opus-4-5-20251101',
    label: 'Opus 4.5',
    provider: PROVIDERS.ANTHROPIC,
    pricing: { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  },
  OPUS_46: {
    name: 'claude-opus-4-6',
    label: 'Opus 4.6',
    provider: PROVIDERS.ANTHROPIC,
    pricing: { inputPerMillion: 5.0, outputPerMillion: 25.0 },
  },

  // Google
  GEMINI_3_FLASH: {
    name: 'gemini-3-flash-preview',
    label: 'Gemini 3 Flash',
    provider: PROVIDERS.GOOGLE,
    default: true,
    pricing: { inputPerMillion: 0.5, outputPerMillion: 3.0 },
  },
  GEMINI_3_PRO: {
    name: 'gemini-3-pro-preview',
    label: 'Gemini 3 Pro',
    provider: PROVIDERS.GOOGLE,
    pricing: { inputPerMillion: 2.0, outputPerMillion: 12.0 },
  },
  GEMINI_31_PRO: {
    name: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Pro',
    provider: PROVIDERS.GOOGLE,
    pricing: { inputPerMillion: 2.0, outputPerMillion: 12.0 },
  },

  // OpenAI-Compatible / Local
  QWEN_VL_8B: {
    name: 'qwen/qwen3-vl-8b',
    label: 'Qwen3 VL 8B',
    provider: PROVIDERS.OPENAI_COMPATIBLE,
    listed: false,
  },
  JOSIEFIED_QWEN: {
    name: 'josiefied-qwen3-8b-abliterated-v1',
    label: 'Josiefied Qwen3 8B',
    provider: PROVIDERS.OPENAI_COMPATIBLE,
  },
};

// --- Derived convenience maps (auto-built from TEXT2TEXT_MODELS) ---

const _t2tModelOptions = {};
const _t2tDefaultModels = { [PROVIDERS.OPENAI_COMPATIBLE]: 'default' };
const _t2tPricing = {};

for (const model of Object.values(TEXT2TEXT_MODELS)) {
  if (model.listed !== false) {
    (_t2tModelOptions[model.provider] ??= []).push({
      name: model.name,
      label: model.label,
    });
  }
  if (model.default) {
    _t2tDefaultModels[model.provider] = model.name;
  }
  if (model.pricing) {
    _t2tPricing[model.name] = model.pricing;
  }
}

const TEXT2TEXT = {
  MODELS: TEXT2TEXT_MODELS,
  MODEL_OPTIONS: _t2tModelOptions,
  DEFAULT_MODELS: _t2tDefaultModels,
  PRICING: _t2tPricing,
};

// ============================================================
// TEXT-TO-SPEECH MODELS & VOICES
// ============================================================

const TEXT2SPEECH_MODELS = {
  // Google
  GEMINI_2_FLASH_LITE_PREVIEW_TTS: 'gemini-2.0-flash-lite-preview-tts',
  GEMINI_25_FLASH_LITE_TTS: 'gemini-2.5-flash-lite-preview-tts',
  GEMINI_25_FLASH_TTS: 'gemini-2.5-flash-tts',
  GEMINI_25_PRO: 'gemini-2.5-pro-tts',
  ESPEAKNG: 'espeak-ng',

  // OpenAI (provider-specific)
  GPT_4O_MINI_TTS: 'gpt-4o-mini-tts',

  // ElevenLabs (provider-specific)
  ELEVEN_TURBO_V2: 'eleven_turbo_v2',
};

const TEXT2SPEECH_MODEL_OPTIONS = {
  [PROVIDERS.OPENAI]: [
    { name: TEXT2SPEECH_MODELS.GPT_4O_MINI_TTS, label: 'GPT 4o Mini TTS' },
  ],
  [PROVIDERS.GOOGLE]: [
    {
      name: TEXT2SPEECH_MODELS.GEMINI_2_FLASH_LITE_PREVIEW_TTS,
      label: 'Gemini 2.0 Flash Lite TTS',
    },
    {
      name: TEXT2SPEECH_MODELS.GEMINI_25_FLASH_LITE_TTS,
      label: 'Gemini 2.5 Flash Lite TTS',
    },
    {
      name: TEXT2SPEECH_MODELS.GEMINI_25_FLASH_TTS,
      label: 'Gemini 2.5 Flash TTS',
    },
    { name: TEXT2SPEECH_MODELS.GEMINI_25_PRO, label: 'Gemini 2.5 Pro TTS' },
  ],
  [PROVIDERS.ELEVENLABS]: [
    { name: TEXT2SPEECH_MODELS.ELEVEN_TURBO_V2, label: 'Eleven Turbo v2' },
  ],
};

const TEXT2SPEECH_DEFAULT_MODELS = {
  [PROVIDERS.OPENAI]: TEXT2SPEECH_MODELS.GPT_4O_MINI_TTS,
  [PROVIDERS.GOOGLE]: TEXT2SPEECH_MODELS.GEMINI_25_PRO,
  [PROVIDERS.ELEVENLABS]: TEXT2SPEECH_MODELS.ELEVEN_TURBO_V2,
};

// --- Voices ---

const OPENAI_VOICES = [
  { name: 'alloy', gender: 'Neutral' },
  { name: 'ash', gender: 'Male' },
  { name: 'ballad', gender: 'Male' },
  { name: 'coral', gender: 'Female' },
  { name: 'echo', gender: 'Male' },
  { name: 'fable', gender: 'Male' },
  { name: 'nova', gender: 'Female' },
  { name: 'onyx', gender: 'Male' },
  { name: 'sage', gender: 'Female' },
  { name: 'shimmer', gender: 'Female' },
  { name: 'verse', gender: 'Male' },
  { name: 'marin', gender: 'Female' },
  { name: 'cedar', gender: 'Male' },
];

const GOOGLE_VOICES = [
  { name: 'Achernar', gender: 'Female' },
  { name: 'Achird', gender: 'Male' },
  { name: 'Algenib', gender: 'Male' },
  { name: 'Algieba', gender: 'Male' },
  { name: 'Alnilam', gender: 'Male' },
  { name: 'Aoede', gender: 'Female' },
  { name: 'Autonoe', gender: 'Female' },
  { name: 'Callirrhoe', gender: 'Female' },
  { name: 'Charon', gender: 'Male' },
  { name: 'Despina', gender: 'Female' },
  { name: 'Enceladus', gender: 'Male' },
  { name: 'Erinome', gender: 'Female' },
  { name: 'Fenrir', gender: 'Male' },
  { name: 'Gacrux', gender: 'Female' },
  { name: 'Iapetus', gender: 'Male' },
  { name: 'Kore', gender: 'Female' },
  { name: 'Laomedeia', gender: 'Female' },
  { name: 'Leda', gender: 'Female' },
  { name: 'Orus', gender: 'Male' },
  { name: 'Pulcherrima', gender: 'Female' },
  { name: 'Puck', gender: 'Male' },
  { name: 'Rasalgethi', gender: 'Male' },
  { name: 'Sadachbia', gender: 'Male' },
  { name: 'Sadaltager', gender: 'Male' },
  { name: 'Schedar', gender: 'Male' },
  { name: 'Sulafat', gender: 'Female' },
  { name: 'Umbriel', gender: 'Male' },
  { name: 'Vindemiatrix', gender: 'Female' },
  { name: 'Zephyr', gender: 'Female' },
  { name: 'Zubenelgenubi', gender: 'Male' },
];

const ELEVENLABS_VOICES = [
  { name: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel', gender: 'Female' },
  { name: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella', gender: 'Female' },
  { name: 'ErXwobaYiN019PkySvjV', label: 'Antoni', gender: 'Male' },
  { name: 'MF3mGyEYCl7XYWbV9V6O', label: 'Elli', gender: 'Female' },
  { name: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh', gender: 'Male' },
  { name: 'VR6AewLTigWG4xSOukaG', label: 'Arnold', gender: 'Male' },
  { name: 'pNInz6obpgDQGcFmaJgB', label: 'Adam', gender: 'Male' },
  { name: 'yoZ06aMxZJJ28mfd3POQ', label: 'Sam', gender: 'Male' },
];

const TEXT2SPEECH_VOICES = {
  [PROVIDERS.OPENAI]: OPENAI_VOICES,
  [PROVIDERS.GOOGLE]: GOOGLE_VOICES,
  [PROVIDERS.ELEVENLABS]: ELEVENLABS_VOICES,
};

const TEXT2SPEECH_DEFAULT_VOICES = {
  [PROVIDERS.OPENAI]: 'echo',
  [PROVIDERS.GOOGLE]: 'Kore',
  [PROVIDERS.ELEVENLABS]: '21m00Tcm4TlvDq8ikWAM',
};

// ============================================================
// TEXT-TO-IMAGE MODELS
// ============================================================

// All text-to-image models are currently defined in the node backend.
const TEXT2IMAGE_MODELS = {};

const TEXT2IMAGE_MODEL_OPTIONS = {};

const TEXT2IMAGE_DEFAULT_MODELS = {};

// ============================================================
// IMAGE-TO-TEXT (VISION) MODELS
// ============================================================

const IMAGE2TEXT_MODELS = {
  // Google
  GEMINI_3_FLASH: 'gemini-3-flash-preview',
  GEMINI_3_PRO: 'gemini-3-pro-image-preview',

  // OpenAI-Compatible / Local
  QWEN_VL_8B: 'qwen/qwen3-vl-8b',
};

const IMAGE2TEXT_MODEL_OPTIONS = {
  [PROVIDERS.GOOGLE]: [
    { name: IMAGE2TEXT_MODELS.GEMINI_3_FLASH, label: 'Gemini 3 Flash' },
    { name: IMAGE2TEXT_MODELS.GEMINI_3_PRO, label: 'Gemini 3 Pro' },
  ],
  [PROVIDERS.OPENAI_COMPATIBLE]: [
    { name: IMAGE2TEXT_MODELS.QWEN_VL_8B, label: 'Qwen3-VL-8B' },
  ],
};

const IMAGE2TEXT_DEFAULT_MODELS = {
  [PROVIDERS.GOOGLE]: IMAGE2TEXT_MODELS.GEMINI_3_FLASH,
  [PROVIDERS.OPENAI_COMPATIBLE]: IMAGE2TEXT_MODELS.QWEN_VL_8B,
};

// ============================================================
// EMBEDDING MODELS
// ============================================================

const EMBEDDING_MODELS = {
  TEXT_EMBEDDING_3_SMALL: 'text-embedding-3-small',
  TEXT_EMBEDDING_3_LARGE: 'text-embedding-3-large',
  TEXT_EMBEDDING_ADA_002: 'text-embedding-ada-002',
};

const EMBEDDING_MODEL_OPTIONS = {
  [PROVIDERS.OPENAI]: [
    {
      name: EMBEDDING_MODELS.TEXT_EMBEDDING_3_SMALL,
      label: 'Embedding 3 Small',
    },
    {
      name: EMBEDDING_MODELS.TEXT_EMBEDDING_3_LARGE,
      label: 'Embedding 3 Large',
    },
    {
      name: EMBEDDING_MODELS.TEXT_EMBEDDING_ADA_002,
      label: 'Ada 002 (Legacy)',
    },
  ],
};

const EMBEDDING_DEFAULT_MODELS = {
  [PROVIDERS.OPENAI]: EMBEDDING_MODELS.TEXT_EMBEDDING_3_SMALL,
};

// ============================================================
// PROVIDER CAPABILITIES MAP
// ============================================================

const PROVIDER_CAPABILITIES = {
  [PROVIDERS.OPENAI]: {
    textToText: true,
    textToTextStream: true,
    textToSpeech: true,
    textToImage: false,
    imageToText: true,
    textToEmbedding: true,
  },
  [PROVIDERS.ANTHROPIC]: {
    textToText: true,
    textToTextStream: true,
    textToSpeech: false,
    textToImage: false,
    imageToText: false,
    textToEmbedding: false,
  },
  [PROVIDERS.GOOGLE]: {
    textToText: true,
    textToTextStream: true,
    textToSpeech: true,
    textToImage: true,
    imageToText: true,
    textToEmbedding: false,
  },
  [PROVIDERS.ELEVENLABS]: {
    textToText: false,
    textToTextStream: false,
    textToSpeech: true,
    textToSpeechStream: true,
    textToImage: false,
    imageToText: false,
    textToEmbedding: false,
  },
  [PROVIDERS.OPENAI_COMPATIBLE]: {
    textToText: true,
    textToTextStream: false,
    textToSpeech: false,
    textToImage: false,
    imageToText: true,
    textToEmbedding: false,
  },
};

// ============================================================
// EXPORTS
// ============================================================

export {
  // Providers
  PROVIDERS,
  PROVIDER_LIST,
  PROVIDER_CAPABILITIES,

  // Text-to-Text
  TEXT2TEXT,

  // Text-to-Speech
  TEXT2SPEECH_MODELS,
  TEXT2SPEECH_MODEL_OPTIONS,
  TEXT2SPEECH_DEFAULT_MODELS,
  TEXT2SPEECH_VOICES,
  TEXT2SPEECH_DEFAULT_VOICES,
  OPENAI_VOICES,
  GOOGLE_VOICES,
  ELEVENLABS_VOICES,

  // Text-to-Image
  TEXT2IMAGE_MODELS,
  TEXT2IMAGE_MODEL_OPTIONS,
  TEXT2IMAGE_DEFAULT_MODELS,

  // Image-to-Text
  IMAGE2TEXT_MODELS,
  IMAGE2TEXT_MODEL_OPTIONS,
  IMAGE2TEXT_DEFAULT_MODELS,

  // Embeddings
  EMBEDDING_MODELS,
  EMBEDDING_MODEL_OPTIONS,
  EMBEDDING_DEFAULT_MODELS,
};

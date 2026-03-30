import { handleChat } from "../routes/chat.js";
import { handleVoice } from "../routes/audio.js";
import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
} from "@google/genai";
import { GOOGLE_API_KEY } from "../../secrets.js";
import crypto from "crypto";
import logger from "../utils/logger.js";
import RequestLogger from "../services/RequestLogger.js";
import { calculateLiveCost } from "../utils/CostCalculator.js";
import { getModelByName } from "../config.js";

/**
 * Set up WebSocket handlers on the HTTP server.
 * Routes:
 *   /ws/chat   — Streaming chat (text, images, code, thinking, etc.)
 *   /ws/text-to-audio  — Streaming TTS (binary audio frames)
 *   /ws/live   — Persistent Live API session (audio/text bidirectional)
 */
export function setupWebSocket(wss) {
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    const project =
      req.headers["x-project"] || url.searchParams.get("project") || "unknown";
    const username =
      req.headers["x-username"] ||
      url.searchParams.get("username") ||
      "unknown";
    const clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket.remoteAddress;
    logger.info(
      `WebSocket connection on ${pathname} (project: ${project}, user: ${username})`,
    );

    if (pathname === "/ws/chat") {
      handleWsChat(ws, project, username, clientIp);
    } else if (pathname === "/ws/text-to-audio") {
      handleWsVoice(ws, project, username, clientIp);
    } else if (pathname === "/ws/live") {
      handleWsLive(ws, project, username, clientIp);
    } else {
      ws.send(
        JSON.stringify({
          type: "error",
          message: `Unknown WebSocket path: ${pathname}`,
        }),
      );
      ws.close();
    }
  });
}

/**
 * WebSocket chat handler — delegates to shared handleChat() from chat.js.
 */
function handleWsChat(ws, project, username, clientIp) {
  ws.on("message", async (rawData) => {
    let data;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    await handleChat({ ...data, project, username, clientIp }, (event) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });
  });
}

/**
 * WebSocket voice handler — delegates to shared handleVoice() from voice.js.
 * Sends binary audio frames for audio data, JSON for control events.
 */
function handleWsVoice(ws, project, username, clientIp) {
  ws.on("message", async (rawData) => {
    let data;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    try {
      await handleVoice(
        { ...data, project, username, clientIp },
        (chunk) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(chunk); // Binary audio frame
          }
        },
        (event) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(event));
          }
        },
      );
    } catch {
      // Error already emitted via emitJSON in handleVoice
    }
  });
}

// ============================================================
// Live API — persistent bidirectional session proxy
// ============================================================

/**
 * Manages a persistent Live API WebSocket session.
 *
 * Protocol (client → Prism):
 *   { type: "setup", model, config }       — Initialize the Live API session
 *   { type: "audio", data }                — Base64-encoded PCM audio chunk
 *   { type: "text", text }                 — Text input
 *   { type: "toolResponse", responses }    — Function call responses
 *   { type: "close" }                      — Close the session
 *
 * Protocol (Prism → client):
 *   { type: "setupComplete" }              — Session is ready
 *   { type: "audio", data, mimeType }      — Audio chunk from model
 *   { type: "text", text }                 — Text chunk from model
 *   { type: "thinking", content }          — Thinking content
 *   { type: "toolCall", functionCalls }    — Tool call request
 *   { type: "inputTranscription", text }   — Transcription of user audio
 *   { type: "outputTranscription", text }  — Transcription of model audio
 *   { type: "turnComplete" }               — Model finished responding
 *   { type: "interrupted" }                — Model was interrupted
 *   { type: "error", message }             — Error
 */
function handleWsLive(ws, project, username, _clientIp) {
  let liveSession = null;
  /** @type {string[]} Accumulated base64 PCM audio chunks for current turn (model output, 24kHz) */
  let turnAudioChunks = [];
  let audioSampleRate = 24000;
  /** @type {string[]} Accumulated base64 PCM audio chunks for current turn (user input, 16kHz) */
  const userInputAudioChunks = [];
  const userInputSampleRate = 16000;
  /** Whether user audio upload has been triggered for this turn */
  let userAudioUploading = false;
  /** Accumulated usage across the current turn */
  let turnUsage = { inputTokens: 0, outputTokens: 0 };

  // Variables for Request Logging
  let activeModel = "gemini-3.1-flash-live-preview";
  let activeConversationId = null;
  let activeConfig = {};
  
  let turnStart = performance.now();
  let passFirstTokenTime = null;
  let turnText = "";
  let turnThinking = "";
  let turnToolCalls = [];
  let turnInputText = "";
  let turnUserAudioRef = null;

  function emit(event) {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }

  /**
   * Build a WAV from accumulated PCM chunks, upload to MinIO, and return the ref.
   * @param {string[]} chunks - base64-encoded PCM chunks
   * @param {number} sampleRate - sample rate of the PCM data
   * @returns {Promise<string|null>} MinIO ref or null on failure
   */
  async function buildAndUploadAudio(chunks = turnAudioChunks, sampleRate = audioSampleRate) {
    if (chunks.length === 0) return null;
    try {
      const pcmBuffers = chunks.map((b64) =>
        Buffer.from(b64, "base64"),
      );
      const pcmData = Buffer.concat(pcmBuffers);

      const numChannels = 1;
      const bitsPerSample = 16;
      const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
      const blockAlign = numChannels * (bitsPerSample / 8);
      const wavHeader = Buffer.alloc(44);
      wavHeader.write("RIFF", 0);
      wavHeader.writeUInt32LE(36 + pcmData.length, 4);
      wavHeader.write("WAVE", 8);
      wavHeader.write("fmt ", 12);
      wavHeader.writeUInt32LE(16, 16);
      wavHeader.writeUInt16LE(1, 20);
      wavHeader.writeUInt16LE(numChannels, 22);
      wavHeader.writeUInt32LE(sampleRate, 24);
      wavHeader.writeUInt32LE(byteRate, 28);
      wavHeader.writeUInt16LE(blockAlign, 32);
      wavHeader.writeUInt16LE(bitsPerSample, 34);
      wavHeader.write("data", 36);
      wavHeader.writeUInt32LE(pcmData.length, 40);

      const wavBuffer = Buffer.concat([wavHeader, pcmData]);
      const dataUrl = `data:audio/wav;base64,${wavBuffer.toString("base64")}`;

      const FileService = (await import("../services/FileService.js")).default;
      const { ref } = await FileService.uploadFile(
        dataUrl,
        "generations",
        project,
        username,
      );
      return ref;
    } catch (err) {
      logger.error(`[Live API] Failed to build/upload WAV: ${err.message}`);
      return null;
    }
  }

  ws.on("message", async (rawData) => {
    let data;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      emit({ type: "error", message: "Invalid JSON" });
      return;
    }

    const { type } = data;

    // ── Setup: create a new Live API session ────────────────────
    if (type === "setup") {
      if (liveSession) {
        try {
          liveSession.close();
        } catch {
          /* ignore */
        }
        liveSession = null;
      }

      const model = data.model || "gemini-3.1-flash-live-preview";
      const clientConfig = data.config || {};
      
      activeModel = model;
      activeConversationId = data.conversationId || clientConfig?.conversationId || null;

      // Tools setup
      const tools = [];
      if (clientConfig.enabledTools && Array.isArray(clientConfig.enabledTools)) {
        const enabledSet = new Set(clientConfig.enabledTools);
        
        if (enabledSet.has("Web Search") || enabledSet.has("Google Search")) {
          tools.push({ googleSearch: {} });
        }
        
        try {
          const ToolOrchestratorService = (await import("../services/ToolOrchestratorService.js")).default;
          const { convertToolsToGoogle } = await import("../providers/google.js");
          const MongoWrapper = (await import("../wrappers/MongoWrapper.js")).default;
          const { MONGO_DB_NAME } = await import("../../secrets.js");

          const dynamicTools = [...ToolOrchestratorService.getToolSchemas()];

          const mClient = MongoWrapper.getClient(MONGO_DB_NAME);
          if (mClient) {
            const customToolsData = await mClient
              .db(MONGO_DB_NAME)
              .collection("custom_tools")
              .find({ project, username, enabled: true })
              .toArray();
              
            for (const t of customToolsData) {
              dynamicTools.push({
                name: t.name,
                description: t.description,
                parameters: {
                  type: "object",
                  properties: Object.fromEntries(
                    (t.parameters || []).map((p) => [
                      p.name,
                      {
                        type: p.type || "string",
                        description: p.description || "",
                        ...(p.enum?.length ? { enum: p.enum } : {}),
                      },
                    ]),
                  ),
                  required: (t.parameters || []).filter((p) => p.required).map((p) => p.name),
                },
              });
            }
          }

          const filtered = dynamicTools.filter((t) => enabledSet.has(t.name));
          const googleFormats = convertToolsToGoogle(filtered);
          if (googleFormats) {
            tools.push(...googleFormats);
          }
        } catch (err) {
          logger.error(`[Live API] Error loading tools: ${err.message}`);
        }
      }

      // Build Live API config
      const liveConfig = {
        responseModalities: clientConfig.responseModalities || [Modality.AUDIO],
        // Always include a base system instruction with language hint to anchor
        // the input transcription model (which has no languageCode field)
        systemInstruction: clientConfig.systemInstruction
          ? `${clientConfig.systemInstruction}\n\nAlways respond in the same language the user speaks. The user's primary language is English.`
          : "Always respond in the same language the user speaks. The user's primary language is English.",
        ...(clientConfig.temperature !== undefined && {
          temperature: clientConfig.temperature,
        }),
        ...(clientConfig.thinkingConfig && {
          thinkingConfig: clientConfig.thinkingConfig,
        }),
        ...(tools.length > 0 && { tools }),
        // Voice Activity Detection — tuned for reliable speech capture
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
            prefixPaddingMs: 500,
            silenceDurationMs: 1500,
          },
        },
        // Voice config — explicit voice selection
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: clientConfig.voiceName || "Puck",
            },
          },
        },
        // Enable transcription for audio responses
        outputAudioTranscription: {},
        inputAudioTranscription: {},
      };
      activeConfig = liveConfig;

      try {
        const client = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
        liveSession = await client.live.connect({
          model,
          config: liveConfig,
          callbacks: {
            onopen: () => {
              logger.info(
                `[Live API] Session opened for ${model} (project: ${project}, user: ${username})`,
              );
              emit({ type: "setupComplete" });
            },
            onmessage: (msg) => {
              // Model turn parts (audio data, text, function calls)
              if (msg.serverContent?.modelTurn?.parts) {
                if (!passFirstTokenTime) passFirstTokenTime = performance.now();
                
                // First model turn message = user is done speaking.
                // Eagerly upload user audio and emit userAudioReady now,
                // so the audio card shows up before the model finishes.
                if (!userAudioUploading && userInputAudioChunks.length > 0) {
                  userAudioUploading = true;
                  buildAndUploadAudio(userInputAudioChunks, userInputSampleRate)
                    .then((userAudioRef) => {
                      if (userAudioRef) {
                        turnUserAudioRef = userAudioRef;
                        emit({ type: "userAudioReady", userAudioRef });
                      }
                    });
                }
                for (const part of msg.serverContent.modelTurn.parts) {
                  if (part.thought && part.text) {
                    emit({ type: "thinking", content: part.text });
                    turnThinking += part.text;
                  } else if (part.text) {
                    emit({ type: "text", text: part.text });
                    turnText += part.text;
                  } else if (part.inlineData) {
                    emit({
                      type: "audio",
                      data: part.inlineData.data,
                      mimeType: part.inlineData.mimeType,
                    });
                    // Accumulate for WAV building
                    if (part.inlineData.data) {
                      turnAudioChunks.push(part.inlineData.data);
                    }
                    if (part.inlineData.mimeType) {
                      const rateMatch =
                        part.inlineData.mimeType.match(/rate=(\d+)/);
                      if (rateMatch)
                        audioSampleRate = parseInt(rateMatch[1], 10);
                    }
                  } else if (part.functionCall) {
                    emit({
                      type: "toolCall",
                      functionCalls: [
                        {
                          id: `live-tc-${crypto.randomUUID()}`,
                          name: part.functionCall.name,
                          args: part.functionCall.args || {},
                        },
                      ],
                    });
                  }
                }
              }

              // Top-level tool calls
              if (msg.toolCall?.functionCalls) {
                const functionCalls = msg.toolCall.functionCalls.map((fc) => ({
                  id: fc.id || `live-tc-${crypto.randomUUID()}`,
                  name: fc.name,
                  args: fc.args || {},
                }));
                turnToolCalls.push(...functionCalls);

                // Emit calling status to the client
                for (const fc of functionCalls) {
                  emit({
                    type: "tool_execution",
                    tool: { name: fc.name, args: fc.args, id: fc.id },
                    status: "calling",
                  });
                }

                // Execute tools natively in Prism and return response to Gemini
                (async () => {
                  try {
                    const ToolOrchestratorService = (await import("../services/ToolOrchestratorService.js")).default;
                    const { truncateToolResult } = await import("../utils/FunctionCallingUtilities.js");
                    const MongoWrapper = (await import("../wrappers/MongoWrapper.js")).default;
                    const { MONGO_DB_NAME } = await import("../../secrets.js");

                    // Build merged tool map (custom + built-in) for execution
                    const customToolMap = new Map();
                    try {
                      const mClient = MongoWrapper.getClient(MONGO_DB_NAME);
                      if (mClient) {
                        const customToolsData = await mClient
                          .db(MONGO_DB_NAME)
                          .collection("custom_tools")
                          .find({ project, username, enabled: true })
                          .toArray();
                        for (const t of customToolsData) {
                          customToolMap.set(t.name, t);
                        }
                      }
                    } catch (e) {
                      logger.warn(`Failed to fetch custom tools for Live API loop: ${e.message}`);
                    }

                    const results = await Promise.all(
                      functionCalls.map(async (tc) => {
                        let result;
                        const customDef = customToolMap.get(tc.name);
                        if (customDef) {
                          result = await ToolOrchestratorService.executeCustomTool(customDef, tc.args);
                        } else {
                          result = await ToolOrchestratorService.executeTool(tc.name, tc.args);
                        }
                        return { id: tc.id, name: tc.name, result };
                      })
                    );

                    for (const res of results) {
                      emit({
                        type: "tool_execution",
                        tool: { name: res.name, id: res.id, result: res.result },
                        status: res.result?.error ? "error" : "done",
                      });
                    }

                    const functionResponses = results.map((r) => ({
                      id: r.id,
                      name: r.name,
                      response: truncateToolResult(r.result),
                    }));

                    liveSession.sendToolResponse({ functionResponses });
                  } catch (err) {
                    logger.error(`[Live API] Error executing tools: ${err.message}`);
                  }
                })();
              }

              // Transcriptions
              if (msg.serverContent?.inputTranscription?.text) {
                turnInputText += msg.serverContent.inputTranscription.text + "\n";
                emit({
                  type: "inputTranscription",
                  text: msg.serverContent.inputTranscription.text,
                });
              }
              if (msg.serverContent?.outputTranscription?.text) {
                const outText = msg.serverContent.outputTranscription.text;
                turnText += outText;
                emit({
                  type: "outputTranscription",
                  text: outText,
                });
              }

              // Usage metadata — accumulate per turn (must run BEFORE
              // turnComplete / interrupted checks because the final
              // usageMetadata arrives in the same message as those events)
              if (msg.usageMetadata) {
                turnUsage.inputTokens +=
                  msg.usageMetadata.promptTokenCount ?? 0;
                turnUsage.outputTokens +=
                  msg.usageMetadata.candidatesTokenCount ?? 0;
              }

              // Finalize usage: the Live API does not report
              // candidatesTokenCount for audio output, so we estimate
              // output tokens from accumulated PCM data.
              // Google tokenises audio at 32 tokens/second.
              function finalizeUsage() {
                if (turnUsage.outputTokens === 0 && turnAudioChunks.length > 0) {
                  const totalPcmBytes = turnAudioChunks.reduce(
                    (sum, b64) => sum + Buffer.from(b64, "base64").length,
                    0,
                  );
                  // 16-bit mono → 2 bytes per sample
                  const durationSeconds =
                    totalPcmBytes / (audioSampleRate * 2);
                  turnUsage.outputTokens = Math.ceil(
                    durationSeconds * 32,
                  );
                }
              }

              // Turn complete — build WAV + upload, then emit with audioRef and usage
              if (msg.serverContent?.turnComplete) {
                finalizeUsage();
                buildAndUploadAudio().then((audioRef) => {
                  const modelDef = getModelByName(model);
                  const estimatedCost = calculateLiveCost(
                    turnUsage,
                    modelDef?.pricing,
                  );
                  
                  const totalSec = (performance.now() - turnStart) / 1000;
                  const timeToGenerationSec = passFirstTokenTime ? (passFirstTokenTime - turnStart) / 1000 : null;
                  const generationSec = passFirstTokenTime ? totalSec - timeToGenerationSec : null;

                  RequestLogger.logChatGeneration({
                    requestId: `live-${crypto.randomUUID()}`,
                    endpoint: "live",
                    project,
                    username,
                    clientIp: _clientIp,
                    provider: "google",
                    model: activeModel,
                    conversationId: activeConversationId || null,
                    success: true,
                    usage: { ...turnUsage },
                    estimatedCost,
                    tokensPerSec: generationSec > 0 && turnUsage.outputTokens > 0 ? parseFloat((turnUsage.outputTokens / generationSec).toFixed(1)) : null,
                    timeToGenerationSec,
                    generationSec,
                    totalSec,
                    options: activeConfig,
                    messages: [{
                      role: "user",
                      content: turnInputText.trim() || "[Voice Input]",
                      ...(turnUserAudioRef ? { audio: [turnUserAudioRef], liveTranscription: true } : {})
                    }],
                    text: turnText,
                    thinking: turnThinking,
                    toolCalls: turnToolCalls,
                    outputCharacters: turnText.length,
                    ...(audioRef ? { audioRef } : {})
                  }).catch(err => logger.error(`[Live API] Failed to log request: ${err.message}`));

                  emit({
                    type: "turnComplete",
                    ...(audioRef ? { audioRef } : {}),
                    usage: { ...turnUsage },
                    ...(estimatedCost !== null ? { estimatedCost } : {}),
                  });
                  // Reset per-turn accumulators
                  turnAudioChunks = [];
                  userInputAudioChunks.length = 0;
                  userAudioUploading = false;
                  turnUsage = { inputTokens: 0, outputTokens: 0 };
                  
                  // Reset logger vars
                  turnStart = performance.now();
                  passFirstTokenTime = null;
                  turnText = "";
                  turnThinking = "";
                  turnToolCalls = [];
                  turnInputText = "";
                  turnUserAudioRef = null;
                });
                return; // Don't emit turnComplete synchronously
              }

              // Interrupted (model was cut off by user speech)
              if (msg.serverContent?.interrupted) {
                finalizeUsage();
                buildAndUploadAudio().then((audioRef) => {
                  const modelDef = getModelByName(model);
                  const estimatedCost = calculateLiveCost(
                    turnUsage,
                    modelDef?.pricing,
                  );
                  
                  const totalSec = (performance.now() - turnStart) / 1000;
                  const timeToGenerationSec = passFirstTokenTime ? (passFirstTokenTime - turnStart) / 1000 : null;
                  const generationSec = passFirstTokenTime ? totalSec - timeToGenerationSec : null;

                  RequestLogger.logChatGeneration({
                    requestId: `live-${crypto.randomUUID()}`,
                    endpoint: "live",
                    project,
                    username,
                    clientIp: _clientIp,
                    provider: "google",
                    model: activeModel,
                    conversationId: activeConversationId || null,
                    success: true,
                    usage: { ...turnUsage },
                    estimatedCost,
                    tokensPerSec: generationSec > 0 && turnUsage.outputTokens > 0 ? parseFloat((turnUsage.outputTokens / generationSec).toFixed(1)) : null,
                    timeToGenerationSec,
                    generationSec,
                    totalSec,
                    options: activeConfig,
                    messages: [{
                      role: "user",
                      content: turnInputText.trim() || "[Voice Input]",
                      ...(turnUserAudioRef ? { audio: [turnUserAudioRef], liveTranscription: true } : {})
                    }],
                    text: turnText,
                    thinking: turnThinking,
                    toolCalls: turnToolCalls,
                    outputCharacters: turnText.length,
                    ...(audioRef ? { audioRef } : {})
                  }).catch(err => logger.error(`[Live API] Failed to log interrupted request: ${err.message}`));

                  emit({
                    type: "interrupted",
                    ...(audioRef ? { audioRef } : {}),
                    usage: { ...turnUsage },
                    ...(estimatedCost !== null ? { estimatedCost } : {}),
                  });
                  turnAudioChunks = [];
                  userInputAudioChunks.length = 0;
                  userAudioUploading = false;
                  turnUsage = { inputTokens: 0, outputTokens: 0 };
                  
                  turnStart = performance.now();
                  passFirstTokenTime = null;
                  turnText = "";
                  turnThinking = "";
                  turnToolCalls = [];
                  turnInputText = "";
                  turnUserAudioRef = null;
                });
                return;
              }
            },
            onerror: (e) => {
              const errMsg =
                e?.error?.message || e?.message || "Live API error";
              logger.error(
                `[Live API] Error (${project}/${username}): ${errMsg}`,
              );
              emit({ type: "error", message: errMsg });
            },
            onclose: () => {
              logger.info(
                `[Live API] Session closed (project: ${project}, user: ${username})`,
              );
              liveSession = null;
              emit({ type: "sessionClosed" });
            },
          },
        });
      } catch (err) {
        logger.error(`[Live API] Failed to connect: ${err.message}`);
        emit({ type: "error", message: `Failed to connect: ${err.message}` });
      }
      return;
    }

    // ── All other messages require an active session ─────────────
    if (!liveSession) {
      emit({
        type: "error",
        message: "No active session. Send a 'setup' message first.",
      });
      return;
    }

    // ── Audio input ─────────────────────────────────────────────
    if (type === "audio") {
      // Accumulate user's mic audio for WAV upload at turn end
      if (data.data) {
        userInputAudioChunks.push(data.data);
      }
      liveSession.sendRealtimeInput({
        audio: {
          data: data.data,
          mimeType: data.mimeType || "audio/pcm;rate=16000",
        },
      });
      return;
    }

    // ── Audio stream end (mic stopped — flush server-side cache) ──
    if (type === "audioStreamEnd") {
      liveSession.sendRealtimeInput({ audioStreamEnd: true });
      return;
    }

    // ── Text input ──────────────────────────────────────────────
    if (type === "text") {
      turnInputText += data.text + "\n";
      liveSession.sendRealtimeInput({ text: data.text });
      return;
    }

    // ── Tool response ───────────────────────────────────────────
    if (type === "toolResponse") {
      liveSession.sendToolResponse({
        functionResponses: data.responses,
      });
      return;
    }

    // ── Close session ───────────────────────────────────────────
    if (type === "close") {
      try {
        liveSession.close();
      } catch {
        /* ignore */
      }
      liveSession = null;
      return;
    }
  });

  // Clean up on client disconnect
  ws.on("close", () => {
    if (liveSession) {
      try {
        liveSession.close();
      } catch {
        /* ignore */
      }
      liveSession = null;
    }
    logger.info(
      `[Live API] Client disconnected (project: ${project}, user: ${username})`,
    );
  });
}

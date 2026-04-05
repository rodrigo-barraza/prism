import ToolOrchestratorService from "./ToolOrchestratorService.js";
import { expandMessagesForFC, truncateToolResult } from "../utils/FunctionCallingUtilities.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";
import ConversationService from "./ConversationService.js";
import FileService from "./FileService.js";
import { finalizeTextGeneration } from "../routes/chat.js";
import RequestLogger from "./RequestLogger.js";
import { TYPES, getPricing } from "../config.js";
import { calculateTextCost } from "../utils/CostCalculator.js";

const MAX_TOOL_ITERATIONS = 10;

/**
 * Executes a fully managed agentic loop server-side.
 * Instead of relying on the client to re-prompt the model after tool execution,
 * Prism intercepts tool calls, routes them to `tools-api` or custom endpoints,
 * appends the results to the context context, and automatically re-prompts the model.
 */
export default class AgenticLoopService {
  static async runAgenticLoop(ctx) {
    const {
      provider,
      providerName,
      resolvedModel,
      modelDef,
      messages,
      options,
      conversationId,
      project,
      username,
      requestStart,
      emit,
      signal,
    } = ctx;
    // Load built-in schemas
    const builtInTools = ToolOrchestratorService.getToolSchemas();

    // Load custom tools from MongoDB
    let customToolsData = [];
    try {
      const client = MongoWrapper.getClient(MONGO_DB_NAME);
      if (client) {
        customToolsData = await client
          .db(MONGO_DB_NAME)
          .collection("custom_tools")
          .find({ project, username, enabled: true })
          .toArray();
      }
    } catch (err) {
      logger.warn(`Failed to fetch custom tools for loop: ${err.message}`);
    }

    // Build the dynamic tool map
    const customToolMap = new Map();
    const dynamicTools = [...builtInTools];
    
    for (const t of customToolsData) {
      customToolMap.set(t.name, t);
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

    // If options.enabledTools is passed, filter out any tool not in the array
    let finalTools = dynamicTools;
    if (options.enabledTools && Array.isArray(options.enabledTools)) {
      const enabledSet = new Set(options.enabledTools);
      finalTools = finalTools.filter((t) => enabledSet.has(t.name));
    }

    // If the model is local (e.g. LM Studio / vLLM / Ollama), we only feed it tools for the first pass
    // to force an eventual text response and avoid infinite loops.
    const isLocalProvider = providerName === "lm-studio" || providerName === "vllm" || providerName === "ollama";
    let hasCalledTools = false;

    let iterations = 0;
    let currentMessages = [...messages];

    const overallUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    let overallFirstTokenTime = null;
    let overallGenerationEnd = null;
    let overallOutputCharacters = 0;
    let finalStreamedText = "";
    let streamedThinking = "";
    const streamedImages = [];
    const streamedToolCalls = [];
    const streamedAudioChunks = [];
    let audioSampleRate = 24000;

    // Mark conversation as generating
    if (conversationId) {
      ConversationService.setGenerating(conversationId, project, username, true).catch((err) =>
        logger.error(`Failed to set isGenerating: ${err.message}`)
      );
    }

    try {
      while (iterations < MAX_TOOL_ITERATIONS) {
        iterations++;
        
        let passStreamedText = "";
        let passStreamedThinking = "";
        const passPendingToolCalls = [];
        const passStart = performance.now();
        let passFirstTokenTime = null;
        let passGenerationEnd = null;
        let passOutputCharacters = 0;
        const passUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

        const passOptions = { ...options };      if (isLocalProvider && hasCalledTools) {
          delete passOptions.tools;
        } else {
          passOptions.tools = finalTools;
        }

        const expandedMessages = expandMessagesForFC(currentMessages, { filterDeleted: false });

        // Build the stream!
        const stream =
          modelDef?.liveAPI && provider.generateTextStreamLive
            ? provider.generateTextStreamLive(expandedMessages, resolvedModel, { ...passOptions, signal })
            : provider.generateTextStream(expandedMessages, resolvedModel, { ...passOptions, signal });

        for await (const chunk of stream) {
          if (signal?.aborted) {
            if (typeof stream.return === "function") stream.return();
            break;
          }
          
          if (chunk && typeof chunk === "object" && chunk.type === "usage") {
            overallUsage.inputTokens += chunk.usage.inputTokens || 0;
            overallUsage.outputTokens += chunk.usage.outputTokens || 0;
            overallUsage.cacheReadInputTokens += chunk.usage.cacheReadInputTokens || 0;
            overallUsage.cacheCreationInputTokens += chunk.usage.cacheCreationInputTokens || 0;
            
            passUsage.inputTokens += chunk.usage.inputTokens || 0;
            passUsage.outputTokens += chunk.usage.outputTokens || 0;
            passUsage.cacheReadInputTokens += chunk.usage.cacheReadInputTokens || 0;
            passUsage.cacheCreationInputTokens += chunk.usage.cacheCreationInputTokens || 0;
            continue;
          }

          if (chunk && typeof chunk === "object" && chunk.type === "thinking") {
            overallGenerationEnd = performance.now();
            passGenerationEnd = performance.now();
            streamedThinking += chunk.content;
            passStreamedThinking += chunk.content;
            emit({ type: "thinking", content: chunk.content });
            continue;
          }

          if (chunk && typeof chunk === "object" && chunk.type === "toolCall") {
            // Native MCP tool calls (e.g. LM Studio): already executed by provider,
            // pass through directly as toolCall events — do NOT re-execute.
            if (chunk.native) {
              // Track for finalization but don't add to pending execution queue
              if (chunk.status === "calling") {
                streamedToolCalls.push({
                  id: chunk.id || null,
                  name: chunk.name,
                  args: chunk.args || {},
                });
              } else if (chunk.status === "done" || chunk.status === "error") {
                // Update existing entry with result
                const existing = streamedToolCalls.find(
                  (tc) => (chunk.id && tc.id === chunk.id) || (!chunk.id && tc.name === chunk.name),
                );
                if (existing) {
                  existing.result = chunk.result;
                  existing.status = chunk.status;
                  if (chunk.args && Object.keys(chunk.args).length > 0) {
                    existing.args = chunk.args;
                  }
                }
              }
              emit({
                type: "toolCall",
                id: chunk.id || null,
                name: chunk.name,
                args: chunk.args || {},
                result: chunk.result || undefined,
                status: chunk.status || "calling",
              });
              continue;
            }

            passPendingToolCalls.push({
              id: chunk.id || null,
              name: chunk.name,
              args: chunk.args || {},
              thoughtSignature: chunk.thoughtSignature || undefined,
            });
            streamedToolCalls.push({
              id: chunk.id || null,
              name: chunk.name,
              args: chunk.args || {},
              thoughtSignature: chunk.thoughtSignature || undefined,
            });
            emit({
              type: "tool_execution",
              tool: { name: chunk.name, args: chunk.args || {}, id: chunk.id },
              status: "calling",
            });
            continue;
          }

          if (chunk && typeof chunk === "object" && chunk.type === "image") {
              let minioRef = null;
              if (chunk.data) {
                  try {
                  const mimeType = chunk.mimeType || "image/png";
                  const dataUrl = `data:${mimeType};base64,${chunk.data}`;
                  const { ref } = await FileService.uploadFile(dataUrl, "generations", project, username);
                  minioRef = ref;
                  } catch (err) {
                      logger.error(`MinIO upload failed: ${err.message}`);
                  }
                  streamedImages.push(minioRef || `data:${chunk.mimeType || "image/png"};base64,${chunk.data}`);
              }
              emit({ type: "image", ...(minioRef ? {} : { data: chunk.data }), mimeType: chunk.mimeType, minioRef });
              continue;
          }

          if (chunk && typeof chunk === "object" && chunk.type === "executableCode") {
              emit({ type: "executableCode", code: chunk.code, language: chunk.language });
              continue;
          }
          if (chunk && typeof chunk === "object" && chunk.type === "codeExecutionResult") {
              emit({ type: "codeExecutionResult", output: chunk.output, outcome: chunk.outcome });
              continue;
          }
          if (chunk && typeof chunk === "object" && chunk.type === "webSearchResult") {
              emit({ type: "webSearchResult", results: chunk.results });
              continue;
          }
          if (chunk && typeof chunk === "object" && chunk.type === "audio") {
              emit({ type: "audio", data: chunk.data, mimeType: chunk.mimeType });
              if (chunk.data) streamedAudioChunks.push(chunk.data);
              if (chunk.mimeType) {
                  const rateMatch = chunk.mimeType.match(/rate=(\d+)/);
                  if (rateMatch) audioSampleRate = parseInt(rateMatch[1], 10);
              }
              continue;
          }
          if (chunk && typeof chunk === "object" && chunk.type === "status") {
              emit({ type: "status", message: chunk.message });
              continue;
          }

          // Text chunk
          if (!overallFirstTokenTime) {
            overallFirstTokenTime = performance.now();
          }
          if (!passFirstTokenTime) {
            passFirstTokenTime = performance.now();
          }
          overallGenerationEnd = performance.now();
          passGenerationEnd = performance.now();
          const chunkStr = typeof chunk === "string" ? chunk : "";
          overallOutputCharacters += chunkStr.length;
          passOutputCharacters += chunkStr.length;
          finalStreamedText = passStreamedText + chunkStr;
          passStreamedText += chunkStr;
          emit({ type: "chunk", content: chunk });
        }

        if (signal?.aborted) break;

        // Log the intermediate request
        const passGenerationSec = passFirstTokenTime && passGenerationEnd ? (passGenerationEnd - passFirstTokenTime) / 1000 : null;
        const passTotalSec = (performance.now() - passStart) / 1000;
        const passTokensPerSec = passGenerationSec > 0 && passUsage.outputTokens > 0 ? parseFloat((passUsage.outputTokens / passGenerationSec).toFixed(1)) : null;
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
        const passEstimatedCost = calculateTextCost(passUsage, pricing);

        RequestLogger.logChatGeneration({
          requestId: `${ctx.requestId}-${iterations}`,
          endpoint: modelDef?.liveAPI ? "live" : "chat",
          project,
          username,
          clientIp: ctx.clientIp,
          provider: providerName,
          model: resolvedModel,
          conversationId,
          sessionId: ctx.sessionId || null,
          success: true,
          usage: passUsage,
          estimatedCost: passEstimatedCost,
          tokensPerSec: passTokensPerSec,
          timeToGenerationSec: passFirstTokenTime ? (passFirstTokenTime - passStart) / 1000 : null,
          generationSec: passGenerationSec,
          totalSec: passTotalSec,
          options: passOptions,
          messages: currentMessages.slice(-2),
          text: passStreamedText,
          thinking: passStreamedThinking,
          toolCalls: passPendingToolCalls,
          outputCharacters: passOutputCharacters,
          agenticIteration: iterations,
        }).catch(err => logger.error(`[AgenticLoopService] Failed to log intermediate request: ${err.message}`));

        // If the LLM returned tool calls, we execute them and loop
        if (passPendingToolCalls.length > 0) {
          hasCalledTools = true;

          // Execute tools in parallel — use streaming for supported tools
          const results = await Promise.all(
            passPendingToolCalls.map(async (tc) => {
               const customDef = customToolMap.get(tc.name);
               if (customDef) {
                   return { name: tc.name, id: tc.id, result: await ToolOrchestratorService.executeCustomTool(customDef, tc.args) };
               }

               // Streamable tools (shell, python, js) — emit real-time output chunks
               if (ToolOrchestratorService.isStreamable(tc.name)) {
                   const result = await ToolOrchestratorService.executeToolStreaming(tc.name, tc.args, (event, data, meta) => {
                       emit({
                           type: "tool_output",
                           toolCallId: tc.id,
                           name: tc.name,
                           event,
                           data: data || undefined,
                           meta: meta || undefined,
                       });
                   });
                   return { name: tc.name, id: tc.id, result };
               }

               return { name: tc.name, id: tc.id, result: await ToolOrchestratorService.executeTool(tc.name, tc.args) };
            })
          );

          // Emit done events for UI
          for (const tc of passPendingToolCalls) {
              const res = results.find(r => r.id === tc.id || (!r.id && r.name === tc.name));
              emit({
                  type: "tool_execution",
                  tool: { name: tc.name, args: tc.args || {}, id: tc.id, result: res?.result },
                  status: res?.result?.error ? "error" : "done",
              });
          }

          // Append to context for next pass
          const assistantMsg = {
             role: "assistant",
             content: passStreamedText || "",
             toolCalls: passPendingToolCalls.map((tc) => {
                 const match = results.find((r) => r.id === tc.id);
                 return {
                     id: tc.id || null,
                     name: tc.name,
                     args: tc.args,
                     thoughtSignature: tc.thoughtSignature || undefined,
                     result: match ? match.result : null
                 };
             })
          };
          currentMessages.push(assistantMsg);

          for (const res of results) {
              currentMessages.push({
                  role: "tool",
                  name: res.name,
                  tool_call_id: res.id,
                  content: JSON.stringify(truncateToolResult(res.result)),
              });
          }

          // Clean up empty assistant text content nodes
          currentMessages = currentMessages.filter((m) => !(m.role === "assistant" && !m.content?.trim() && (!m.toolCalls || m.toolCalls.length === 0)));

          // Run the next iteration
          continue;
        }

        // If text was returned without new tools, we're done
        if (passStreamedText) {
           break;
        }
      }

      const now = performance.now();
      
      // We construct the modified context that finalizes and commits the DB
      // However, since we bypassed handleStreamingText entirely, we must manually finalize
      // We can just call finalizeTextGeneration and pass the collected metrics!

      overallUsage.requests = iterations;

      await finalizeTextGeneration(ctx, {
          text: finalStreamedText,
          thinking: streamedThinking,
          images: streamedImages,
          toolCalls: streamedToolCalls,
          audioChunks: streamedAudioChunks,
          audioSampleRate,
          usage: overallUsage,
          outputCharacters: overallOutputCharacters,
          timeToGenerationSec: overallFirstTokenTime ? (overallFirstTokenTime - requestStart) / 1000 : null,
          generationSec: overallFirstTokenTime && overallGenerationEnd ? (overallGenerationEnd - overallFirstTokenTime) / 1000 : null,
          totalSec: (now - requestStart) / 1000,
      }, currentMessages, true); // <--- pass true to skip the overall request logging so we don't duplicate
    } catch (err) {
      // Clear generating flag so the conversation doesn't stay stuck
      if (conversationId) {
        ConversationService.setGenerating(conversationId, project, username, false).catch((e) =>
          logger.error(`Failed to clear isGenerating in agentic loop: ${e.message}`)
        );
      }
      throw err; // Re-throw so handleChat's catch handler can log + emit the error event
    }
  }
}

import ToolOrchestratorService from "./ToolOrchestratorService.js";
import { expandMessagesForFC, truncateToolResult as _truncateToolResult } from "../utils/FunctionCallingUtilities.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";
import ConversationService from "./ConversationService.js";
import FileService from "./FileService.js";
import { finalizeTextGeneration } from "../routes/chat.js";
import RequestLogger from "./RequestLogger.js";
import { TYPES, getPricing } from "../config.js";
import { calculateTextCost } from "../utils/CostCalculator.js";
import { calculateTokensPerSec } from "../utils/math.js";
import ContextWindowManager from "../utils/ContextWindowManager.js";
import AgentHooks from "./AgentHooks.js";
import AutoApprovalEngine from "./AutoApprovalEngine.js";
import SystemPromptAssembler from "./SystemPromptAssembler.js";
import AgentPersonaRegistry from "./AgentPersonaRegistry.js";
import PlanningModeService from "./PlanningModeService.js";
import SessionSummarizer from "./SessionSummarizer.js";

const MAX_TOOL_ITERATIONS = 25;
const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

// ── Approval Resolver Registry ─────────────────────────────
// Stores pending { resolve, type } objects keyed by conversationId.
// The HTTP endpoint resolves these when the client sends approval.
const pendingApprovals = new Map();

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
      sessionId,
      project,
      username,
      agent,
      requestStart,
      emit,
      signal,
    } = ctx;
    // Load tool schemas from tools-api (all tools including creative tools
    // like generate_image are served as HTTP endpoints by tools-api)
    const toolsApiSchemas = ToolOrchestratorService.getToolSchemas();

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
    const dynamicTools = [...toolsApiSchemas];
    
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

    // Merge MCP tools from connected servers
    const mcpTools = ToolOrchestratorService.getMCPToolSchemas();
    if (mcpTools.length > 0) {
      // Strip internal metadata before passing to LLM
      for (const t of mcpTools) {
        const { _mcpServer, _mcpOriginalName, ...schema } = t;
        dynamicTools.push(schema);
      }
      logger.info(`[AgenticLoop] Merged ${mcpTools.length} MCP tools from connected servers`);
    }

    // If options.enabledTools is passed, filter out any tool not in the array.
    // If none are passed, fall back to the persona's enabledTools (if any).
    // MCP tools (mcp__*) are always included — managed by connect/disconnect
    let resolvedEnabledTools = options.enabledTools;
    if (!resolvedEnabledTools && agent) {
      const persona = AgentPersonaRegistry.get(agent);
      if (persona?.enabledTools) {
        resolvedEnabledTools = persona.enabledTools;
        logger.info(`[AgenticLoop] Using persona "${agent}" enabledTools: [${resolvedEnabledTools.join(", ")}]`);
      }
    }

    let finalTools = dynamicTools;
    if (resolvedEnabledTools && Array.isArray(resolvedEnabledTools)) {
      const enabledSet = new Set(resolvedEnabledTools);
      finalTools = finalTools.filter((t) => enabledSet.has(t.name) || t.name.startsWith("mcp__"));
    }

    // ── Native tool collision prevention ────────────────────────
    // When the provider's native web search is active (e.g. OpenAI's
    // web_search, Anthropic's web_search_20260209, Google's googleSearch),
    // remove our custom web_search function to avoid namespace collisions.
    // Centralized here so ALL providers — current and future — get a
    // clean tools array without per-provider deduplication logic.
    if (options.webSearch) {
      finalTools = finalTools.filter((t) => t.name !== "web_search");
    }

    // When the model natively outputs images (e.g. GPT Image 1.5,
    // Gemini 3 Pro Image), remove the generate_image tool — the model
    // can generate images inline without a round-trip through tools-api.
    if (modelDef?.outputTypes?.includes(TYPES.IMAGE)) {
      finalTools = finalTools.filter((t) => t.name !== "generate_image");
    }

    // When the model has native vision (inputTypes includes IMAGE),
    // remove describe_image — the model can already see images in the
    // conversation context without needing to call an external tool.
    if (modelDef?.inputTypes?.includes(TYPES.IMAGE)) {
      finalTools = finalTools.filter((t) => t.name !== "describe_image");
    }

    // If the model is local (e.g. LM Studio / vLLM / Ollama), we only feed it tools for the first pass
    // to force an eventual text response and avoid infinite loops.
    const isLocalProvider = providerName === "lm-studio" || providerName === "vllm" || providerName === "ollama";
    let hasCalledTools = false;

    // Resolve max iterations from client or fall back to the module constant.
    // 0 = unlimited (∞ mode from the frontend), positive values clamped 1–100,
    // undefined/null = default constant (25).
    const clientMax = options.maxIterations;
    const resolvedMaxIterations = clientMax === 0
      ? Infinity
      : clientMax
        ? Math.min(100, Math.max(1, clientMax))
        : MAX_TOOL_ITERATIONS;

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
    let lastRateLimits = null;

    // ── Initialize lifecycle hooks ──────────────────────────────
    const hooks = new AgentHooks();

    // Auto-Approval Engine
    const approvalEngine = new AutoApprovalEngine({
      fullAuto: options.autoApprove === true,
    });
    hooks.register("beforeToolCall", approvalEngine.createHook(), "AutoApprovalEngine");

    // Dynamic System Prompt Assembly
    // Always active — the assembler loads the correct persona via AgentPersonaRegistry
    // based on ctx.agent (e.g. "CODING", "LUPOS"). Callers no longer bypass this.
    const assembler = new SystemPromptAssembler();
    hooks.register("beforePrompt", assembler.createHook(), "SystemPromptAssembler");

    // Session Summarization (fire-and-forget on loop exit)
    hooks.register("afterResponse", SessionSummarizer.createHook(), "SessionSummarizer");

    // ── Planning Mode ─────────────────────────────────────────
    if (options.planFirst) {
      const { planningMessages, planningOptions } = PlanningModeService.preparePlanningPass(
        { messages: currentMessages },
        options,
      );

      // Run system prompt assembly on planning pass too
      await hooks.run("beforePrompt", {
        messages: planningMessages,
        project,
        username,
        agent,
        sessionId,
        agentContext: options.agentContext,
        enabledTools: resolvedEnabledTools,
      });

      // Generate plan (single non-looping LLM call)
      const expandedPlanMsgs = expandMessagesForFC(planningMessages, { filterDeleted: false });
      let planText = "";

      const planStream = modelDef?.liveAPI && provider.generateTextStreamLive
        ? provider.generateTextStreamLive(expandedPlanMsgs, resolvedModel, { ...planningOptions, signal })
        : provider.generateTextStream(expandedPlanMsgs, resolvedModel, { ...planningOptions, signal });

      for await (const chunk of planStream) {
        if (signal?.aborted) break;
        if (chunk && typeof chunk === "object" && chunk.type === "thinking") {
          emit({ type: "thinking", content: chunk.content });
          continue;
        }
        const chunkStr = typeof chunk === "string" ? chunk : "";
        planText += chunkStr;
        emit({ type: "chunk", content: chunkStr });
      }

      // Emit plan for approval
      emit({
        type: "plan_proposal",
        plan: planText,
        steps: PlanningModeService.extractSteps(planText),
      });

      // Wait for approval via a Promise that resolves when client responds
      const approved = await new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
          pendingApprovals.delete(conversationId);
          resolve(false); // Default: reject on timeout (safe)
        }, 120_000);
        pendingApprovals.set(conversationId, {
          resolve: (val) => {
            clearTimeout(timeoutId);
            pendingApprovals.delete(conversationId);
            resolve(val);
          },
          type: "plan",
        });
      });

      if (!approved || signal?.aborted) {
        emit({ type: "status", message: "Plan rejected — execution cancelled." });
        emit({ type: "done", usage: overallUsage, totalTime: (performance.now() - requestStart) / 1000 });
        return;
      }

      // Inject approved plan into messages for execution
      currentMessages = PlanningModeService.buildExecutionMessages(currentMessages, planText);
      emit({ type: "status", message: "Plan approved — executing..." });
    }

    // Mark conversation as generating
    if (conversationId) {
      ConversationService.setGenerating(conversationId, project, username, true).catch((err) =>
        logger.error(`Failed to set isGenerating: ${err.message}`)
      );
    }

    // Track consecutive errors per tool name for retry budgeting
    const toolErrorCounts = new Map();

    try {
      while (iterations < resolvedMaxIterations) {
        iterations++;

        // ── Emit iteration progress ──────────────────────────
        emit({ type: "status", message: `iteration_progress`, iteration: iterations, maxIterations: resolvedMaxIterations });

        // ── beforePrompt hook: inject dynamic context ─────────
        if (iterations === 1) {
          const hookCtx = {
            messages: currentMessages,
            project,
            username,
            agent,
            sessionId,
            agentContext: options.agentContext,
            enabledTools: resolvedEnabledTools,
          };
          await hooks.run("beforePrompt", hookCtx);

          // Emit which skills were injected (set by SystemPromptAssembler)
          if (hookCtx._injectedSkills?.length > 0) {
            emit({
              type: "status",
              message: "skills_injected",
              skills: hookCtx._injectedSkills,
            });
          }
        }
        
        let passStreamedText = "";
        let passStreamedThinking = "";
        let passThinkingSignature = "";
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

        // ── Context window enforcement ─────────────────────────
        // Enforce token budget before expanding messages. This prevents
        // context overflow as tool results accumulate across iterations.
        const contextResult = ContextWindowManager.enforce(currentMessages, {
          maxInputTokens: modelDef?.maxInputTokens || 128_000,
          maxOutputTokens: options.maxTokens || 8192,
          toolCount: finalTools.length,
        });
        if (contextResult.truncated) {
          currentMessages = contextResult.messages;
          emit({
            type: "status",
            message: "context_truncated",
            strategy: contextResult.strategy,
            estimatedTokens: contextResult.estimatedTokens,
          });
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

          // Rate limit headers from the provider response
          if (chunk && typeof chunk === "object" && chunk.type === "rateLimits") {
            lastRateLimits = chunk.rateLimits;
            continue;
          }

          if (chunk && typeof chunk === "object" && chunk.type === "thinking") {
            if (!overallFirstTokenTime) overallFirstTokenTime = performance.now();
            if (!passFirstTokenTime) passFirstTokenTime = performance.now();
            overallGenerationEnd = performance.now();
            passGenerationEnd = performance.now();
            streamedThinking += chunk.content;
            passStreamedThinking += chunk.content;
            emit({ type: "thinking", content: chunk.content });
            continue;
          }

          // Thinking signature — Anthropic's cryptographic signature for thinking
          // blocks. Must be captured and passed back verbatim for multi-turn
          // tool use conversations to avoid API 400 errors.
          if (chunk && typeof chunk === "object" && chunk.type === "thinking_signature") {
            passThinkingSignature = chunk.signature;
            continue;
          }

          if (chunk && typeof chunk === "object" && chunk.type === "toolCall") {
            // Tool call chunks indicate model output — track generation timing
            if (!overallFirstTokenTime) overallFirstTokenTime = performance.now();
            if (!passFirstTokenTime) passFirstTokenTime = performance.now();
            overallGenerationEnd = performance.now();
            passGenerationEnd = performance.now();

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
              responsesItemId: chunk.responsesItemId || undefined,
              name: chunk.name,
              args: chunk.args || {},
              thoughtSignature: chunk.thoughtSignature || undefined,
            });
            streamedToolCalls.push({
              id: chunk.id || null,
              responsesItemId: chunk.responsesItemId || undefined,
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
          emit({ type: "chunk", content: chunkStr });
        }

        if (signal?.aborted) break;

        // Log the intermediate request
        const passGenerationSec = passFirstTokenTime && passGenerationEnd ? (passGenerationEnd - passFirstTokenTime) / 1000 : null;
        const passTotalSec = (performance.now() - passStart) / 1000;
        const passTokensPerSec = calculateTokensPerSec(passUsage.outputTokens, passGenerationSec);
        const pricing = getPricing(TYPES.TEXT, TYPES.TEXT)[resolvedModel];
        const passEstimatedCost = calculateTextCost(passUsage, pricing);

        RequestLogger.logChatGeneration({
          requestId: `${ctx.requestId}-${iterations}`,
          endpoint: "/agent",
          operation: "agent:iteration",
          project,
          username,
          clientIp: ctx.clientIp,
          agent: agent || null,
          provider: providerName,
          model: resolvedModel,
          conversationId,
          sessionId: sessionId || null,
          success: true,
          usage: passUsage,
          estimatedCost: passEstimatedCost,
          tokensPerSec: passTokensPerSec,
          timeToGenerationSec: passFirstTokenTime ? (passFirstTokenTime - passStart) / 1000 : null,
          generationSec: passGenerationSec,
          totalSec: passTotalSec,
          options: passOptions,
          messages: currentMessages,
          text: passStreamedText,
          thinking: passStreamedThinking,
          toolCalls: passPendingToolCalls,
          outputCharacters: passOutputCharacters,
          agenticIteration: iterations,
        }).catch(err => logger.error(`[AgenticLoopService] Failed to log intermediate request: ${err.message}`));

        // If the LLM returned tool calls, we execute them and loop
        if (passPendingToolCalls.length > 0) {
          hasCalledTools = true;

          // ── beforeToolCall hook: auto-approval gating ──────
          const { autoApproved: _autoApproved, needsApproval } = approvalEngine.checkBatch(passPendingToolCalls);

          // If tools need approval, emit event and wait
          if (needsApproval.length > 0 && !options.autoApprove) {
            for (const tc of needsApproval) {
              emit({
                type: "approval_required",
                toolCall: { name: tc.name, args: tc.args, id: tc.id },
                tier: tc._approval.tier,
                tierLabel: tc._approval.tierLabel,
              });
            }

            // Wait for approval responses via the registry
            const approvalResult = await new Promise((resolve) => {
              const timeoutId = setTimeout(() => {
                pendingApprovals.delete(conversationId);
                resolve({ approved: false, reason: "timeout" });
              }, 120_000);
              pendingApprovals.set(conversationId, {
                resolve: (val) => {
                  clearTimeout(timeoutId);
                  pendingApprovals.delete(conversationId);
                  resolve(val);
                },
                type: "tool",
                tools: needsApproval.map((t) => t.name),
              });
            });

            if (!approvalResult?.approved) {
              // User rejected — skip these tool calls and break
              emit({ type: "status", message: `Tool execution rejected: ${needsApproval.map((t) => t.name).join(", ")}` });
              break;
            }

            // "Approve All" — user opted in to auto-approve for the rest of this session
            if (approvalResult.approveAll) {
              options.autoApprove = true;
            }
          }

          // Execute tools in parallel — use streaming for supported tools
          const results = await Promise.all(
            passPendingToolCalls.map(async (tc) => {
               // Run beforeToolCall hook (for logging/tracking)
               await hooks.run("beforeToolCall", tc, ctx);

               const customDef = customToolMap.get(tc.name);
               if (customDef) {
                   const result = await ToolOrchestratorService.executeCustomTool(customDef, tc.args);
                   await hooks.run("afterToolCall", tc, result, ctx);
                   return { name: tc.name, id: tc.id, result };
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
                   }, { project, username, agent, requestId: ctx.requestId, conversationId, iteration: iterations });
                   await hooks.run("afterToolCall", tc, result, ctx);
                   return { name: tc.name, id: tc.id, result };
               }

               // All tools route through executeTool — the orchestrator
               // dispatches to tools-api via HTTP.
               const result = await ToolOrchestratorService.executeTool(tc.name, tc.args, {
                 messages: currentMessages,
                 project,
                 username,
                 agent: agent || null,
                 sessionId: sessionId || null,
                 conversationId,
                 clientIp: ctx.clientIp || null,
                 requestId: ctx.requestId,
                 agenticIteration: iterations,
                 iteration: iterations,
               });
               await hooks.run("afterToolCall", tc, result, ctx);
               return { name: tc.name, id: tc.id, result };
            })
          );

          // Emit done events for UI + track error budgets
          for (const tc of passPendingToolCalls) {
              const res = results.find(r => r.id === tc.id || (!r.id && r.name === tc.name));
              const hasError = !!res?.result?.error;
              emit({
                  type: "tool_execution",
                  tool: { name: tc.name, args: tc.args || {}, id: tc.id, responsesItemId: tc.responsesItemId, result: res?.result },
                  status: hasError ? "error" : "done",
              });

              // Promote browser screenshots into streamedImages so they persist
              // into the conversation's images[] array and appear in /admin/media
              if (res?.result?.screenshotRef) {
                streamedImages.push(res.result.screenshotRef);
              }

              // Handle generate_image results — emit image event
              // and track in streamedImages, then strip heavy data from context
              if (res?.result?.image?.data) {
                const img = res.result.image;
                streamedImages.push(img.minioRef || `data:${img.mimeType};base64,${img.data}`);
                emit({
                  type: "image",
                  data: img.data,
                  mimeType: img.mimeType,
                  minioRef: img.minioRef,
                });
                // Strip heavy image data from the tool result before it enters
                // the LLM context — only keep the metadata
                delete res.result.image;
              }

              // Track consecutive errors per tool for retry budgeting
              if (hasError) {
                const count = (toolErrorCounts.get(tc.name) || 0) + 1;
                toolErrorCounts.set(tc.name, count);
                if (count >= MAX_CONSECUTIVE_TOOL_ERRORS) {
                  logger.warn(`[AgenticLoop] Tool "${tc.name}" hit error limit (${count}), skipping in future iterations`);
                  emit({ type: "status", message: `Tool "${tc.name}" failed ${count} times consecutively — skipping` });
                }
              } else {
                toolErrorCounts.delete(tc.name); // Reset on success
              }
          }

          // Append to context for next pass
          const assistantMsg = {
             role: "assistant",
             content: passStreamedText || "",
             // Preserve thinking for multi-step reasoning continuity
             ...(passStreamedThinking && { thinking: passStreamedThinking }),
             // Preserve the Anthropic thinking signature for API round-trip
             ...(passThinkingSignature && { thinkingSignature: passThinkingSignature }),
             toolCalls: passPendingToolCalls.map((tc) => {
                 const match = results.find((r) => r.id === tc.id);
                 return {
                     id: tc.id || null,
                     responsesItemId: tc.responsesItemId || undefined,
                     name: tc.name,
                     args: tc.args,
                     thoughtSignature: tc.thoughtSignature || undefined,
                     result: match ? match.result : null
                 };
             })
          };
          currentMessages.push(assistantMsg);

          // NOTE: We do NOT push standalone role:"tool" messages here.
          // The assistant message above already embeds results in toolCalls[].result,
          // and expandMessagesForFC() expands them into the [assistant, tool, tool, ...]
          // format required by providers. Pushing standalone tool messages here would
          // create duplicates — OpenAI strictly rejects orphaned tool messages with:
          // "messages with role 'tool' must be a response to a preceding message with 'tool_calls'"

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

      // ── Exhaustion Recovery Pass ──────────────────────────────
      // If we exited the loop by hitting MAX_TOOL_ITERATIONS (i.e. the
      // model was still calling tools), run one final tool-free pass so
      // the model can summarize what it accomplished rather than leaving
      // the user with a silent, mid-task cutoff.
      if (iterations >= resolvedMaxIterations && !finalStreamedText?.trim()) {
        emit({ type: "status", message: "iteration_limit_reached" });

        currentMessages.push({
          role: "user",
          content: [
            "[SYSTEM] You have reached the maximum number of tool-call iterations for this turn.",
            "Summarize the progress you have made so far, report any partial results,",
            "and clearly state what remains to be done so the user knows where things stand.",
          ].join(" "),
        });

        const exhaustionOptions = { ...options, tools: undefined };
        delete exhaustionOptions.tools;
        // Context enforcement for exhaustion pass too
        const exhaustionCtx = ContextWindowManager.enforce(currentMessages, {
          maxInputTokens: modelDef?.maxInputTokens || 128_000,
          maxOutputTokens: options.maxTokens || 8192,
          toolCount: 0,
        });
        if (exhaustionCtx.truncated) {
          currentMessages = exhaustionCtx.messages;
        }
        const expandedExhaustionMsgs = expandMessagesForFC(currentMessages, { filterDeleted: false });

        const exhaustionStream =
          modelDef?.liveAPI && provider.generateTextStreamLive
            ? provider.generateTextStreamLive(expandedExhaustionMsgs, resolvedModel, { ...exhaustionOptions, signal })
            : provider.generateTextStream(expandedExhaustionMsgs, resolvedModel, { ...exhaustionOptions, signal });

        for await (const chunk of exhaustionStream) {
          if (signal?.aborted) break;

          if (chunk && typeof chunk === "object" && chunk.type === "usage") {
            overallUsage.inputTokens += chunk.usage.inputTokens || 0;
            overallUsage.outputTokens += chunk.usage.outputTokens || 0;
            overallUsage.cacheReadInputTokens += chunk.usage.cacheReadInputTokens || 0;
            overallUsage.cacheCreationInputTokens += chunk.usage.cacheCreationInputTokens || 0;
            continue;
          }
          if (chunk && typeof chunk === "object" && chunk.type === "thinking") {
            streamedThinking += chunk.content;
            emit({ type: "thinking", content: chunk.content });
            continue;
          }
          if (chunk && typeof chunk === "object") continue; // skip non-text

          if (!overallFirstTokenTime) overallFirstTokenTime = performance.now();
          overallGenerationEnd = performance.now();
          const chunkStr = typeof chunk === "string" ? chunk : "";
          overallOutputCharacters += chunkStr.length;
          finalStreamedText += chunkStr;
          emit({ type: "chunk", content: chunkStr });
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
          rateLimits: lastRateLimits,
      }, currentMessages, true); // <--- pass true to skip the overall request logging so we don't duplicate

      // ── afterResponse hook: session summarization ───────────
      hooks.run("afterResponse", ctx, {
        text: finalStreamedText,
        thinking: streamedThinking,
        toolCalls: streamedToolCalls,
        messages: currentMessages,
      }).catch((err) =>
        logger.error(`[AgenticLoopService] afterResponse hooks failed: ${err.message}`),
      );
    } catch (err) {
      // ── onError hook ───────────────────────────────────────
      hooks.run("onError", err, ctx).catch((hookErr) =>
        logger.error(`[AgenticLoopService] onError hooks failed: ${hookErr.message}`),
      );
      throw err; // Re-throw so handleChat's catch handler can log + emit the error event
    } finally {
      // Always clear generating flag — covers normal exit, abort, and errors
      if (conversationId) {
        ConversationService.setGenerating(conversationId, project, username, false).catch((e) =>
          logger.error(`Failed to clear isGenerating in agentic loop: ${e.message}`)
        );
      }
      // Clean up any lingering approval promises
      pendingApprovals.delete(conversationId);
    }
  }

  /**
   * Resolve a pending approval for a conversation.
   * Called by the HTTP endpoint when the client sends an approval response.
   *
   * @param {string} conversationId
   * @param {boolean} approved
   * @returns {boolean} true if a pending approval was found and resolved
   */
  static resolveApproval(conversationId, approved, { approveAll = false } = {}) {
    const entry = pendingApprovals.get(conversationId);
    if (!entry) return false;

    if (entry.type === "plan") {
      entry.resolve(approved);
    } else {
      entry.resolve({ approved, approveAll, reason: approved ? "user_approved" : "user_rejected" });
    }
    return true;
  }

  /**
   * Check if a conversation has a pending approval.
   * @param {string} conversationId
   * @returns {{ pending: boolean, type?: string, tools?: string[] }}
   */
  static getPendingApproval(conversationId) {
    const entry = pendingApprovals.get(conversationId);
    if (!entry) return { pending: false };
    return { pending: true, type: entry.type, tools: entry.tools };
  }
}

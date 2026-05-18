import BaseAgenticHarness from "./BaseAgenticHarness.js";
import ToolOrchestratorService from "../ToolOrchestratorService.js";
import MongoWrapper from "../../wrappers/MongoWrapper.js";
// @ts-ignore
import { MONGO_DB_NAME } from "../../../config.js";
import logger from "../../utils/logger.js";
import { finalizeTextGeneration } from "../../routes/ChatRoutes.js";
import { mergeUsage } from "../../utils/CostCalculator.js";
import AgentHooks from "../AgentHooks.js";
import AutoApprovalEngine from "../AutoApprovalEngine.js";
import SystemPromptAssembler from "../SystemPromptAssembler.js";
import PlanningModeService from "../PlanningModeService.js";
import MemoryExtractor from "../MemoryExtractor.js";
import SessionGenerationTracker from "../SessionGenerationTracker.js";
import { pendingApprovals } from "../ApprovalRegistry.js";
import { expandMessagesForFC } from "../../utils/FunctionCallingUtilities.js";
const MAX_TOOL_ITERATIONS = 25;
const MAX_CONSECUTIVE_TOOL_ERRORS = 3;
/**
 * StandardAgenticHarness — the default tool-use loop.
 *
 * Control flow:
 *   1. Stream LLM response
 *   2. If tool calls: execute → append results → loop
 *   3. If text only (and not plan mode): break → finalize
 *   4. Exhaustion recovery pass if iteration limit hit
 *
 * Supports:
 *   - Plan mode (planFirst / enter_plan_mode / exit_plan_mode)
 *   - Auto-approval engine
 *   - Coordinator (multi-agent) worker tracking
 *   - Streaming tool output (shell, python, js)
 */
export default class StandardAgenticHarness extends BaseAgenticHarness {
    static id = "standard";
    static label = "Standard";
    static description = "Tool-use loop with plan mode, approval gating, and exhaustion recovery.";
    // @ts-ignore
    async run() {
        // @ts-ignore
        const context = this.ctx;
        // @ts-ignore
        const state = this.state;
        const { providerName, resolvedModel, options, agentSessionId, traceId, project, username, agent, workspaceRoot, emit, signal, } = context;
        // ── Resolve max iterations ────────────────────────────────
        const clientMax = options.maxIterations;
        const resolvedMaxIterations = clientMax === 0
            ? Infinity
            : clientMax
                ? Math.min(100, Math.max(1, clientMax))
                : MAX_TOOL_ITERATIONS;
        let currentMessages = [...context.messages];
        // ── Initialize lifecycle hooks ──────────────────────────
        const hooks = new AgentHooks();
        const approvalEngine = new AutoApprovalEngine({
            fullAuto: options.autoApprove === true,
        });
        hooks.register("beforeToolCall", approvalEngine.createHook(), "AutoApprovalEngine");
        const assembler = new SystemPromptAssembler({
            workspaceRoot: workspaceRoot || undefined,
        });
        hooks.register("beforePrompt", assembler.createHook(), "SystemPromptAssembler");
        hooks.register("afterResponse", MemoryExtractor.createHook(), "MemoryExtractor");
        if (options.planFirst) {
            emit({ type: "status", message: "plan_mode_entered" });
        }
        // ── Main loop ────────────────────────────────────────────
        while (state.iterations < resolvedMaxIterations) {
            state.iterations++;
            emit({
                type: "status",
                message: "iteration_progress",
                iteration: state.iterations,
                maxIterations: resolvedMaxIterations,
            });
            // ── beforePrompt hook (iteration 1 only) ──────────────
            if (state.iterations === 1) {
                const hookCtx = {
                    messages: currentMessages,
                    project,
                    username,
                    agent,
                    traceId,
                    agentSessionId,
                    agentContext: options.agentContext,
                    // @ts-ignore
                    enabledTools: this.tools.resolvedEnabledTools,
                    workspaceRoot: workspaceRoot || undefined,
                };
                await hooks.run("beforePrompt", hookCtx);
                // @ts-ignore
                if (hookCtx._injectedSkills?.length > 0) {
                    // @ts-ignore
                    emit({
                        type: "status",
                        message: "skills_injected",
                        // @ts-ignore
                        skills: hookCtx._injectedSkills,
                    });
                }
                if (state.planModeActive) {
                    PlanningModeService.injectPlanningInstruction(currentMessages);
                }
            }
            // ── Build pass options ─────────────────────────────────
            const passOptions = { ...options, project, agent, username };
            if (state.planModeActive) {
                // @ts-ignore
                passOptions.tools = this.tools.finalTools.filter((t) => t.name === "exit_plan_mode");
                logger.info(`[PlanningMode] Sending ${passOptions.tools.length} tools to provider: ${passOptions.tools.map((t) => t.name).join(", ")}`);
            }
            else {
                // @ts-ignore
                passOptions.tools = this.tools.finalTools;
            }
            const allowedToolNames = new Set((passOptions.tools || []).map((t) => t.name));
            // ── Context window enforcement ─────────────────────────
            // @ts-ignore
            currentMessages = this.enforceContextWindow(currentMessages, 
            // @ts-ignore
            this.tools.finalTools.length);
            // ── Create per-iteration pass state ────────────────────
            const pass = this.createPassState(passOptions);
            const passRequestId = `${context.requestId || agentSessionId}-iter-${state.iterations}`;
            // @ts-ignore
            pass.requestId = passRequestId;
            this.registerTrackerRequest(passRequestId);
            // ── Stream LLM response ────────────────────────────────
            const stream = this.createProviderStream(currentMessages, passOptions);
            // @ts-ignore
            for await (const chunk of stream) {
                const result = this.processStreamChunk(chunk, pass, allowedToolNames);
                // @ts-ignore
                if (result.action === "break") {
                    if (typeof stream.return === "function")
                        stream.return();
                    break;
                }
            }
            // ── Finalize tracker for this pass ─────────────────────
            if (pass.usage.outputTokens > 0) {
                SessionGenerationTracker.update(passRequestId, {
                    outputTokens: pass.usage.outputTokens,
                });
            }
            // @ts-ignore
            const finalInputTokens = 
            // @ts-ignore
            pass.usage.inputTokens || pass.usage.promptTokens || 0;
            if (finalInputTokens > 0) {
                SessionGenerationTracker.update(passRequestId, {
                    inputTokens: finalInputTokens,
                });
            }
            this.emitGenerationProgress();
            SessionGenerationTracker.complete(passRequestId);
            if (signal?.aborted)
                break;
            emit({
                type: "usage_update",
                usage: { ...state.overallUsage, requests: state.iterations },
            });
            // ── Tool execution ─────────────────────────────────────
            if (pass.pendingToolCalls.length > 0) {
                // Plan mode enforcement
                if (state.planModeActive) {
                    const blocked = pass.pendingToolCalls.filter((tc) => tc.name !== "exit_plan_mode");
                    if (blocked.length > 0) {
                        const blockedNames = blocked.map((t) => t.name).join(", ");
                        logger.warn(`[PlanningMode] Blocked ${blocked.length} unauthorized tool call(s): ${blockedNames}`);
                        // @ts-ignore
                        for (const tc of blocked) {
                            const index = pass.pendingToolCalls.indexOf(tc);
                            if (index >= 0)
                                pass.pendingToolCalls.splice(index, 1);
                        }
                        if (pass.pendingToolCalls.length === 0) {
                            if (pass.streamedText) {
                                currentMessages.push({
                                    role: "assistant",
                                    content: pass.streamedText,
                                    ...(pass.streamedThinking && {
                                        thinking: pass.streamedThinking,
                                    }),
                                    ...(pass.thinkingSignature && {
                                        thinkingSignature: pass.thinkingSignature,
                                    }),
                                });
                            }
                            currentMessages.push({
                                role: "user",
                                content: `[SYSTEM] You are in PLANNING MODE. Your tool call(s) [${blockedNames}] were blocked because only exit_plan_mode is available during planning. You MUST call exit_plan_mode to present your plan for approval before any other tools can be used.`,
                            });
                            this.logIteration(pass, currentMessages);
                            continue;
                        }
                    }
                }
                // ── Approval gating ───────────────────────────────────
                const { needsApproval } = approvalEngine.checkBatch(pass.pendingToolCalls);
                if (needsApproval.length > 0 && !options.autoApprove) {
                    // @ts-ignore
                    for (const tc of needsApproval) {
                        emit({
                            type: "approval_required",
                            toolCall: { name: tc.name, args: tc.args, id: tc.id },
                            tier: tc._approval.tier,
                            tierLabel: tc._approval.tierLabel,
                        });
                    }
                    const approvalResult = await new Promise((resolve) => {
                        const timeoutId = setTimeout(() => {
                            pendingApprovals.delete(agentSessionId);
                            resolve({ approved: false, reason: "timeout" });
                        }, 120_000);
                        pendingApprovals.set(agentSessionId, {
                            resolve: (value) => {
                                clearTimeout(timeoutId);
                                pendingApprovals.delete(agentSessionId);
                                resolve(value);
                            },
                            type: "tool",
                            tools: needsApproval.map((t) => t.name),
                        });
                    });
                    // @ts-ignore
                    if (!approvalResult?.approved) {
                        emit({
                            type: "status",
                            message: `Tool execution rejected: ${needsApproval.map((t) => t.name).join(", ")}`,
                        });
                        this.logIteration(pass, currentMessages);
                        break;
                    }
                    // @ts-ignore
                    if (approvalResult.approveAll) {
                        options.autoApprove = true;
                    }
                }
                // ── Execute tools in parallel ─────────────────────────
                const results = await Promise.all(pass.pendingToolCalls.map(async (tc) => {
                    await hooks.run("beforeToolCall", tc, context);
                    // @ts-ignore
                    const customDef = this.tools.customToolMap.get(tc.name);
                    if (customDef) {
                        const result = await ToolOrchestratorService.executeCustomTool(customDef, tc.args);
                        await hooks.run("afterToolCall", tc, result, context);
                        return { name: tc.name, id: tc.id, result };
                    }
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
                        }, {
                            project,
                            username,
                            agent,
                            requestId: context.requestId,
                            agentSessionId,
                            iteration: state.iterations,
                            workspaceRoot,
                        });
                        await hooks.run("afterToolCall", tc, result, context);
                        return { name: tc.name, id: tc.id, result };
                    }
                    const result = await ToolOrchestratorService.executeTool(tc.name, tc.args, {
                        messages: currentMessages,
                        project,
                        username,
                        agent: agent || null,
                        traceId: traceId || null,
                        agentSessionId,
                        clientIp: context.clientIp || null,
                        requestId: context.requestId,
                        agenticIteration: state.iterations,
                        iteration: state.iterations,
                        _providerName: providerName,
                        _resolvedModel: resolvedModel,
                        _emit: emit,
                        _maxWorkerIterations: options.maxWorkerIterations,
                        _minContextLength: options.minContextLength,
                        workspaceRoot,
                    });
                    await hooks.run("afterToolCall", tc, result, context);
                    return { name: tc.name, id: tc.id, result };
                }));
                // ── Post-execution events ─────────────────────────────
                // @ts-ignore
                for (const tc of pass.pendingToolCalls) {
                    // @ts-ignore
                    const res = results.find(
                    // @ts-ignore
                    (r) => r.id === tc.id || (!r.id && r.name === tc.name));
                    const hasError = !!res?.result?.error;
                    emit({
                        type: "tool_execution",
                        // @ts-ignore
                        tool: {
                            // @ts-ignore
                            name: tc.name,
                            // @ts-ignore
                            args: tc.args || {},
                            // @ts-ignore
                            id: tc.id,
                            // @ts-ignore
                            responsesItemId: tc.responsesItemId,
                            result: res?.result,
                        },
                        status: hasError ? "error" : "done",
                    });
                    if (res?.result?.screenshotRef) {
                        state.streamedImages.push(res.result.screenshotRef);
                        // @ts-ignore
                        pass.streamedImages.push(res.result.screenshotRef);
                    }
                    if (res?.result?.image?.data) {
                        const image = res.result.image;
                        const toolImgRef = image.minioRef || `data:${image.mimeType};base64,${image.data}`;
                        state.streamedImages.push(toolImgRef);
                        // @ts-ignore
                        pass.streamedImages.push(toolImgRef);
                        emit({
                            type: "image",
                            data: image.data,
                            mimeType: image.mimeType,
                            minioRef: image.minioRef,
                        });
                        delete res.result.image;
                    }
                    if (hasError) {
                        // @ts-ignore
                        const count = (state.toolErrorCounts.get(tc.name) || 0) + 1;
                        // @ts-ignore
                        state.toolErrorCounts.set(tc.name, count);
                        if (count >= MAX_CONSECUTIVE_TOOL_ERRORS) {
                            // @ts-ignore
                            logger.warn(
                            // @ts-ignore
                            `[AgenticLoop] Tool "${tc.name}" hit error limit (${count}), skipping in future iterations`);
                            // @ts-ignore
                            emit({
                                type: "status",
                                // @ts-ignore
                                message: `Tool "${tc.name}" failed ${count} times consecutively — skipping`,
                            });
                        }
                    }
                    else {
                        // @ts-ignore
                        state.toolErrorCounts.delete(tc.name);
                    }
                }
                // ── Status notifications ──────────────────────────────
                if (pass.pendingToolCalls.some((tc) => tc.name.startsWith("task_"))) {
                    emit({ type: "status", message: "tasks_updated" });
                }
                if (pass.pendingToolCalls.some((tc) => tc.name === "team_create" || tc.name === "stop_agent")) {
                    emit({ type: "status", message: "workers_updated" });
                }
                if (pass.pendingToolCalls.some((tc) => tc.name === "upsert_memory")) {
                    emit({ type: "status", message: "memories_updated" });
                }
                // ── Hot-reload custom tools mid-session ──────────────────
                // When a custom tool is created/updated/deleted during the agentic
                // loop, update the live customToolMap and finalTools so the agent
                // can invoke the new tool on subsequent iterations without restart.
                const customToolMutations = pass.pendingToolCalls.filter((tc) => [
                    "create_custom_tool",
                    "create_privileged_tool",
                    "update_custom_tool",
                    "delete_custom_tool",
                ].includes(tc.name));
                if (customToolMutations.length > 0) {
                    try {
                        const db = MongoWrapper.getDb(MONGO_DB_NAME);
                        if (db) {
                            const freshCustom = await db
                                .collection("custom_tools")
                                .find({ project, username, enabled: true })
                                .toArray();
                            // Rebuild the customToolMap
                            // @ts-ignore
                            this.tools.customToolMap.clear();
                            // @ts-ignore
                            for (const t of freshCustom) {
                                // @ts-ignore
                                this.tools.customToolMap.set(t.name, t);
                            }
                            // Rebuild finalTools: remove old custom tools, add fresh ones
                            // @ts-ignore
                            const builtInTools = this.tools.finalTools.filter((t) => !t._isCustom);
                            const freshSchemas = freshCustom.map((t) => ({
                                name: t.name,
                                description: t.description,
                                _isCustom: true,
                                parameters: {
                                    type: "object",
                                    properties: Object.fromEntries((t.parameters || []).map((p) => [
                                        p.name,
                                        {
                                            type: p.type || "string",
                                            description: p.description || "",
                                            ...(p.enum?.length ? { enum: p.enum } : {}),
                                        },
                                    ])),
                                    required: (t.parameters || [])
                                        .filter((p) => p.required)
                                        .map((p) => p.name),
                                },
                            }));
                            // @ts-ignore
                            this.tools.finalTools = [...builtInTools, ...freshSchemas];
                            logger.info(`[AgenticLoop] Hot-reloaded ${freshCustom.length} custom tool(s) into live session`);
                        }
                    }
                    catch (error) {
                        logger.warn(`[AgenticLoop] Failed to hot-reload custom tools: ${error.message}`);
                    }
                    emit({ type: "status", message: "custom_tools_updated" });
                }
                // ── Plan mode toggling ────────────────────────────────
                if (pass.pendingToolCalls.some((tc) => tc.name === "enter_plan_mode")) {
                    state.planModeActive = true;
                    state.planModeText = "";
                    PlanningModeService.injectPlanningInstruction(currentMessages);
                    emit({ type: "status", message: "plan_mode_entered" });
                }
                const exitPlanTC = pass.pendingToolCalls.find((tc) => tc.name === "exit_plan_mode");
                if (exitPlanTC) {
                    const shouldContinue = await this._handleExitPlanMode(exitPlanTC, pass, results, currentMessages);
                    if (!shouldContinue)
                        return;
                }
                this.logIteration(pass, currentMessages);
                // ── Append to context for next pass ───────────────────
                const assistantMsg = {
                    role: "assistant",
                    content: pass.streamedText || "",
                    ...(pass.streamedThinking && { thinking: pass.streamedThinking }),
                    ...(pass.thinkingSignature && {
                        thinkingSignature: pass.thinkingSignature,
                    }),
                    toolCalls: pass.pendingToolCalls.map((tc) => {
                        const match = results.find((r) => r.id === tc.id);
                        return {
                            id: tc.id || null,
                            responsesItemId: tc.responsesItemId || undefined,
                            name: tc.name,
                            args: tc.args,
                            thoughtSignature: tc.thoughtSignature || undefined,
                            result: match ? match.result : null,
                        };
                    }),
                };
                currentMessages.push(assistantMsg);
                currentMessages = currentMessages.filter((m) => !(m.role === "assistant" &&
                    !m.content?.trim() &&
                    (!m.toolCalls || m.toolCalls.length === 0)));
                continue;
            }
            // ── No tools — check if we should break ─────────────────
            if (pass.streamedText || pass.streamedThinking) {
                if (state.planModeActive) {
                    currentMessages.push({
                        role: "assistant",
                        content: pass.streamedText,
                        ...(pass.streamedThinking && { thinking: pass.streamedThinking }),
                        ...(pass.thinkingSignature && {
                            thinkingSignature: pass.thinkingSignature,
                        }),
                    });
                    this.logIteration(pass, currentMessages);
                    continue;
                }
                this.logIteration(pass, currentMessages);
                break;
            }
            // ── Empty output — break ────────────────────────────────
            logger.warn(`[AgenticLoop] Empty model output on iteration ${state.iterations} — ` +
                `text=${pass.streamedText.length}, thinking=${pass.streamedThinking.length}, ` +
                `toolCalls=${pass.pendingToolCalls.length}. Breaking.`);
            this.logIteration(pass, currentMessages);
            break;
        }
        // ── Exhaustion Recovery Pass ─────────────────────────────
        if (state.iterations >= resolvedMaxIterations &&
            !state.finalStreamedText?.trim()) {
            await this._runExhaustionPass(currentMessages);
        }
        // ── Finalization ─────────────────────────────────────────
        await this._finalize(context, currentMessages, hooks);
        return { messages: currentMessages };
    }
    // ── Private methods ─────────────────────────────────────────
    async _handleExitPlanMode(exitPlanTC, pass, results, currentMessages) {
        // @ts-ignore
        const { options, emit, signal, agentSessionId } = this.ctx;
        // @ts-ignore
        const state = this.state;
        const planText = state.planModeText.trim() || pass.streamedText.trim();
        const planSteps = PlanningModeService.extractSteps(planText);
        logger.info(`[PlanningMode] exit_plan_mode called — planText=${planText.length} chars, steps=${planSteps.length}, autoApprove=${!!options.autoApprove}`);
        emit({
            type: "plan_proposal",
            plan: planText,
            steps: planSteps,
            autoApproved: !!options.autoApprove,
        });
        let approved;
        if (options.autoApprove) {
            approved = true;
            logger.info("[PlanningMode] Auto-approved plan (autoApprove=true)");
        }
        else {
            approved = await new Promise((resolve) => {
                const timeoutId = setTimeout(() => {
                    pendingApprovals.delete(agentSessionId);
                    resolve(false);
                }, 120_000);
                pendingApprovals.set(agentSessionId, {
                    resolve: (value) => {
                        clearTimeout(timeoutId);
                        pendingApprovals.delete(agentSessionId);
                        resolve(value);
                    },
                    type: "plan",
                });
            });
        }
        if (!approved || signal?.aborted) {
            emit({ type: "status", message: "Plan rejected — execution cancelled." });
            // @ts-ignore
            emit({
                type: "done",
                usage: state.overallUsage,
                // @ts-ignore
                totalTime: (performance.now() - this.ctx.requestStart) / 1000,
            });
            return false; // signal caller to return
        }
        const exitResult = results.find((r) => r.id === exitPlanTC.id || r.name === "exit_plan_mode");
        if (exitResult) {
            exitResult.result = {
                approved: true,
                message: `User has approved your plan. You can now start coding. Start with updating your todo list if applicable.\n\n${planText}`,
            };
        }
        state.planModeActive = false;
        state.planModeText = "";
        PlanningModeService.stripPlanningInstruction(currentMessages);
        emit({ type: "status", message: "plan_mode_exited" });
        return true;
    }
    async _runExhaustionPass(currentMessages) {
        // @ts-ignore
        const { emit, signal, options, resolvedModel, modelDef, provider } = 
        // @ts-ignore
        this.ctx;
        // @ts-ignore
        const state = this.state;
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
        currentMessages = this.enforceContextWindow(currentMessages, 0);
        const expandedMsgs = expandMessagesForFC(currentMessages, {
            filterDeleted: false,
        });
        // @ts-ignore
        const augmentedOptions = {
            ...exhaustionOptions,
            // @ts-ignore
            project: this.ctx.project,
            // @ts-ignore
            agent: this.ctx.agent,
            // @ts-ignore
            username: this.ctx.username,
        };
        // @ts-ignore
        const exhaustionRequestId = `${this.ctx.requestId || this.ctx.agentSessionId}-exhaustion`;
        this.registerTrackerRequest(exhaustionRequestId);
        const exhaustionStream = modelDef?.liveAPI && provider.generateTextStreamLive
            ? provider.generateTextStreamLive(expandedMsgs, resolvedModel, {
                ...augmentedOptions,
                signal,
            })
            : provider.generateTextStream(expandedMsgs, resolvedModel, {
                ...augmentedOptions,
                signal,
            });
        // @ts-ignore
        for await (const chunk of exhaustionStream) {
            if (signal?.aborted)
                break;
            if (chunk?.type === "usage") {
                mergeUsage(state.overallUsage, chunk.usage);
                if (chunk.usage?.outputTokens > 0) {
                    SessionGenerationTracker.update(exhaustionRequestId, {
                        outputTokens: chunk.usage.outputTokens,
                    });
                }
                continue;
            }
            if (chunk?.type === "thinking") {
                state.streamedThinking += chunk.content;
                state.overallOutputCharacters += chunk.content.length;
                SessionGenerationTracker.recordChunkTiming(exhaustionRequestId, chunk.content.length);
                emit({
                    type: "thinking",
                    content: chunk.content,
                    outputCharacters: state.overallOutputCharacters,
                });
                this.maybeEmitProgress();
                continue;
            }
            if (chunk && typeof chunk === "object")
                continue;
            if (!state.overallFirstTokenTime)
                state.overallFirstTokenTime = performance.now();
            state.overallGenerationEnd = performance.now();
            const chunkStr = typeof chunk === "string" ? chunk : "";
            state.overallOutputCharacters += chunkStr.length;
            state.finalStreamedText += chunkStr;
            SessionGenerationTracker.recordChunkTiming(exhaustionRequestId, chunkStr.length);
            emit({
                type: "chunk",
                content: chunkStr,
                outputCharacters: state.overallOutputCharacters,
            });
            this.maybeEmitProgress();
        }
        this.emitGenerationProgress();
        SessionGenerationTracker.complete(exhaustionRequestId);
    }
    async _finalize(context, currentMessages, hooks) {
        // @ts-ignore
        const state = this.state;
        const { agentSessionId, project, username, requestStart } = context;
        const now = performance.now();
        state.overallUsage.requests = state.iterations;
        const { cleanSegments, cleanTextFragments, cleanThinkingFragments } = state.getCleanDisplayData();
        const newTurnMessages = currentMessages.slice(Math.max(0, state.originalMessageCount - 1));
        logger.info(`[AgenticLoop] _finalize: session=${agentSessionId} project=${project} ` +
            `originalMsgCount=${state.originalMessageCount} currentMsgs=${currentMessages.length} ` +
            `newTurnMsgs=${newTurnMessages.length} ` +
            `roles=[${newTurnMessages.map((m) => m.role).join(",")}] ` +
            `text=${(state.finalStreamedText || "").length}chars`);
        await finalizeTextGeneration(context, {
            text: state.finalStreamedText.trim(),
            thinking: state.streamedThinking.trim() || "",
            images: state.streamedImages,
            toolCalls: state.streamedToolCalls,
            audioChunks: state.streamedAudioChunks,
            audioSampleRate: state.audioSampleRate,
            usage: state.overallUsage,
            outputCharacters: state.overallOutputCharacters,
            timeToGenerationSec: state.overallFirstTokenTime
                ? (state.overallFirstTokenTime - requestStart) / 1000
                : null,
            generationSec: state.overallFirstTokenTime && state.overallGenerationEnd
                ? (state.overallGenerationEnd - state.overallFirstTokenTime) / 1000
                : null,
            totalSec: (now - requestStart) / 1000,
            rateLimits: state.lastRateLimits,
            contentSegments: cleanSegments,
            textFragments: cleanTextFragments,
            thinkingFragments: cleanThinkingFragments,
        }, newTurnMessages);
        // Persist worker snapshots
        if (state.streamedToolCalls.some((tc) => tc.name === "team_create") &&
            agentSessionId) {
            try {
                const { default: CoordinatorService } = await import("../CoordinatorService.js");
                const { COLLECTIONS } = await import("../../constants.js");
                const workers = CoordinatorService.listWorkers({
                    parentAgentSessionId: agentSessionId,
                });
                if (workers.length > 0) {
                    const col = MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.AGENT_SESSIONS);
                    await col.updateOne({ id: agentSessionId, project, username }, { $set: { workers, workersUpdatedAt: new Date().toISOString() } });
                    logger.info(`[AgenticLoop] Persisted ${workers.length} worker(s) to session ${agentSessionId}`);
                }
            }
            catch (error) {
                logger.error(`[AgenticLoop] Failed to persist workers: ${error.message}`);
            }
        }
        // afterResponse hook (fire-and-forget)
        hooks
            .run("afterResponse", context, {
            text: state.finalStreamedText,
            thinking: state.streamedThinking,
            toolCalls: state.streamedToolCalls,
            messages: currentMessages,
        })
            .catch((error) => logger.error(`[AgenticLoopService] afterResponse hooks failed: ${error.message}`));
    }
}
//# sourceMappingURL=StandardAgenticHarness.js.map
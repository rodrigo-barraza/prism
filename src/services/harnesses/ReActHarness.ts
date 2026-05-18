import BaseAgenticHarness from "./BaseAgenticHarness.ts";
import MongoWrapper from "../../wrappers/MongoWrapper.ts";
// @ts-ignore
import { MONGO_DB_NAME } from "../../../config.ts";
import logger from "../../utils/logger.ts";

import { finalizeTextGeneration } from "./lifecycle/Finalizer.ts";
import { createStandardHooks } from "./lifecycle/HookInitializer.ts";
import { executeToolBatch } from "./lifecycle/ToolExecutor.ts";
import { checkAndWaitForApproval } from "./lifecycle/ApprovalGate.ts";
import {
  emitPostExecutionStatus,
  processToolResultMedia,
  trackToolErrors,
} from "./lifecycle/PostExecutionEmitter.ts";
import { runExhaustionRecoveryPass } from "./lifecycle/ExhaustionRecovery.ts";
import { reloadIfCustomToolsMutated } from "./lifecycle/ToolHotReloader.ts";
import {
  blockUnauthorizedToolCalls,
  handleExitPlanMode,
  checkForPlanModeEntry,
} from "./lifecycle/PlanModeController.ts";

import PlanningModeService from "../PlanningModeService.ts";
import SessionGenerationTracker from "../SessionGenerationTracker.ts";
import { COLLECTIONS } from "../../constants.ts";

const MAX_TOOL_ITERATIONS = 25;
const MAX_CONSECUTIVE_TOOL_ERRORS = 3;

/**
 * ReActHarness — Reason→Act→Observe tool-use loop.
 *
 * Based on the ReAct pattern (Yao et al., 2022) as implemented by
 * Claude Code (github.com/razakiau/claude-code).
 *
 * Control flow:
 *   1. Stream LLM response (Reason)
 *   2. If tool calls: execute → append results → loop (Act → Observe)
 *   3. If text only (and not plan mode): break → finalize
 *   4. Exhaustion recovery pass if iteration limit hit
 *
 * Supports:
 *   - Plan mode (planFirst / enter_plan_mode / exit_plan_mode)
 *   - Auto-approval engine
 *   - Coordinator (multi-agent) worker tracking
 *   - Streaming tool output (shell, python, js)
 *
 * Lifecycle phases are delegated to composable modules in ./lifecycle/
 * so future harnesses can reuse individual phases without inheriting
 * the entire ReActHarness.
 */
export default class ReActHarness extends BaseAgenticHarness {
  static id = "standard";
  static label = "ReAct Loop";
  static description =
    "Reason→Act→Observe tool-use loop with plan mode, approval gating, and exhaustion recovery.";

  // @ts-ignore
  async run() {
    // @ts-ignore
    const context = this.ctx;
    // @ts-ignore
    const state = this.state;
    const {
      options,
      agentSessionId,
      traceId,
      project,
      username,
      agent,
      workspaceRoot,
      emit,
      signal,
    } = context;

    // ── Resolve max iterations ────────────────────────────────
    const clientMaxIterations = options.maxIterations;
    const resolvedMaxIterations =
      clientMaxIterations === 0
        ? Infinity
        : clientMaxIterations
          ? Math.min(100, Math.max(1, clientMaxIterations))
          : MAX_TOOL_ITERATIONS;

    let currentMessages = [...context.messages];

    // ── Initialize lifecycle hooks ──────────────────────────
    const { hooks, approvalEngine } = createStandardHooks({
      workspaceRoot: workspaceRoot || undefined,
      autoApprove: options.autoApprove === true,
    });

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
        const hookContext = {
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
        await hooks.run("beforePrompt", hookContext);

        // @ts-ignore
        if (hookContext._injectedSkills?.length > 0) {
          // @ts-ignore
          emit({
            type: "status",
            message: "skills_injected",
            // @ts-ignore
            skills: hookContext._injectedSkills,
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
        passOptions.tools = this.tools.finalTools.filter(
          (tool: any) => tool.name === "exit_plan_mode",
        );
        logger.info(
          `[PlanningMode] Sending ${passOptions.tools.length} tools to provider: ${passOptions.tools.map((tool: any) => tool.name).join(", ")}`,
        );
      } else {
        // @ts-ignore
        passOptions.tools = this.tools.finalTools;
      }

      const allowedToolNames = new Set(
        (passOptions.tools || []).map((tool: any) => tool.name),
      );

      // ── Context window enforcement ─────────────────────────
      // @ts-ignore
      currentMessages = this.enforceContextWindow(
        currentMessages,
        // @ts-ignore
        this.tools.finalTools.length,
      );

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
          if (typeof stream.return === "function") stream.return();
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

      if (signal?.aborted) break;

      emit({
        type: "usage_update",
        usage: { ...state.overallUsage, requests: state.iterations },
      });

      // ── Tool execution ─────────────────────────────────────
      if (pass.pendingToolCalls.length > 0) {
        // Plan mode enforcement
        if (state.planModeActive) {
          const { allBlocked } = blockUnauthorizedToolCalls(
            pass.pendingToolCalls,
            currentMessages,
            pass,
            state,
          );
          if (allBlocked) {
            this.logIteration(pass, currentMessages);
            continue;
          }
        }

        // ── Approval gating ───────────────────────────────────
        const { approved, approveAll } = await checkAndWaitForApproval(
          pass.pendingToolCalls,
          context,
          approvalEngine,
        );

        if (!approved) {
          this.logIteration(pass, currentMessages);
          break;
        }

        if (approveAll) {
          options.autoApprove = true;
        }

        // ── Execute tools in parallel ─────────────────────────
        // Attach currentMessages to context so ToolExecutor can pass them
        // to tools-api (needed by tools like generate_image that inspect conversation)
        context._currentMessages = currentMessages;

        const results = await executeToolBatch(
          pass.pendingToolCalls,
          context,
          // @ts-ignore
          this.tools,
          hooks,
          state,
        );

        // ── Post-execution: media, errors, status ─────────────
        processToolResultMedia(
          pass.pendingToolCalls,
          results,
          state,
          pass,
          emit,
        );

        trackToolErrors(
          pass.pendingToolCalls,
          results,
          state,
          MAX_CONSECUTIVE_TOOL_ERRORS,
          emit,
        );

        emitPostExecutionStatus(pass.pendingToolCalls, emit);

        // ── Hot-reload custom tools mid-session ──────────────
        await reloadIfCustomToolsMutated(
          pass.pendingToolCalls,
          // @ts-ignore
          this.tools,
          project,
          username,
          emit,
        );

        // ── Plan mode toggling ────────────────────────────────
        checkForPlanModeEntry(
          pass.pendingToolCalls,
          currentMessages,
          state,
          emit,
        );

        const exitPlanToolCall = pass.pendingToolCalls.find(
          (toolCall: any) => toolCall.name === "exit_plan_mode",
        );
        if (exitPlanToolCall) {
          const { shouldContinueLoop } = await handleExitPlanMode(
            exitPlanToolCall,
            pass,
            results,
            currentMessages,
            context,
            state,
          );
          if (!shouldContinueLoop) return;
        }

        this.logIteration(pass, currentMessages);

        // ── Append to context for next pass ───────────────────
        const assistantMessage = {
          role: "assistant",
          content: pass.streamedText || "",
          ...(pass.streamedThinking && { thinking: pass.streamedThinking }),
          ...(pass.thinkingSignature && {
            thinkingSignature: pass.thinkingSignature,
          }),
          toolCalls: pass.pendingToolCalls.map((toolCall: any) => {
            const matchingResult = results.find(
              (result: any) => result.id === toolCall.id,
            );
            return {
              id: toolCall.id || null,
              responsesItemId: toolCall.responsesItemId || undefined,
              name: toolCall.name,
              args: toolCall.args,
              thoughtSignature: toolCall.thoughtSignature || undefined,
              result: matchingResult ? matchingResult.result : null,
            };
          }),
        };
        currentMessages.push(assistantMessage);

        currentMessages = currentMessages.filter(
          (message: any) =>
            !(
              message.role === "assistant" &&
              !message.content?.trim() &&
              (!message.toolCalls || message.toolCalls.length === 0)
            ),
        );
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
      logger.warn(
        `[AgenticLoop] Empty model output on iteration ${state.iterations} — ` +
          `text=${pass.streamedText.length}, thinking=${pass.streamedThinking.length}, ` +
          `toolCalls=${pass.pendingToolCalls.length}. Breaking.`,
      );
      this.logIteration(pass, currentMessages);
      break;
    }

    // ── Exhaustion Recovery Pass ─────────────────────────────
    if (
      state.iterations >= resolvedMaxIterations &&
      !state.finalStreamedText?.trim()
    ) {
      await runExhaustionRecoveryPass(this, context, state, currentMessages);
    }

    // ── Finalization ─────────────────────────────────────────
    await this._finalize(context, currentMessages, hooks);
    return { messages: currentMessages };
  }

  // ── Private methods ─────────────────────────────────────────

  async _finalize(context: any, currentMessages: any, hooks: any) {
    // @ts-ignore
    const state = this.state;
    const { agentSessionId, project, username, requestStart } = context;

    const now = performance.now();
    state.overallUsage.requests = state.iterations;

    const { cleanSegments, cleanTextFragments, cleanThinkingFragments } =
      state.getCleanDisplayData();

    const newTurnMessages = currentMessages.slice(
      Math.max(0, state.originalMessageCount - 1),
    );

    logger.info(
      `[AgenticLoop] _finalize: session=${agentSessionId} project=${project} ` +
        `originalMsgCount=${state.originalMessageCount} currentMsgs=${currentMessages.length} ` +
        `newTurnMsgs=${newTurnMessages.length} ` +
        `roles=[${newTurnMessages.map((message: any) => message.role).join(",")}] ` +
        `text=${(state.finalStreamedText || "").length}chars`,
    );

    await finalizeTextGeneration(
      context,
      {
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
        generationSec:
          state.overallFirstTokenTime && state.overallGenerationEnd
            ? (state.overallGenerationEnd - state.overallFirstTokenTime) / 1000
            : null,
        totalSec: (now - requestStart) / 1000,
        rateLimits: state.lastRateLimits,
        contentSegments: cleanSegments,
        textFragments: cleanTextFragments,
        thinkingFragments: cleanThinkingFragments,
      },
      newTurnMessages,
    );

    // Persist worker snapshots
    if (
      state.streamedToolCalls.some(
        (toolCall: any) => toolCall.name === "team_create",
      ) &&
      agentSessionId
    ) {
      try {
        const { default: CoordinatorService } =
          await import("../CoordinatorService.js");
        const workers = CoordinatorService.listWorkers({
          parentAgentSessionId: agentSessionId,
        });
        if (workers.length > 0) {
          const collection = MongoWrapper.getCollection(
            MONGO_DB_NAME,
            COLLECTIONS.AGENT_SESSIONS,
          );
          await collection.updateOne(
            { id: agentSessionId, project, username },
            {
              $set: {
                workers,
                workersUpdatedAt: new Date().toISOString(),
              },
            },
          );
          logger.info(
            `[AgenticLoop] Persisted ${workers.length} worker(s) to session ${agentSessionId}`,
          );
        }
      } catch (error: any) {
        logger.error(
          `[AgenticLoop] Failed to persist workers: ${error.message}`,
        );
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
      .catch((error: any) =>
        logger.error(
          `[AgenticLoopService] afterResponse hooks failed: ${error.message}`,
        ),
      );
  }
}

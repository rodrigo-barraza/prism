import { mergeUsage } from "../../../utils/CostCalculator.ts";
import { expandMessagesForFC } from "../../../utils/FunctionCallingUtilities.ts";
import SessionGenerationTracker from "../../SessionGenerationTracker.ts";

/**
 * ExhaustionRecovery — handles the iteration-limit summary pass.
 *
 * When the agentic loop hits its maximum iteration count without producing
 * a final text response, this module runs one last LLM call (with no tools)
 * asking the model to summarize progress and state what remains.
 *
 * Extracted from ReActHarness to be reusable by any iterating harness.
 */

/**
 * Run a tool-free exhaustion recovery pass.
 *
 * Appends a system instruction asking for a progress summary, streams the
 * response, and updates state with the generated text.
 *
 * @param harness          — BaseAgenticHarness instance (for stream helpers)
 * @param context          — Generation context
 * @param state            — AgenticLoopState
 * @param currentMessages  — Current conversation messages (mutated in-place)
 */
export async function runExhaustionRecoveryPass(
  harness: any,
  context: any,
  state: any,
  currentMessages: any[],
): Promise<void> {
  const { emit, signal, options, resolvedModel, modelDef, provider } = context;

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

  const enforcedMessages = harness.enforceContextWindow(currentMessages, 0);
  const expandedMessages = expandMessagesForFC(enforcedMessages, {
    filterDeleted: false,
  });

  const augmentedOptions = {
    ...exhaustionOptions,
    project: context.project,
    agent: context.agent,
    username: context.username,
  };

  const exhaustionRequestId = `${context.requestId || context.agentSessionId}-exhaustion`;
  harness.registerTrackerRequest(exhaustionRequestId);

  const exhaustionStream =
    modelDef?.liveAPI && provider.generateTextStreamLive
      ? provider.generateTextStreamLive(expandedMessages, resolvedModel, {
          ...augmentedOptions,
          signal,
        })
      : provider.generateTextStream(expandedMessages, resolvedModel, {
          ...augmentedOptions,
          signal,
        });

  for await (const chunk of exhaustionStream) {
    if (signal?.aborted) break;

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
      SessionGenerationTracker.recordChunkTiming(
        exhaustionRequestId,
        chunk.content.length,
      );
      emit({
        type: "thinking",
        content: chunk.content,
        outputCharacters: state.overallOutputCharacters,
      });
      harness.maybeEmitProgress();
      continue;
    }
    if (chunk && typeof chunk === "object") continue;

    if (!state.overallFirstTokenTime)
      state.overallFirstTokenTime = performance.now();
    state.overallGenerationEnd = performance.now();
    const chunkText = typeof chunk === "string" ? chunk : "";
    state.overallOutputCharacters += chunkText.length;
    state.finalStreamedText += chunkText;
    SessionGenerationTracker.recordChunkTiming(
      exhaustionRequestId,
      chunkText.length,
    );
    emit({
      type: "chunk",
      content: chunkText,
      outputCharacters: state.overallOutputCharacters,
    });
    harness.maybeEmitProgress();
  }

  harness.emitGenerationProgress();
  SessionGenerationTracker.complete(exhaustionRequestId);
}

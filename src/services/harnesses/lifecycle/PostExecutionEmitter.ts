import logger from "../../../utils/logger.ts";

/**
 * PostExecutionEmitter — status notifications emitted after tool execution.
 *
 * Checks tool calls for specific side-effect patterns (tasks, workers,
 * memories, custom tools) and emits appropriate status events to the
 * frontend so the UI can refresh relevant panels.
 *
 * Extracted from ReActHarness to be reusable across harnesses.
 */

/**
 * Emit status notifications based on which tools were executed.
 *
 * @param toolCalls — Array of executed tool calls
 * @param emit      — SSE event emitter
 */
export function emitPostExecutionStatus(toolCalls: any[], emit: any): void {
  if (toolCalls.some((tc: any) => tc.name.startsWith("task_"))) {
    emit({ type: "status", message: "tasks_updated" });
  }

  if (
    toolCalls.some(
      (tc: any) => tc.name === "team_create" || tc.name === "stop_agent",
    )
  ) {
    emit({ type: "status", message: "workers_updated" });
  }

  if (toolCalls.some((tc: any) => tc.name === "upsert_memory")) {
    emit({ type: "status", message: "memories_updated" });
  }
}

/**
 * Process tool results for image/screenshot side-effects.
 *
 * Extracts image data from tool results, pushes refs to state, and
 * emits image events to the SSE stream.
 *
 * @param toolCalls — Array of { id, name, args }
 * @param results   — Array of { name, id, result }
 * @param state     — AgenticLoopState
 * @param pass      — Per-iteration pass state
 * @param emit      — SSE event emitter
 */
export function processToolResultMedia(
  toolCalls: any[],
  results: any[],
  state: any,
  pass: any,
  emit: any,
): void {
  for (const tc of toolCalls) {
    const res = results.find(
      (r: any) => r.id === tc.id || (!r.id && r.name === tc.name),
    );
    const hasError = !!res?.result?.error;

    emit({
      type: "tool_execution",
      tool: {
        name: tc.name,
        args: tc.args || {},
        id: tc.id,
        responsesItemId: tc.responsesItemId,
        result: res?.result,
      },
      status: hasError ? "error" : "done",
    });

    if (res?.result?.screenshotRef) {
      state.streamedImages.push(res.result.screenshotRef);
      pass.streamedImages.push(res.result.screenshotRef);
    }

    if (res?.result?.image?.data) {
      const image = res.result.image;
      const toolImgRef =
        image.minioRef || `data:${image.mimeType};base64,${image.data}`;
      state.streamedImages.push(toolImgRef);
      pass.streamedImages.push(toolImgRef);
      emit({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
        minioRef: image.minioRef,
      });
      delete res.result.image;
    }
  }
}

/**
 * Track consecutive tool errors and log/emit when a tool hits the limit.
 *
 * @param toolCalls           — Array of executed tool calls
 * @param results             — Array of { name, id, result }
 * @param state               — AgenticLoopState (owns toolErrorCounts)
 * @param maxConsecutiveErrors — Error budget per tool
 * @param emit                — SSE event emitter
 */
export function trackToolErrors(
  toolCalls: any[],
  results: any[],
  state: any,
  maxConsecutiveErrors: number,
  emit: any,
): void {
  for (const tc of toolCalls) {
    const res = results.find(
      (r: any) => r.id === tc.id || (!r.id && r.name === tc.name),
    );
    const hasError = !!res?.result?.error;

    if (hasError) {
      const count = (state.toolErrorCounts.get(tc.name) || 0) + 1;
      state.toolErrorCounts.set(tc.name, count);
      if (count >= maxConsecutiveErrors) {
        logger.warn(
          `[AgenticLoop] Tool "${tc.name}" hit error limit (${count}), skipping in future iterations`,
        );
        emit({
          type: "status",
          message: `Tool "${tc.name}" failed ${count} times consecutively — skipping`,
        });
      }
    } else {
      state.toolErrorCounts.delete(tc.name);
    }
  }
}

import ToolOrchestratorService from "../../ToolOrchestratorService.ts";

/**
 * ToolExecutor — parallel and single tool execution extracted from
 * ReActHarness. Handles custom tools, streaming tools,
 * and standard tools-api dispatch.
 *
 * Reusable by any harness implementation.
 */

/**
 * Execute a batch of tool calls in parallel.
 *
 * @param toolCalls  — Array of { id, name, args, responsesItemId? }
 * @param context    — Generation context (project, username, agent, etc.)
 * @param tools      — { customToolMap, finalTools }
 * @param hooks      — AgentHooks instance for before/afterToolCall
 * @param state      — AgenticLoopState (for iteration count)
 * @returns Array of { name, id, result }
 */
export async function executeToolBatch(
  toolCalls: any[],
  context: any,
  tools: any,
  hooks: any,
  state: any,
): Promise<any[]> {
  const {
    project,
    username,
    agent,
    agentSessionId,
    traceId,
    providerName,
    resolvedModel,
    workspaceRoot,
    emit,
  } = context;

  const results = await Promise.all(
    toolCalls.map(async (toolCall: any) => {
      await hooks.run("beforeToolCall", toolCall, context);

      const customDefinition = tools.customToolMap.get(toolCall.name);
      if (customDefinition) {
        const result = await ToolOrchestratorService.executeCustomTool(
          customDefinition,
          toolCall.args,
        );
        await hooks.run("afterToolCall", toolCall, result, context);
        return { name: toolCall.name, id: toolCall.id, result };
      }

      if (ToolOrchestratorService.isStreamable(toolCall.name)) {
        const result = await ToolOrchestratorService.executeToolStreaming(
          toolCall.name,
          toolCall.args,
          (event: any, data: any, meta: any) => {
            emit({
              type: "tool_output",
              toolCallId: toolCall.id,
              name: toolCall.name,
              event,
              data: data || undefined,
              meta: meta || undefined,
            });
          },
          {
            project,
            username,
            agent,
            requestId: context.requestId,
            agentSessionId,
            iteration: state.iterations,
            workspaceRoot,
          },
        );
        await hooks.run("afterToolCall", toolCall, result, context);
        return { name: toolCall.name, id: toolCall.id, result };
      }

      const result = await ToolOrchestratorService.executeTool(
        toolCall.name,
        toolCall.args,
        {
          messages: context._currentMessages || context.messages,
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
          _maxWorkerIterations: context.options?.maxWorkerIterations,
          _minContextLength: context.options?.minContextLength,
          workspaceRoot,
        },
      );
      await hooks.run("afterToolCall", toolCall, result, context);
      return { name: toolCall.name, id: toolCall.id, result };
    }),
  );

  return results;
}

/**
 * Execute a single tool call (for ReAct-style one-at-a-time execution).
 *
 * @param toolCall — { id, name, args }
 * @param context  — Generation context
 * @param tools    — { customToolMap }
 * @param hooks    — AgentHooks instance
 * @param state    — AgenticLoopState
 * @returns { name, id, result }
 */
export async function executeToolSingle(
  toolCall: any,
  context: any,
  tools: any,
  hooks: any,
  state: any,
): Promise<any> {
  const [result] = await executeToolBatch([toolCall], context, tools, hooks, state);
  return result;
}

import MongoWrapper from "../../../wrappers/MongoWrapper.ts";
// @ts-ignore
import { MONGO_DB_NAME } from "../../../../config.ts";
import logger from "../../../utils/logger.ts";

/**
 * ToolHotReloader — refreshes custom tools mid-session without restart.
 *
 * When a custom tool is created, updated, or deleted during an agentic loop,
 * this module re-fetches the custom tools from MongoDB and rebuilds
 * the live customToolMap and finalTools arrays.
 *
 * Extracted from ReActHarness to be reusable across harnesses.
 */

/** Tool names that trigger a custom tool reload when executed. */
const CUSTOM_TOOL_MUTATION_NAMES = new Set([
  "create_custom_tool",
  "create_privileged_tool",
  "update_custom_tool",
  "delete_custom_tool",
]);

/**
 * Check whether any tool calls in this batch mutated custom tools,
 * and if so, reload the custom tool definitions from MongoDB.
 *
 * @param executedToolCalls — Array of { name, id, args }
 * @param tools             — Live tools object { customToolMap, finalTools }
 * @param project           — Project identifier
 * @param username          — Username
 * @param emit              — SSE event emitter
 * @returns true if tools were reloaded
 */
export async function reloadIfCustomToolsMutated(
  executedToolCalls: any[],
  tools: any,
  project: string,
  username: string,
  emit: any,
): Promise<boolean> {
  const hasMutations = executedToolCalls.some((toolCall: any) =>
    CUSTOM_TOOL_MUTATION_NAMES.has(toolCall.name),
  );

  if (!hasMutations) return false;

  try {
    const database = MongoWrapper.getDb(MONGO_DB_NAME);
    if (!database) return false;

    const freshCustomTools = await database
      .collection("custom_tools")
      .find({ project, username, enabled: true })
      .toArray();

    // Rebuild the customToolMap
    tools.customToolMap.clear();
    for (const customTool of freshCustomTools) {
      tools.customToolMap.set(customTool.name, customTool);
    }

    // Rebuild finalTools: remove old custom tools, add fresh ones
    const builtInTools = tools.finalTools.filter(
      (tool: any) => !tool._isCustom,
    );
    const freshSchemas = freshCustomTools.map((customTool: any) => ({
      name: customTool.name,
      description: customTool.description,
      _isCustom: true,
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          (customTool.parameters || []).map((param: any) => [
            param.name,
            {
              type: param.type || "string",
              description: param.description || "",
              ...(param.enum?.length ? { enum: param.enum } : {}),
            },
          ]),
        ),
        required: (customTool.parameters || [])
          .filter((param: any) => param.required)
          .map((param: any) => param.name),
      },
    }));

    tools.finalTools = [...builtInTools, ...freshSchemas];

    logger.info(
      `[ToolHotReloader] Reloaded ${freshCustomTools.length} custom tool(s) into live session`,
    );

    emit({ type: "status", message: "custom_tools_updated" });
    return true;
  } catch (error: any) {
    logger.warn(
      `[ToolHotReloader] Failed to reload custom tools: ${error.message}`,
    );
    return false;
  }
}

import { getModelByName } from "../config.js";

// ─── LAYOUT CONSTANTS ───────────────────────────────────────

const STEP_WIDTH = 1250;
const INPUT_X_OFFSET = 0;
const CONV_X_OFFSET = 350;
const MODEL_X_OFFSET = 650;
const VIEWER_X_OFFSET = MODEL_X_OFFSET + 350;

// ─── HELPERS ────────────────────────────────────────────────

/**
 * Check if a step is an internal utility/decision step (not user-facing output).
 * These steps are shown in the graph but don't get viewers or chain edges,
 * keeping the graph clean and focused on meaningful output.
 */
function isUtilityStep(step: any) {
  const label = step.label || "";
  // 🧠 prefix = internal decision steps (Emoji React, Image Detection, Fetch Count, etc.)
  return label.startsWith("🧠");
}

/**
 * Build compound port IDs for a conversation input node.
 * Format: "{messageIndex}.{modality}" e.g. "0.text", "1.text", "1.image"
 */
function buildConversationPorts(messages: any, supportedModalities: any = ["text"]) {
  const ports: any[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    ports.push(`${i}.text`);
    if (message.role === "user" || message.role === "assistant") {
      // @ts-ignore
      for ( const mod of supportedModalities) {
        if (mod !== "text") {
          ports.push(`${i}.${mod}`);
        }
      }
    }
  }
  return ports;
}

/**
 * Resolve a model's input/output types from the Prism config.
 * Falls back to step-derived values if the model isn't found in config.
 */
function resolveModelModalities(step: any) {
  const configModel = getModelByName(step.model);
  const isImageGen = step.outputType === "image";

  if (configModel) {
    return {
      label: configModel.label || null,
      inputTypes: configModel.inputTypes || ["text"],
      outputTypes: configModel.outputTypes || ["text"],
      rawInputTypes: configModel.inputTypes || ["text"],
      modelType:
        configModel.modelType || (isImageGen ? "image" : "conversation"),
      supportsSystemPrompt:
        // @ts-ignore
        configModel.supportsSystemPrompt !== undefined
          ? // @ts-ignore
            configModel.supportsSystemPrompt
          : (configModel.outputTypes?.includes("text") ?? true),
    };
  }

  // Fallback: derive from step data
  return {
    inputTypes: ["text"],
    outputTypes: isImageGen ? ["text", "image"] : ["text"],
    rawInputTypes: ["text"],
    modelType: isImageGen ? "image" : "conversation",
    supportsSystemPrompt: true,
  };
}

// ─── MAIN ASSEMBLER ─────────────────────────────────────────

/**
 * Assemble a visual workflow graph from raw step data.
 *
 * Each step produces:
 *   1. Text Input nodes (system prompt + user message)
 *   2. Conversation Input node (groups messages with compound ports)
 *   3. Model node (AI model with config-derived modality ports)
 *
 * Non-utility steps additionally produce:
 *   4. Output Viewer node (displays the model's text/image output)
 *   5. Chain edges (previous output model → this model)
 *
 * Utility steps (🧠 prefix) are shown in the graph but without viewers
 * or chain edges, keeping the visualization focused on output.
 *

 * @returns {{ nodes, edges, nodeResults }}
 */
function assembleGraph(steps: any) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { nodes: [], edges: [], nodeResults: {} };
  }

  // @ts-ignore
  const allNodes: any[] = [];
  // @ts-ignore
  const allEdges: any[] = [];
  const nodeResults = {};

  // Track the last non-utility model ID for chain edges
  // @ts-ignore
  let prevOutputModelId = null;

  steps.forEach((step: any, i: any) => {
    const baseX = 80 + i * STEP_WIDTH;
    const baseY = 80;
    const stepPrefix = `s${i}`;
    let inputY = baseY;
    const utility = isUtilityStep(step);

    const modalities = resolveModelModalities(step);

    // ── 1. Text Input: System Prompt ──
    const sysId = `${stepPrefix}_sys`;
    if (step.systemPrompt) {
      allNodes.push({
        id: sysId,
        nodeType: "input",
        modality: "text",
        content: step.systemPrompt,
        inputTypes: [],
        outputTypes: ["text"],
        position: { x: baseX + INPUT_X_OFFSET, y: inputY },
      });
      inputY += 200;
    }

    // ── 2. Text Input: User Message ──
    const userMsgId = `${stepPrefix}_user`;
    if (step.input) {
      allNodes.push({
        id: userMsgId,
        nodeType: "input",
        modality: "text",
        content: step.input,
        inputTypes: [],
        outputTypes: ["text"],
        position: { x: baseX + INPUT_X_OFFSET, y: inputY },
      });
      inputY += 200;
    }

    // ── 3. Conversation Node ──
    const convId = `${stepPrefix}_conv`;
    const messages: any[] = [];
    if (step.systemPrompt)
      messages.push({ role: "system", content: step.systemPrompt });
    const userMsg = { role: "user", content: step.input || "" };
    messages.push(userMsg);
    if (step.output) {
      const assistantMsg = { role: "assistant", content: step.output };
      // @ts-ignore
      if (step.outputImageRef) assistantMsg.images = [step.outputImageRef];
      messages.push(assistantMsg);
    }

    // Derive conversation supported modalities from the model's raw input types
    const supportedModalities = (modalities.rawInputTypes || ["text"]).filter(
      (t: any) => t !== "conversation",
    );
    const convInputTypes = buildConversationPorts(
      messages,
      supportedModalities,
    );

    allNodes.push({
      id: convId,
      nodeType: "input",
      modality: "conversation",
      messages,
      supportedModalities,
      customName: step.label || undefined,
      inputTypes: convInputTypes,
      outputTypes: ["conversation"],
      position: { x: baseX + CONV_X_OFFSET, y: baseY + 100 },
    });

    // Wire inputs → conversation node
    const sysIdx = 0;
    const userIdx = step.systemPrompt ? 1 : 0;

    if (step.systemPrompt) {
      allEdges.push({
        id: `${stepPrefix}_sys_to_conv`,
        sourceNodeId: sysId,
        targetNodeId: convId,
        sourceModality: "text",
        targetModality: `${sysIdx}.text`,
      });
    }
    if (step.input) {
      allEdges.push({
        id: `${stepPrefix}_user_to_conv`,
        sourceNodeId: userMsgId,
        targetNodeId: convId,
        sourceModality: "text",
        targetModality: `${userIdx}.text`,
      });
    }

    // ── 4. Model Node ──
    const modelId = `${stepPrefix}_model`;
    allNodes.push({
      id: modelId,
      modelName: step.model || "unknown",
      provider: step.type?.toLowerCase() || "unknown",
      displayName: modalities.label || step.model || "Step",
      modelType: modalities.modelType,
      inputTypes: ["conversation"],
      rawInputTypes: modalities.rawInputTypes,
      outputTypes: modalities.outputTypes,
      supportsSystemPrompt: modalities.supportsSystemPrompt,
      position: { x: baseX + MODEL_X_OFFSET, y: baseY + 100 },
      stepMeta: {
        duration: step.duration,
        timestamp: step.timestamp,
        index: step.index,
      },
    });

    // Wire conversation → model
    allEdges.push({
      id: `${stepPrefix}_conv_to_model`,
      sourceNodeId: convId,
      targetNodeId: modelId,
      sourceModality: "conversation",
      targetModality: "conversation",
    });

    // Store model results
    const result = {};
    // @ts-ignore
    if (step.output) result.text = step.output;
    // @ts-ignore
    if (step.outputImageRef) result.image = step.outputImageRef;
    // @ts-ignore
    nodeResults[modelId] = result;

    // ── 5. Output Viewer ──
    {
      const viewerId = `${stepPrefix}_viewer`;
      const viewerResult = {};
      // @ts-ignore
      if (step.output) viewerResult.text = step.output;
      // @ts-ignore
      if (step.outputImageRef) viewerResult.image = step.outputImageRef;

      allNodes.push({
        id: viewerId,
        nodeType: "viewer",
        modality: null,
        // @ts-ignore
        content: viewerResult.text || viewerResult.image || null,
        // @ts-ignore
        contentType: viewerResult.image
          ? "image"
          : // @ts-ignore
            viewerResult.text
            ? "text"
            : null,
        receivedOutputs: viewerResult,
        inputTypes: ["text", "image", "audio"],
        outputTypes: ["text", "image", "audio"],
        position: {
          x: baseX + VIEWER_X_OFFSET,
          y: baseY + 100,
        },
      });

      // Connect model outputs to viewer
      if (step.output) {
        allEdges.push({
          id: `${stepPrefix}_model_to_viewer_text`,
          sourceNodeId: modelId,
          targetNodeId: viewerId,
          sourceModality: "text",
          targetModality: "text",
        });
      }
      if (step.outputImageRef) {
        allEdges.push({
          id: `${stepPrefix}_model_to_viewer_image`,
          sourceNodeId: modelId,
          targetNodeId: viewerId,
          sourceModality: "image",
          targetModality: "image",
        });
      }

      // @ts-ignore
      nodeResults[viewerId] = viewerResult;
    }

    // ── 6. Chain edge from previous output model → this model (non-utility only) ──
    // @ts-ignore
    if (!utility && prevOutputModelId) {
      allEdges.push({
        id: `chain_${prevOutputModelId}_to_${modelId}`,
        sourceNodeId: prevOutputModelId,
        targetNodeId: modelId,
        sourceModality: "text",
        targetModality: "text",
      });
    }

    // Track last non-utility model for chains
    if (!utility) {
      prevOutputModelId = modelId;
    }
  });

  // @ts-ignore
  return { nodes: allNodes, edges: allEdges, nodeResults };
}

export { assembleGraph };

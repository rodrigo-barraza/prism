import AgentHooks from "../../AgentHooks.ts";
import AutoApprovalEngine from "../../AutoApprovalEngine.ts";
import SystemPromptAssembler from "../../SystemPromptAssembler.ts";
import MemoryExtractor from "../../MemoryExtractor.ts";

/**
 * HookInitializer — standardized lifecycle hook wiring for agentic harnesses.
 *
 * Every harness needs the same baseline hooks:
 *   - beforePrompt  → SystemPromptAssembler (builds the system message)
 *   - beforeToolCall → AutoApprovalEngine (determines approval tier)
 *   - afterResponse  → MemoryExtractor (extracts memories from conversation)
 *
 * This module creates and wires them in a single call so harnesses
 * don't duplicate the registration boilerplate.
 */

/**
 * Create a fully wired AgentHooks instance with standard lifecycle hooks.
 *
 * @param options.workspaceRoot — Workspace root for SystemPromptAssembler
 * @param options.autoApprove   — Whether to skip approval gating (full auto mode)
 * @returns {{ hooks, approvalEngine, assembler }}
 */
export function createStandardHooks({
  workspaceRoot,
  autoApprove = false,
}: any = {}) {
  const hooks = new AgentHooks();

  const approvalEngine = new AutoApprovalEngine({
    fullAuto: autoApprove === true,
  });
  hooks.register(
    "beforeToolCall",
    approvalEngine.createHook(),
    "AutoApprovalEngine",
  );

  const assembler = new SystemPromptAssembler({
    workspaceRoot: workspaceRoot || undefined,
  });
  hooks.register(
    "beforePrompt",
    assembler.createHook(),
    "SystemPromptAssembler",
  );

  hooks.register(
    "afterResponse",
    MemoryExtractor.createHook(),
    "MemoryExtractor",
  );

  return { hooks, approvalEngine, assembler };
}

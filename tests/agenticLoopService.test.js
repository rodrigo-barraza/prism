import { describe, it, expect, beforeEach, vi } from "vitest";
import AgenticLoopService from "../src/services/AgenticLoopService.js";
import ContextWindowManager from "../src/utils/ContextWindowManager.js";
import { TYPES } from "../src/config.js";

vi.mock("../src/utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    success: vi.fn(),
    request: vi.fn(),
  },
}));

vi.mock("../src/services/ToolOrchestratorService.js", () => ({
  default: {
    ensureSchemas: vi.fn().mockResolvedValue(),
    getToolSchemas: vi.fn().mockReturnValue([
      { name: "web_search", description: "Search the web" },
      { name: "read_file", description: "Read a file" },
      { name: "generate_image", description: "Generate image" },
      { name: "describe_image", description: "Describe image" },
    ]),
    getClientToolSchemas: vi.fn().mockReturnValue([
      { name: "web_search", domain: "knowledge", labels: ["safe"] },
      { name: "read_file", domain: "system", labels: ["safe"] },
    ]),
    getMCPToolSchemas: vi.fn().mockReturnValue([]),
  },
}));

vi.mock("../src/wrappers/MongoWrapper.js", () => ({
  default: {
    getClient: vi.fn().mockReturnValue({
      db: vi.fn().mockReturnValue({
        collection: vi.fn().mockReturnValue({
          find: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
  },
}));

vi.mock("../src/services/FileService.js", () => ({
  default: {
    uploadFile: vi.fn().mockResolvedValue({ ref: "minio-ref" }),
  },
}));

vi.mock("../src/services/RequestLogger.js", () => ({
  default: {
    logChatGeneration: vi.fn().mockResolvedValue(),
  },
}));

vi.mock("../src/services/local-tools/InternalToolRegistry.js", () => ({
  default: {
    getNames: vi.fn().mockReturnValue(new Set()),
  },
}));

vi.mock("../src/utils/ContextWindowManager.js", () => ({
  default: {
    enforce: vi.fn().mockImplementation((messages) => ({
      truncated: false,
      messages,
      strategy: "none",
      estimatedTokens: 10,
    })),
  },
}));

vi.mock("../src/services/SessionGenerationTracker.js", () => ({
  default: {
    register: vi.fn(),
    update: vi.fn(),
    recordChunkTiming: vi.fn(),
    complete: vi.fn(),
    cleanup: vi.fn(),
    getSessionStats: vi.fn().mockReturnValue({
      activeRequests: 0,
      totalOutputTokens: 10,
      totalInputTokens: 5,
      totalTokens: 15,
      tokPerSec: 20,
      avgTtft: 0.5,
    }),
  },
}));

vi.mock("../src/services/SystemPromptAssembler.js", () => ({
  default: class {
    constructor() {}
    createHook() {
      return async () => {};
    }
  },
}));

describe("AgenticLoopService", () => {
  let mockProvider;
  let mockCtx;
  let emittedEvents;

  beforeEach(() => {
    emittedEvents = [];
    
    mockProvider = {
      generateTextStream: vi.fn().mockImplementation(async function* () {
        yield "Hello";
        yield " World";
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
      }),
    };

    mockCtx = {
      provider: mockProvider,
      providerName: "test-provider",
      resolvedModel: "test-model",
      modelDef: {
        maxInputTokens: 10000,
        inputTypes: [TYPES.TEXT],
        outputTypes: [TYPES.TEXT],
      },
      messages: [{ role: "user", content: "Hi" }],
      options: {
        maxIterations: 1,
      },
      agentSessionId: "session-123",
      parentAgentSessionId: null,
      traceId: "trace-123",
      project: "test-project",
      username: "test-user",
      emit: vi.fn((event) => emittedEvents.push(event)),
      signal: new AbortController().signal,
    };
  });

  it("should execute a single loop and emit chunks", async () => {
    await AgenticLoopService.runAgenticLoop(mockCtx);

    expect(mockCtx.emit).toHaveBeenCalled();
    const chunks = emittedEvents.filter(e => e.type === "chunk");
    expect(chunks.length).toBe(2);
    expect(chunks[0].content).toBe("Hello");
    expect(chunks[1].content).toBe(" World");
  });

  it("should filter out native web_search tool if options.webSearch is true", async () => {
    mockCtx.options.webSearch = true;
    mockCtx.options.enabledTools = ["web_search", "read_file"];

    await AgenticLoopService.runAgenticLoop(mockCtx);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][2];
    const passTools = callArgs.tools;
    
    expect(passTools.find(t => t.name === "web_search")).toBeUndefined();
    expect(passTools.find(t => t.name === "read_file")).toBeDefined();
  });

  it("should filter out generate_image if model natively outputs images", async () => {
    mockCtx.modelDef.outputTypes = [TYPES.TEXT, TYPES.IMAGE];
    mockCtx.options.enabledTools = ["generate_image", "read_file"];

    await AgenticLoopService.runAgenticLoop(mockCtx);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][2];
    const passTools = callArgs.tools;
    
    expect(passTools.find(t => t.name === "generate_image")).toBeUndefined();
    expect(passTools.find(t => t.name === "read_file")).toBeDefined();
  });

  it("should filter out describe_image if model natively inputs images", async () => {
    mockCtx.modelDef.inputTypes = [TYPES.TEXT, TYPES.IMAGE];
    mockCtx.options.enabledTools = ["describe_image", "read_file"];

    await AgenticLoopService.runAgenticLoop(mockCtx);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][2];
    const passTools = callArgs.tools;
    
    expect(passTools.find(t => t.name === "describe_image")).toBeUndefined();
    expect(passTools.find(t => t.name === "read_file")).toBeDefined();
  });

  it("should expand domain and label selectors for enabledTools", async () => {
    mockCtx.options.enabledTools = ["domain:knowledge"];

    await AgenticLoopService.runAgenticLoop(mockCtx);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][2];
    const passTools = callArgs.tools;
    
    // getClientToolSchemas returns web_search as domain:knowledge
    expect(passTools.length).toBeGreaterThan(0);
    expect(passTools.find(t => t.name === "web_search")).toBeDefined();
  });

  it("should handle context truncation", async () => {
    ContextWindowManager.enforce.mockReturnValueOnce({
      truncated: true,
      messages: [{ role: "user", content: "Truncated" }],
      strategy: "oldest",
      estimatedTokens: 5,
    });

    await AgenticLoopService.runAgenticLoop(mockCtx);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][0];
    expect(callArgs[0].content).toBe("Truncated");
    
    const truncationEvents = emittedEvents.filter(e => e.message === "context_truncated");
    expect(truncationEvents.length).toBe(1);
  });
  
  it("should properly support plan mode", async () => {
    mockCtx.options.planFirst = true;

    await AgenticLoopService.runAgenticLoop(mockCtx);

    const callArgs = mockProvider.generateTextStream.mock.calls[0][2];
    const passTools = callArgs.tools;
    
    // Should only have exit_plan_mode
    expect(passTools.every(t => t.name === "exit_plan_mode")).toBe(true);
    
    const enterEvents = emittedEvents.filter(e => e.message === "plan_mode_entered");
    expect(enterEvents.length).toBe(1);
  });

  it("should emit generation_started and generation_progress on thinking chunks", async () => {
    mockProvider.generateTextStream.mockImplementation(async function* () {
      yield { type: "thinking", content: "Thinking..." };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
    });

    await AgenticLoopService.runAgenticLoop(mockCtx);

    const thinkingEvents = emittedEvents.filter(e => e.type === "thinking");
    expect(thinkingEvents.length).toBeGreaterThan(0);
    expect(thinkingEvents[0].content).toBe("Thinking...");

    const startedEvents = emittedEvents.filter(e => e.message === "generation_started");
    expect(startedEvents.length).toBeGreaterThan(0);
  });

  it("should drop tool calls not in the allowed schema", async () => {
    mockCtx.options.enabledTools = ["read_file"];
    mockProvider.generateTextStream.mockImplementation(async function* () {
      // Mock yielding a tool call that is not in the enabled schema
      yield { type: "toolCall", name: "dangerous_tool", args: {} };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
    });

    await AgenticLoopService.runAgenticLoop(mockCtx);

    const toolExecutionEvents = emittedEvents.filter(e => e.type === "tool_execution");
    // Should be 0 since dangerous_tool is not allowed and dropped
    expect(toolExecutionEvents.length).toBe(0);
  });

  it("should handle native MCP tool call streaming directly", async () => {
    mockProvider.generateTextStream.mockImplementation(async function* () {
      yield { 
        type: "toolCall", 
        name: "mcp__server__tool", 
        args: { foo: "bar" }, 
        native: true, 
        status: "calling",
        id: "mcp-1"
      };
      yield { type: "usage", usage: { inputTokens: 5, outputTokens: 2 } };
    });

    await AgenticLoopService.runAgenticLoop(mockCtx);

    const toolCallEvents = emittedEvents.filter(e => e.type === "toolCall");
    expect(toolCallEvents.length).toBe(1);
    expect(toolCallEvents[0].name).toBe("mcp__server__tool");
    expect(toolCallEvents[0].args).toEqual({ foo: "bar" });
    
    // Ensure it didn't queue a standard tool_execution
    const toolExecutionEvents = emittedEvents.filter(e => e.type === "tool_execution");
    expect(toolExecutionEvents.length).toBe(0);
  });
});

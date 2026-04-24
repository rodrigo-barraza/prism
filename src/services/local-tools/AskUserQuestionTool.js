import logger from "../../utils/logger.js";

export default {
  name: "ask_user_question",
  schema: {
    name: "ask_user_question",
    description:
      "Ask the user a question and wait for their response before continuing. " +
      "Use this when you need clarification, a decision between options, or explicit " +
      "confirmation before proceeding with a potentially impactful action. " +
      "The agent loop pauses until the user responds.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to present to the user." },
        choices: { type: "array", items: { type: "string" }, description: "Optional: predefined answer choices." },
        context: { type: "string", description: "Optional: additional context shown below the question." },
      },
      required: ["question"],
    },
  },
  domain: "Agentic: Control Flow",
  labels: ["coding"],

  async execute(args, ctx) {
    const { question, choices, context: questionContext } = args;
    if (!question || typeof question !== "string") {
      return { error: "'question' is required and must be a non-empty string" };
    }
    const sessionId = ctx.agentSessionId;
    if (!sessionId) {
      return { error: "No agent session — ask_user_question requires an active session" };
    }
    logger.info(`[AskUserQuestion] "${question.slice(0, 80)}${question.length > 80 ? "..." : ""}" (${choices?.length || 0} choices)`);
    if (ctx._emit) {
      ctx._emit({ type: "user_question", question, choices: choices || [], context: questionContext || null });
    }
    const { default: AgenticLoopService } = await import("../AgenticLoopService.js");
    const answer = await new Promise((resolve) => {
      const timeoutId = setTimeout(() => resolve({ answer: null, timedOut: true }), 300_000);
      AgenticLoopService._setPendingQuestion(sessionId, {
        resolve: (val) => { clearTimeout(timeoutId); resolve(val); },
        question,
        choices: choices || [],
      });
    });
    if (answer.timedOut) {
      logger.warn(`[AskUserQuestion] Timed out after 5 minutes`);
      return { answer: null, timedOut: true, message: "The user did not respond within 5 minutes." };
    }
    logger.info(`[AskUserQuestion] Answered: "${String(answer.answer).slice(0, 80)}"`);
    return { answer: answer.answer, question };
  },
};

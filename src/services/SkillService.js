import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import { COLLECTIONS } from "../constants.js";
import logger from "../utils/logger.js";

// ────────────────────────────────────────────────────────────
// SkillService — Reusable Workflow Templates
// ────────────────────────────────────────────────────────────
// Skills are stored multi-step workflow templates that the
// agent can invoke by name. Each skill defines:
//   - A prompt template (with {{variable}} interpolation)
//   - A list of steps (optional — for documentation)
//   - Execution parameters (model, tools, max iterations)
//
// Skills live in the `agent_skills` MongoDB collection and
// are executed by spawning an AgenticLoopService run with
// the skill's prompt + configuration.
//
// This is the SkillTool pattern from Claude Code — reusable
// agentic workflows stored as atomic operations.
// ────────────────────────────────────────────────────────────

/** @returns {import("mongodb").Collection} */
function getCollection() {
  return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.AGENT_SKILLS);
}

const SkillService = {
  /**
   * Create a new skill.
   *
   * @param {object} data
   * @param {string} data.name - Unique skill name (e.g. "refactor_and_test")
   * @param {string} data.description - What the skill does
   * @param {string} data.prompt - Prompt template. Use {{variable}} for interpolation.
   * @param {string[]} [data.steps] - Ordered step descriptions (for documentation)
   * @param {string[]} [data.tools] - Tools to enable for the skill run (default: all)
   * @param {number} [data.maxIterations] - Max loop iterations (default: 25)
   * @param {string} [data.model] - Model override for the skill run
   * @param {string} [data.project] - Project scope
   * @param {string} [data.agent] - Agent persona override
   * @returns {Promise<object>}
   */
  async create(data) {
    const col = getCollection();
    if (!col) throw new Error("Database not available");

    const { name, description, prompt, steps, tools, maxIterations, model, project, agent } = data;

    if (!name || typeof name !== "string") {
      return { error: "'name' is required (string)" };
    }
    if (!prompt || typeof prompt !== "string") {
      return { error: "'prompt' is required (string)" };
    }

    // Derive a stable skill ID
    const skillId = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

    // Check for duplicate
    const existing = await col.findOne({ skillId });
    if (existing) {
      return { error: `Skill "${skillId}" already exists. Delete it first or use a different name.` };
    }

    const doc = {
      skillId,
      name,
      description: description || "",
      prompt,
      steps: Array.isArray(steps) ? steps : [],
      tools: Array.isArray(tools) ? tools : null, // null = all tools
      maxIterations: typeof maxIterations === "number" ? Math.min(100, Math.max(1, maxIterations)) : 25,
      model: model || null,
      project: project || null,
      agent: agent || null,
      usageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await col.insertOne(doc);
    logger.info(`[SkillService] Created skill "${name}" (${skillId})`);

    return {
      skill: sanitize(doc),
      message: `Skill "${name}" created. Execute with skill_execute({ skillId: "${skillId}" }).`,
    };
  },

  /**
   * List all skills.
   * @param {object} [options]
   * @param {string} [options.project] - Filter by project
   * @param {number} [options.limit] - Max results
   * @returns {Promise<object>}
   */
  async list({ project, limit = 50 } = {}) {
    const col = getCollection();
    if (!col) return { skills: [], total: 0 };

    const filter = {};
    if (project) filter.project = project;

    const skills = await col
      .find(filter)
      .sort({ usageCount: -1, name: 1 })
      .limit(Math.min(limit, 100))
      .toArray();

    return {
      skills: skills.map(sanitize),
      total: skills.length,
    };
  },

  /**
   * Get a single skill by skillId.
   * @param {string} skillId
   * @returns {Promise<object|null>}
   */
  async get(skillId) {
    const col = getCollection();
    if (!col) return null;
    const doc = await col.findOne({ skillId });
    return doc ? sanitize(doc) : null;
  },

  /**
   * Delete a skill by skillId.
   * @param {string} skillId
   * @returns {Promise<object>}
   */
  async delete(skillId) {
    const col = getCollection();
    if (!col) return { error: "Database not available" };

    const doc = await col.findOne({ skillId });
    if (!doc) {
      return { error: `Skill "${skillId}" not found` };
    }

    await col.deleteOne({ skillId });
    logger.info(`[SkillService] Deleted skill "${doc.name}" (${skillId})`);

    return { deleted: true, skillId, name: doc.name };
  },

  /**
   * Execute a skill — interpolates variables, increments usage, and
   * returns the assembled prompt + config for the agentic loop.
   *
   * The caller (ToolOrchestratorService) is responsible for actually
   * running the agentic loop with the returned config.
   *
   * @param {string} skillId
   * @param {object} [variables] - Key-value pairs for {{variable}} interpolation
   * @returns {Promise<object>} { prompt, config } or { error }
   */
  async prepare(skillId, variables = {}) {
    const col = getCollection();
    if (!col) return { error: "Database not available" };

    const doc = await col.findOne({ skillId });
    if (!doc) {
      return { error: `Skill "${skillId}" not found. Use skill_list to see available skills.` };
    }

    // Interpolate variables into the prompt template
    let prompt = doc.prompt;
    for (const [key, value] of Object.entries(variables)) {
      prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
    }

    // Warn about unresolved variables
    const unresolvedMatch = prompt.match(/\{\{(\w+)\}\}/g);
    const unresolved = unresolvedMatch ? [...new Set(unresolvedMatch.map((m) => m.slice(2, -2)))] : [];

    // Increment usage counter
    await col.updateOne(
      { skillId },
      { $inc: { usageCount: 1 }, $set: { updatedAt: new Date().toISOString() } },
    );

    const config = {
      maxIterations: doc.maxIterations || 25,
      model: doc.model || null,
      tools: doc.tools || null, // null = all tools
      agent: doc.agent || null,
      project: doc.project || null,
    };

    return {
      skillId,
      name: doc.name,
      prompt,
      config,
      unresolved: unresolved.length > 0 ? unresolved : undefined,
      steps: doc.steps?.length > 0 ? doc.steps : undefined,
    };
  },
};

function sanitize(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

export default SkillService;

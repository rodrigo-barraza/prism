import { ObjectId } from "mongodb";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import { COLLECTIONS } from "../constants.js";
import logger from "../utils/logger.js";

// ────────────────────────────────────────────────────────────
// CustomAgentService — CRUD for user-defined agent personas
//
// Stores custom agents in the `custom_agents` collection.
// Each document defines an agent persona that gets registered
// into AgentPersonaRegistry at runtime.
// ────────────────────────────────────────────────────────────

/**
 * Derive a stable agent ID from a display name.
 * Always uppercased and prefixed with CUSTOM_ to avoid collisions.
 * @param {string} name
 * @returns {string}
 */
function deriveAgentId(name) {
  const slug = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `CUSTOM_${slug}`;
}

/** @returns {import("mongodb").Collection} */
function getCollection() {
  return MongoWrapper.getCollection(MONGO_DB_NAME, COLLECTIONS.CUSTOM_AGENTS);
}

const CustomAgentService = {
  /**
   * List all custom agents.
   * @returns {Promise<Array>}
   */
  async list() {
    const col = getCollection();
    if (!col) return [];
    return col.find({}).sort({ createdAt: -1 }).toArray();
  },

  /**
   * Get a single custom agent by MongoDB _id.
   * @param {string} id
   * @returns {Promise<object|null>}
   */
  async get(id) {
    const col = getCollection();
    if (!col) return null;
    return col.findOne({ _id: new ObjectId(id) });
  },

  /**
   * Get a custom agent by its derived agentId.
   * @param {string} agentId - e.g. "CUSTOM_MY_AGENT"
   * @returns {Promise<object|null>}
   */
  async getByAgentId(agentId) {
    const col = getCollection();
    if (!col) return null;
    return col.findOne({ agentId });
  },

  /**
   * Create a new custom agent.
   * @param {object} data - { name, description?, project?, identity, guidelines?, toolPolicy?, enabledTools?, usesDirectoryTree?, usesCodingGuidelines? }
   * @returns {Promise<object>} The created document
   */
  async create(data) {
    const col = getCollection();
    if (!col) throw new Error("Database not available");

    const agentId = deriveAgentId(data.name);

    // Check for duplicate agentId
    const existing = await col.findOne({ agentId });
    if (existing) {
      throw new Error(`Agent with ID "${agentId}" already exists`);
    }

    const doc = {
      name: data.name,
      agentId,
      description: data.description || "",
      project: data.project || "coding",
      identity: data.identity || "",
      guidelines: data.guidelines || "",
      toolPolicy: data.toolPolicy || "",
      enabledTools: Array.isArray(data.enabledTools) ? data.enabledTools : [],
      usesDirectoryTree: data.usesDirectoryTree || false,
      usesCodingGuidelines: data.usesCodingGuidelines || false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const result = await col.insertOne(doc);
    logger.info(`[CustomAgentService] Created agent "${doc.name}" (${doc.agentId})`);
    return { ...doc, _id: result.insertedId };
  },

  /**
   * Update an existing custom agent.
   * @param {string} id - MongoDB _id
   * @param {object} updates - Partial fields to update
   * @returns {Promise<object>} The updated document
   */
  async update(id, updates) {
    const col = getCollection();
    if (!col) throw new Error("Database not available");

    // If name changed, re-derive agentId
    const setFields = { ...updates, updatedAt: new Date().toISOString() };
    if (updates.name) {
      setFields.agentId = deriveAgentId(updates.name);
    }

    // Remove _id from $set if present
    delete setFields._id;

    await col.updateOne(
      { _id: new ObjectId(id) },
      { $set: setFields },
    );

    const updated = await col.findOne({ _id: new ObjectId(id) });
    logger.info(`[CustomAgentService] Updated agent "${updated?.name}" (${updated?.agentId})`);
    return updated;
  },

  /**
   * Delete a custom agent.
   * @param {string} id - MongoDB _id
   * @returns {Promise<boolean>}
   */
  async delete(id) {
    const col = getCollection();
    if (!col) throw new Error("Database not available");

    const doc = await col.findOne({ _id: new ObjectId(id) });
    const result = await col.deleteOne({ _id: new ObjectId(id) });
    if (doc) {
      logger.info(`[CustomAgentService] Deleted agent "${doc.name}" (${doc.agentId})`);
    }
    return result.deletedCount > 0;
  },
};

export default CustomAgentService;

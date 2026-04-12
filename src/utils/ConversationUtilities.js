import ConversationService from "../services/ConversationService.js";
import logger from "./logger.js";

// ============================================================
// Conversation persistence helpers
// ============================================================

/**
 * Mark a conversation as generating (or not). Fire-and-forget with
 * error logging — the caller should not await or chain on this.
 *
 * @param {string}  conversationId
 * @param {string}  project
 * @param {string}  username
 * @param {boolean} generating
 * @param {object}  [opts]
 * @param {string}  [opts.collection] - Override MongoDB collection
 */
export function markGenerating(conversationId, project, username, generating, opts) {
  if (!conversationId) return;
  ConversationService.setGenerating(
    conversationId,
    project,
    username,
    generating,
    opts,
  ).catch((err) =>
    logger.error(
      `Failed to ${generating ? "set" : "clear"} isGenerating: ${err.message}`,
    ),
  );
}

/**
 * Append messages to a conversation and clear the isGenerating flag.
 * Fire-and-forget with error logging.
 *
 * @param {string}        conversationId
 * @param {string}        project
 * @param {string}        username
 * @param {Array<object>} messagesToAppend
 * @param {object|undefined} meta - conversationMeta with settings
 * @param {object}  [opts]
 * @param {string}  [opts.collection] - Override MongoDB collection
 */
export function appendAndFinalize(conversationId, project, username, messagesToAppend, meta, opts) {
  if (!conversationId) return;
  ConversationService.appendMessages(
    conversationId,
    project,
    username,
    messagesToAppend,
    meta,
    opts,
  )
    .then(() =>
      ConversationService.setGenerating(
        conversationId,
        project,
        username,
        false,
        opts,
      ),
    )
    .catch((err) =>
      logger.error(
        `Failed to append messages to conversation ${conversationId}: ${err.message}`,
      ),
    );
}

import ConversationService from "../services/ConversationService.js";
import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../config.js";
import logger from "./logger.js";

// ─── Conversation persistence helpers ───────────────────────

/**
 * Persist a diagnostic event to MongoDB for post-mortem analysis.
 * Best-effort: never throws, never blocks the caller.
 */
function logDiagnostic(data) {
  try {
    const db = MongoWrapper.getDb(MONGO_DB_NAME);
    if (db) {
      db.collection("_persistence_diagnostics").insertOne({
        ...data,
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }
  } catch { /* best-effort */ }
}

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
 * IMPORTANT: isGenerating is always cleared, even when appendMessages
 * fails — preventing sessions from being permanently stuck as
 * "generating" when the $push operation encounters BSON errors or
 * connectivity issues.
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

  const collection = opts?.collection || "conversations";
  const msgCount = messagesToAppend?.length ?? 0;
  const msgRoles = (messagesToAppend || []).map((m) => m.role).join(",");

  // Log entry — proves appendAndFinalize was called with the right args
  logDiagnostic({
    event: "appendAndFinalize_called",
    conversationId,
    project,
    username,
    collection,
    messageCount: msgCount,
    messageRoles: msgRoles,
    metaTitle: meta?.title,
    hasParentSession: !!meta?.parentAgentSessionId,
  });

  ConversationService.appendMessages(
    conversationId,
    project,
    username,
    messagesToAppend,
    meta,
    opts,
  )
    .then((result) => {
      // Log success — proves appendMessages completed
      logDiagnostic({
        event: "appendMessages_success",
        conversationId,
        project,
        collection,
        savedMessageCount: result?.messages?.length ?? "unknown",
      });
      return ConversationService.setGenerating(
        conversationId,
        project,
        username,
        false,
        opts,
      );
    })
    .catch((err) => {
      logger.error(
        `Failed to append ${msgCount} messages to ${conversationId} ` +
        `(project=${project}, collection=${collection}): ${err.message}`,
      );
      // Log failure with full context
      logDiagnostic({
        event: "appendMessages_error",
        conversationId,
        project,
        username,
        collection,
        messageCount: msgCount,
        error: err.message,
        stack: err.stack?.slice(0, 2000),
      });

      // Always clear isGenerating even on failure — prevents sessions
      // from being permanently stuck as "generating" on the next page load.
      ConversationService.setGenerating(
        conversationId,
        project,
        username,
        false,
        opts,
      ).catch((clearErr) =>
        logger.error(
          `Failed to clear isGenerating after append failure: ${clearErr.message}`,
        ),
      );
    });
}

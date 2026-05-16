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
export declare function markGenerating(conversationId: any, project: any, username: any, generating: any, opts: any): void;
/**
 * Append messages to a conversation and clear the isGenerating flag.
 * Fire-and-forget with error logging.
 *
 * IMPORTANT: isGenerating is always cleared, even when appendMessages
 * fails — preventing sessions from being permanently stuck as
 * "generating" when the $push operation encounters errors.
 *
 * @param {string}        conversationId
 * @param {string}        project
 * @param {string}        username
 * @param {Array<object>} messagesToAppend
 * @param {object|undefined} meta - conversationMeta with settings
 * @param {object}  [opts]
 * @param {string}  [opts.collection] - Override MongoDB collection
 */
export declare function appendAndFinalize(conversationId: any, project: any, username: any, messagesToAppend: any, meta: any, opts: any): void;
//# sourceMappingURL=ConversationUtilities.d.ts.map
/**
 * Upload any base64 data URLs in message images/audio to external storage.
 * Replaces inline data with minio:// refs when MinIO is available.
 * @param {Array} messages
 * @param {string} project
 * @param {string} username
 * @returns {Promise<Array>} messages with refs replacing inline data
 */
export declare function extractFiles(messages: any, project?: any, username?: any): Promise<any>;
/**
 * Compute input/output modalities from messages for lightweight querying.
 * @param {Array} messages
 * @returns {Object} modalities flags
 */
export declare function computeModalities(messages: any): {
    textIn: boolean;
    textOut: boolean;
    imageIn: boolean;
    imageOut: boolean;
    audioIn: boolean;
    audioOut: boolean;
    docIn: boolean;
    webSearch: boolean;
    codeExecution: boolean;
    functionCalling: boolean;
    thinking: boolean;
};
/**
 * Extract unique providers from messages and settings.
 * @param {Array} messages
 * @param {Object} settings
 * @returns {string[]}
 */
export declare function extractProviders(messages: any, settings: any): unknown[];
/**
 * Compute total estimated cost across all messages.
 * @param {Array} messages
 * @returns {number}
 */
export declare function computeTotalCost(messages: any): number;
/**
 * Build the $set fields for a conversation/agent-session PATCH request.
 * Centralises the identical logic shared by conversations.js and agent-sessions.js.
 *
 * @param {object} body - req.body from the PATCH request
 * @returns {object} $set fields ready for updateOne
 */
export declare function buildConversationPatchFields({ title, messages, systemPrompt, settings, }: any): {
    updatedAt: string;
};
/**
 * ConversationService — shared logic for managing conversations in MongoDB.
 * Used by both the conversations REST API and generation routes.
 */
declare const ConversationService: {
    /**
       * Append messages to a conversation, auto-creating it if it doesn't exist.
       * Handles file extraction (MinIO upload) and recomputes derived fields.
       * Optionally applies conversation metadata (title, systemPrompt, settings).
       *
       * @param {string} conversationId
       * @param {string} project
       * @param {string} username
       * @param {Array} newMessages - Messages to append
       * @param {object} [conversationMeta] - Optional metadata to set on the conversation
       * @param {string} [conversationMeta.title]
       * @param {string} [conversationMeta.systemPrompt]
       * @param {object} [conversationMeta.settings]
  
       * @returns {Promise<object>} The updated conversation document
       */
    appendMessages(conversationId: any, project: any, username: any, newMessages: any, conversationMeta?: any, { collection }?: {
        collection?: string;
    }): Promise<{
        modalities: {
            textIn: boolean;
            textOut: boolean;
            imageIn: boolean;
            imageOut: boolean;
            audioIn: boolean;
            audioOut: boolean;
            docIn: boolean;
            webSearch: boolean;
            codeExecution: boolean;
            functionCalling: boolean;
            thinking: boolean;
        };
        providers: unknown[];
        totalCost: number;
        _id: import("bson").ObjectId;
    }>;
    /**
     * Set or clear the isGenerating flag on a conversation.
     * Lightweight update — only touches isGenerating + updatedAt.
     *
     * @param {string} conversationId
     * @param {string} project
     * @param {string} username
     * @param {boolean} generating
     */
    setGenerating(conversationId: any, project: any, username: any, generating: any, { collection }?: {
        collection?: string;
    }): Promise<void>;
};
export default ConversationService;
//# sourceMappingURL=ConversationService.d.ts.map
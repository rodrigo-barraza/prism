import MongoWrapper from "../wrappers/MongoWrapper.js";
import { MONGO_DB_NAME } from "../../secrets.js";
import logger from "../utils/logger.js";
import { COLLECTIONS } from "../constants.js";

/**
 * ChangeStreamService — watches MongoDB collections via Change Streams
 * and broadcasts lightweight events to registered listeners.
 *
 * Requires MongoDB to be running as a replica set. If Change Streams are
 * not available (standalone mode), the service logs a warning and sets
 * `available = false` — callers should fall back to polling.
 */

/** @type {Set<Function>} */
const listeners = new Set();

/** @type {Map<string, import('mongodb').ChangeStream>} */
const streams = new Map();

let available = false;
let staleGeneratingInterval = null;

// Collections to watch
const WATCHED_COLLECTIONS = [COLLECTIONS.CONVERSATIONS, COLLECTIONS.SESSIONS, COLLECTIONS.REQUESTS];

/**
 * Attempt to open a Change Stream on a single collection.
 * Returns the stream if successful, null otherwise.
 */
function openStream(db, collectionName) {
  try {
    const collection = db.collection(collectionName);
    const stream = collection.watch([], { fullDocument: "updateLookup" });

    stream.on("change", (event) => {
      const payload = {
        collection: collectionName,
        operationType: event.operationType,
        documentId: event.documentKey?._id?.toString() || null,
        // For inserts/updates, include the document ID field if available
        id: event.fullDocument?.id || null,
        updatedFields: event.updateDescription?.updatedFields
          ? Object.keys(event.updateDescription.updatedFields)
          : null,
        timestamp: new Date().toISOString(),
      };

      // Enrich with isGenerating state for conversations
      if (collectionName === COLLECTIONS.CONVERSATIONS) {
        if (event.updateDescription?.updatedFields?.isGenerating !== undefined) {
          payload.isGenerating = event.updateDescription.updatedFields.isGenerating;
        } else if (event.fullDocument?.isGenerating !== undefined) {
          payload.isGenerating = event.fullDocument.isGenerating;
        }
      }

      // Broadcast to all registered listeners
      for (const listener of listeners) {
        try {
          listener(payload);
        } catch (err) {
          logger.error(`ChangeStream listener error: ${err.message}`);
        }
      }
    });

    stream.on("error", (err) => {
      logger.error(
        `ChangeStream error on ${collectionName}: ${err.message}`,
      );
      // Attempt to re-open after a delay
      streams.delete(collectionName);
      setTimeout(() => {
        const db = MongoWrapper.getClient(MONGO_DB_NAME)?.db(MONGO_DB_NAME);
        if (db) {
          const reopened = openStream(db, collectionName);
          if (reopened) {
            streams.set(collectionName, reopened);
            logger.info(`ChangeStream re-opened on ${collectionName}`);
          }
        }
      }, 5000);
    });

    return stream;
  } catch {
    return null;
  }
}

const ChangeStreamService = {
  /**
   * Whether Change Streams are available (replica set detected).
   */
  get available() {
    return available;
  },

  /**
   * Initialize Change Streams on all watched collections.
   * Call this after MongoDB is connected.
   */
  async init() {
    const client = MongoWrapper.getClient(MONGO_DB_NAME);
    if (!client) {
      logger.warn("ChangeStreamService: No MongoDB client available");
      return;
    }

    const db = client.db(MONGO_DB_NAME);

    // Test if Change Streams are supported by opening a brief watch
    try {
      const testStream = db.collection(WATCHED_COLLECTIONS[0]).watch();
      // If watch() succeeds without throwing, Change Streams are supported.
      // We need to close this test stream and open real ones.
      await testStream.close();
    } catch (err) {
      logger.warn(
        `Change Streams not available (${err.message}). ` +
        "Admin dashboard will fall back to polling. " +
        "To enable Change Streams, configure MongoDB as a replica set.",
      );
      available = false;
      return;
    }

    // Open streams on all watched collections
    for (const col of WATCHED_COLLECTIONS) {
      const stream = openStream(db, col);
      if (stream) {
        streams.set(col, stream);
        logger.info(`ChangeStream active: ${col}`);
      }
    }

    available = true;
    logger.success(
      `Change Streams active on ${streams.size} collection(s): ${[...streams.keys()].join(", ")}`,
    );

    // Periodic stale isGenerating cleanup (every 60s)
    // Catches flags left behind by crashed requests or dropped connections
    staleGeneratingInterval = setInterval(async () => {
      try {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const { modifiedCount } = await db
          .collection(COLLECTIONS.CONVERSATIONS)
          .updateMany(
            { isGenerating: true, updatedAt: { $lt: fiveMinAgo } },
            { $set: { isGenerating: false } },
          );
        if (modifiedCount > 0) {
          logger.info(`Auto-cleared ${modifiedCount} stale isGenerating flag(s)`);
        }
      } catch {
        // ignore
      }
    }, 60000);
  },

  /**
   * Register a listener for collection change events.
   * @param {Function} callback - (event) => void
   */
  subscribe(callback) {
    listeners.add(callback);
  },

  /**
   * Unregister a listener.
   * @param {Function} callback
   */
  unsubscribe(callback) {
    listeners.delete(callback);
  },

  /**
   * Close all Change Streams. Call on shutdown.
   */
  async close() {
    for (const [name, stream] of streams) {
      try {
        await stream.close();
        logger.info(`ChangeStream closed: ${name}`);
      } catch {
        // ignore
      }
    }
    streams.clear();
    listeners.clear();
    if (staleGeneratingInterval) {
      clearInterval(staleGeneratingInterval);
      staleGeneratingInterval = null;
    }
    available = false;
  },
};

export default ChangeStreamService;

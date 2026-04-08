import { MongoClient } from "mongodb";
import logger from "../utils/logger.js";

const clients = new Map();

const MongoWrapper = {
  async createClient(name, uri) {
    try {
      const client = new MongoClient(uri);
      await client.connect();
      clients.set(name, client);
      logger.success(`MongoDB connected: ${name}`);
      return client;
    } catch (error) {
      logger.error(`MongoDB connection failed: ${name}`, error);
      throw error;
    }
  },
  getClient(name) {
    return clients.get(name);
  },
  /**
   * Get the database instance for a named connection.
   * Shorthand for `getClient(name)?.db(name)`.
   *
   * @param {string} name - Connection/database name
   * @returns {import("mongodb").Db|null}
   */
  getDb(name) {
    const client = clients.get(name);
    return client ? client.db(name) : null;
  },
  /**
   * Get a collection from a named connection.
   * Throws if the database is not available.
   *
   * @param {string} dbName - Connection/database name
   * @param {string} collectionName - Collection name
   * @returns {import("mongodb").Collection}
   */
  getCollection(dbName, collectionName) {
    const client = clients.get(dbName);
    if (!client) throw new Error("Database not available");
    return client.db(dbName).collection(collectionName);
  },
  closeClient(name) {
    const client = clients.get(name);
    if (client) {
      client.close();
      clients.delete(name);
    }
  },
};

export default MongoWrapper;

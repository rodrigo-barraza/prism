import { Client } from "minio";
import logger from "../utils/logger.js";

let client = null;
let bucketName = null;
let endpointUrl = null;

const MinioWrapper = {
  /**
   * Initialize the MinIO client and ensure the bucket exists.
   * @param {string} endpoint - e.g. "http://<host>:9000"
   * @param {string} accessKey
   * @param {string} secretKey
   * @param {string} bucket
   */
  async init(endpoint, accessKey, secretKey, bucket) {
    try {
      const url = new URL(endpoint);
      client = new Client({
        endPoint: url.hostname,
        port: parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
        useSSL: url.protocol === "https:",
        accessKey,
        secretKey,
      });
      bucketName = bucket;
      endpointUrl = endpoint.replace(/\/+$/, "");

      // Ensure bucket exists
      const exists = await client.bucketExists(bucket);
      if (!exists) {
        await client.makeBucket(bucket);
        logger.info(`MinIO bucket "${bucket}" created`);
      }

      // Ensure bucket has a public read-only policy so browsers can
      // fetch files directly via the MinIO URL (GetObject only).
      const publicPolicy = JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { AWS: ["*"] },
          Action: ["s3:GetObject"],
          Resource: [`arn:aws:s3:::${bucket}/*`],
        }],
      });
      await client.setBucketPolicy(bucket, publicPolicy);

      logger.success(`MinIO connected: ${endpoint} (bucket: ${bucket})`);
    } catch (error) {
      logger.error(`MinIO connection failed: ${error.message}`);
      client = null;
      bucketName = null;
      endpointUrl = null;
    }
  },

  /**
   * Whether MinIO is available for use.
   */
  isAvailable() {
    return client !== null;
  },

  /**
   * Get the base URL for direct public access to objects in the bucket.
   * e.g. "http://<host>:9000/prism"
   * @returns {string|null}
   */
  getBucketUrl() {
    if (!endpointUrl || !bucketName) return null;
    return `${endpointUrl}/${bucketName}`;
  },

  /**
   * Build a direct public URL for an object key.
   * e.g. "http://<host>:9000/prism/projects/retina/127.0.0.1/uploads/uuid.png"
   * @param {string} key - Object key within the bucket
   * @returns {string|null}
   */
  getPublicUrl(key) {
    const base = this.getBucketUrl();
    if (!base) return null;
    return `${base}/${key}`;
  },

  /**
   * Upload a file buffer to MinIO.
   * @param {string} key - Object key (path in the bucket)
   * @param {Buffer} buffer - File data
   * @param {string} contentType - MIME type
   * @returns {Promise<void>}
   */
  async upload(key, buffer, contentType) {
    await client.putObject(bucketName, key, buffer, buffer.length, {
      "Content-Type": contentType,
    });
  },

  /**
   * Get a readable stream for an object.
   * @param {string} key
   * @returns {Promise<import('stream').Readable>}
   */
  async get(key) {
    return client.getObject(bucketName, key);
  },

  /**
   * Remove an object from the bucket.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async remove(key) {
    await client.removeObject(bucketName, key);
  },

  /**
   * Get object metadata (stat).
   * @param {string} key
   * @returns {Promise<import('minio').BucketItemStat>}
   */
  async stat(key) {
    return client.statObject(bucketName, key);
  },

  /**
   * List all objects in the bucket with an optional prefix.
   * @param {string} [prefix=""] - Object key prefix to filter by
   * @returns {Promise<Array<{ name: string, size: number, lastModified: Date }>>}
   */
  async listObjects(prefix = "") {
    return new Promise((resolve, reject) => {
      const items = [];
      const stream = client.listObjectsV2(bucketName, prefix, true);
      stream.on("data", (obj) => items.push({ name: obj.name, size: obj.size, lastModified: obj.lastModified }));
      stream.on("end", () => resolve(items));
      stream.on("error", reject);
    });
  },
};

export default MinioWrapper;

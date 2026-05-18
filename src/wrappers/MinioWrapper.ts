// ─── MinioWrapper — Thin adapter over service-library MinioManager ───
//
// Re-exports MinioManager from the service-library while preserving
// the Prism-specific init(endpoint, accessKey, secretKey, bucket) signature.
//
// The service-library version uses a config object:
//   init({ endpoint, accessKey, secretKey, bucket, publicRead, logger })
//
// This adapter bridges the positional-args API to the config-object API.
// ─────────────────────────────────────────────────────────────────────

// @ts-ignore
import { MinioManager } from "@rodrigo-barraza/service-library/minio";
import logger from "../utils/logger.ts";

const MinioWrapper = {
  /**
   * Initialize the MinIO client with positional arguments (legacy Prism API).


   */
  async init(endpoint: any, accessKey: any, secretKey: any, bucket: any) {
    return MinioManager.init({
      endpoint,
      accessKey,
      secretKey,
      bucket,
      publicRead: true,
      logger,
    });
  },

  isAvailable: () => MinioManager.isAvailable(),
  getBucketUrl: () => MinioManager.getBucketUrl(),
  getPublicUrl: (key: any) => MinioManager.getPublicUrl(key),
  upload: (key: any, buffer: any, contentType: any) =>
    MinioManager.upload(key, buffer, contentType),
  get: (key: any) => MinioManager.get(key),
  remove: (key: any) => MinioManager.remove(key),
  stat: (key: any) => MinioManager.stat(key),
  listObjects: (prefix: any) => MinioManager.listObjects(prefix),
};

export default MinioWrapper;

#!/usr/bin/env node
/**
 * One-time migration: rename MinIO objects that contain ::ffff: in their key
 * to the cleaned IPv4-only version.
 *
 * Usage:  node scripts/migrate-minio-ipv6-keys.js [--dry-run]
 *
 * This copies each affected object to the clean key and removes the old one.
 * Run with --dry-run first to preview what would be changed.
 */

import MinioWrapper from "../src/wrappers/MinioWrapper.js";
import {
  MINIO_ENDPOINT,
  MINIO_ACCESS_KEY,
  MINIO_SECRET_KEY,
  MINIO_BUCKET_NAME,
} from "../secrets.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  await MinioWrapper.init(MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET_NAME);

  if (!MinioWrapper.isAvailable()) {
    console.error("❌ MinIO not available");
    process.exit(1);
  }

  console.log(`\n🔍 Scanning bucket "${MINIO_BUCKET_NAME}" for ::ffff: keys...\n`);

  const allObjects = await MinioWrapper.listObjects("");
  const affected = allObjects.filter((obj) => obj.name.includes("::ffff:"));

  if (affected.length === 0) {
    console.log("✅ No objects with ::ffff: found. Nothing to migrate.");
    process.exit(0);
  }

  console.log(`Found ${affected.length} object(s) to migrate${DRY_RUN ? " (dry run)" : ""}:\n`);

  let migrated = 0;
  let errors = 0;

  for (const obj of affected) {
    const oldKey = obj.name;
    const newKey = oldKey.replace(/::ffff:/g, "");
    console.log(`  ${oldKey}`);
    console.log(`  → ${newKey}`);

    if (DRY_RUN) {
      console.log("  [dry run — skipped]\n");
      continue;
    }

    try {
      // Copy to new key (MinIO copy-object uses CopySource header)
      const { Client } = await import("minio");
      // We need the raw client for copyObject
      const url = new URL(MINIO_ENDPOINT);
      const client = new Client({
        endPoint: url.hostname,
        port: parseInt(url.port, 10) || 80,
        useSSL: url.protocol === "https:",
        accessKey: MINIO_ACCESS_KEY,
        secretKey: MINIO_SECRET_KEY,
      });

      const conditions = new (await import("minio")).CopyConditions();
      await client.copyObject(MINIO_BUCKET_NAME, newKey, `/${MINIO_BUCKET_NAME}/${oldKey}`, conditions);
      await client.removeObject(MINIO_BUCKET_NAME, oldKey);

      console.log("  ✅ migrated\n");
      migrated++;
    } catch (err) {
      console.error(`  ❌ error: ${err.message}\n`);
      errors++;
    }
  }

  console.log(`\nDone: ${migrated} migrated, ${errors} errors, ${affected.length} total.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

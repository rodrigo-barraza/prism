// ============================================================
// Prism — Boot Sequence
// ============================================================
// Bootstraps secrets from Vault (or .env fallback) and injects
// them into process.env BEFORE any module imports run.
//
// Resolution order (first wins per key):
//   1. Already-set process.env values (manual env vars)
//   2. Vault service (fetched over HTTP)
//   3. Fallback .env file (../vault-service/.env)
//   4. Static config.js defaults
//
// This allows flexible deployment:
//   - Vault on the LAN → automatic
//   - Docker with env vars → process.env already set
//   - Local dev with config.js defaults → still works unchanged
// ============================================================

import { bootstrapEnv } from "@rodrigo-barraza/utilities-library/vault";

await bootstrapEnv();

// Now import the actual app — all modules will read from process.env
// via config.js, which is a typed accessor layer over process.env.
await import("./index.js");

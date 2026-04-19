// ────────────────────────────────────────────────────────────
// Tool Taxonomy Constants (Prism mirror)
// ────────────────────────────────────────────────────────────
// Mirrors tools-api/services/ToolTaxonomyConstants.js.
// Contains label and domain constants used in enabledTools
// arrays and tool resolution logic.
//
// Canonical source: tools-api/services/ToolTaxonomyConstants.js
// ────────────────────────────────────────────────────────────

// ── Label Names ─────────────────────────────────────────────

export const LABELS = {
  CODING: "coding",
  DATA: "data",
  WEB: "web",
  HEALTH: "health",
  FINANCE: "finance",
  LOCATION: "location",
  REFERENCE: "reference",
  MEDIA: "media",
  SHOPPING: "shopping",
  SPORTS: "sports",
  MARITIME: "maritime",
  ENERGY: "energy",
  COMMUNICATION: "communication",
  CREATIVE: "creative",
  SMART_HOME: "smart_home",
  LIFX: "lifx",
  DISCORD: "discord",
  GIT: "git",
  META: "meta",
  AUTOMATION: "automation",
  DATA_SCIENCE: "data_science",
  ORCHESTRATION: "orchestration",
};

// ── Prefixed enabledTools Helpers ────────────────────────────
// Builds "label:X" and "domain:X" strings for use in
// agent enabledTools arrays. Prevents typos at the call site.

export const L = Object.fromEntries(
  Object.entries(LABELS).map(([k, v]) => [k, `label:${v}`]),
);

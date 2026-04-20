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
// Semantic cross-cutting categories. A tool can carry
// multiple labels (e.g. ["coding", "web"]).

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

// ── Domain Names ────────────────────────────────────────────
// Functional grouping — each tool belongs to exactly one domain.

export const DOMAINS = {
  WEATHER: "Weather & Environment",
  EVENTS: "Events",
  SPORTS: "Sports",
  MARKETS: "Markets & Commodities",
  TRENDS: "Trends",
  PRODUCTS: "Products",
  FINANCE: "Finance",
  KNOWLEDGE: "Knowledge",
  MOVIES: "Movies & TV",
  HEALTH: "Health",
  TRANSIT: "Transit",
  UTILITIES: "Utilities",
  COMPUTE: "Compute",
  MARITIME: "Maritime",
  ENERGY: "Energy",
  COMMUNICATION: "Communication",
  CREATIVE: "Creative",
  DISCORD: "Discord",
  SMART_HOME: "Smart Home",
  // Agentic sub-domains
  AGENTIC_FILES: "Agentic: File Operations",
  AGENTIC_SEARCH: "Agentic: Search & Discovery",
  AGENTIC_WEB: "Agentic: Web",
  AGENTIC_COMMAND: "Agentic: Command Execution",
  AGENTIC_GIT: "Agentic: Git",
  AGENTIC_BROWSER: "Agentic: Browser",
  AGENTIC_CODE_INTEL: "Agentic: Code Intelligence",
  AGENTIC_TASKS: "Agentic: Task Management",
  AGENTIC_MEMORY: "Agentic: Memory",
  AGENTIC_AGENTS: "Agentic: Agent Management",
  AGENTIC_META: "Agentic: Meta",
  AGENTIC_SCHEDULING: "Agentic: Scheduling",
  // Prism-local domains (added by ToolOrchestratorService)
  REASONING: "Reasoning",
  COORDINATOR: "Coordinator",
  AGENTIC_SKILLS: "Agentic: Skills",
  AGENTIC_CONTROL: "Agentic: Control Flow",
  AGENTIC_STRUCTURED: "Agentic: Structured Output",
  AGENTIC_GIT_ISOLATION: "Agentic: Git Isolation",
  AGENTIC_TASK_MGMT: "Agentic: Task Management",
};

// ── Prefixed enabledTools Helpers ────────────────────────────
// Builds "label:X" and "domain:X" strings for use in
// agent enabledTools arrays. Prevents typos.

export const L = Object.fromEntries(
  Object.entries(LABELS).map(([k, v]) => [k, `label:${v}`]),
);

export const D = Object.fromEntries(
  Object.entries(DOMAINS).map(([k, v]) => [k, `domain:${v}`]),
);

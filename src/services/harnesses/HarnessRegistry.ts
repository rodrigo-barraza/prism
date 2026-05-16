import StandardAgenticHarness from "./StandardAgenticHarness.js";

/**
 * HarnessRegistry — maps harness IDs to their implementation classes.
 *
 * Adding a new harness:
 *   1. Create a class extending BaseAgenticHarness in this directory
 *   2. Set static `id`, `label`, and `description`
 *   3. Import and register it here
 */

/** @type {Map<string, typeof BaseAgenticHarness>} */
const registry = new Map();

function register(HarnessClass: any) {
  registry.set(HarnessClass.id, HarnessClass);
}

// ── Built-in harnesses ───────────────────────────────────────
register(StandardAgenticHarness);

// Future: register(ReactAgenticHarness);
// Future: register(SingleShotHarness);
// Future: register(PlanExecuteHarness);

const HarnessRegistry = {
  /**
   * Get a harness class by ID, falling back to "standard".
   * @param {string} id
   * @returns {typeof BaseAgenticHarness}
   */
  get(id: any) {
    return registry.get(id) || registry.get("standard");
  },

  /**
   * List all registered harnesses for the settings UI.
   * @returns {Array<{ id: string, label: string, description: string }>}
   */
  list() {
    return [...registry.values()].map((H: any) => ({
      id: H.id,
      label: H.label,
      description: H.description,
    }));
  },

  /**
   * Check if a harness ID exists.
   * @param {string} id
   * @returns {boolean}
   */
  has(id: any) {
    return registry.has(id);
  },
};

export default HarnessRegistry;

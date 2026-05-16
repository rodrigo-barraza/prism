/**
 * Get a provider instance by ID.
 * @param {string} id - Instance ID (e.g. "lm-studio", "lm-studio-2")
 * @returns {object|null} Provider object or null if not found
 */
export declare function getInstanceProvider(id: any): any;
/**
 * Get full instance entry by ID.
 * @param {string} id - Instance ID
 * @returns {InstanceEntry|null}
 */
export declare function getInstance(id: any): any;
/**
 * Check if an ID belongs to a registered instance.
 * @param {string} id
 * @returns {boolean}
 */
export declare function isInstance(id: any): boolean;
/**
 * List all registered instances.
 * @returns {InstanceEntry[]}
 */
export declare function listInstances(): any[];
/**
 * Get all unique provider types that have at least one instance.
 * @returns {string[]}
 */
export declare function listInstanceTypes(): any[];
/**
 * Get all instances of a given provider type.
 * @param {string} type - Provider type (e.g. "lm-studio")
 * @returns {InstanceEntry[]}
 */
export declare function getInstancesByType(type: any): any[];
/**
 * Resolve the provider type from an instance ID.
 * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"
 * @param {string} id - Instance ID
 * @returns {string|null}
 */
export declare function getInstanceType(id: any): any;
//# sourceMappingURL=instance-registry.d.ts.map
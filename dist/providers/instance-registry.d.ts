/**
 * Get a provider instance by ID.

 * @returns {object|null} Provider object or null if not found
 */
export declare function getInstanceProvider(id: any): any;
/**
 * Get full instance entry by ID.


 */
export declare function getInstance(id: any): any;
/**
 * Check if an ID belongs to a registered instance.


 */
export declare function isInstance(id: any): boolean;
/**
 * List all registered instances.

 */
export declare function listInstances(): any[];
/**
 * Get all unique provider types that have at least one instance.

 */
export declare function listInstanceTypes(): any[];
/**
 * Get all instances of a given provider type.


 */
export declare function getInstancesByType(type: any): any[];
/**
 * Resolve the provider type from an instance ID.
 * e.g. "lm-studio-2" → "lm-studio", "ollama" → "ollama"


 */
export declare function getInstanceType(id: any): any;
//# sourceMappingURL=instance-registry.d.ts.map
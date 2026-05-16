declare const HarnessRegistry: {
    /**
     * Get a harness class by ID, falling back to "standard".
     * @param {string} id
     * @returns {typeof BaseAgenticHarness}
     */
    get(id: any): any;
    /**
     * List all registered harnesses for the settings UI.
     * @returns {Array<{ id: string, label: string, description: string }>}
     */
    list(): {
        id: any;
        label: any;
        description: any;
    }[];
    /**
     * Check if a harness ID exists.
     * @param {string} id
     * @returns {boolean}
     */
    has(id: any): boolean;
};
export default HarnessRegistry;
//# sourceMappingURL=HarnessRegistry.d.ts.map
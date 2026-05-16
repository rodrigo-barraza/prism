declare const BackgroundHousekeepingService: {
    /**
     * Run all housekeeping tasks.
     * Safe to call at any time — each task is independent and failure-tolerant.
     *
     * @param {object} [options]
     * @param {"boot"|"scheduled"} [options.trigger="boot"] - What triggered the run
     * @returns {Promise<object>} Summary of actions taken
     */
    run({ trigger }?: {
        trigger?: string | undefined;
    }): Promise<{}>;
};
export default BackgroundHousekeepingService;
//# sourceMappingURL=BackgroundHousekeepingService.d.ts.map
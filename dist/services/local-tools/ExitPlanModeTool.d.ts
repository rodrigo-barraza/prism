declare const _default: {
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                summary: {
                    type: string;
                    description: string;
                };
            };
            required: never[];
        };
    };
    domain: string;
    labels: string[];
    execute(args: any): Promise<{
        acknowledged: boolean;
        mode: string;
        summary: any;
    }>;
};
export default _default;
//# sourceMappingURL=ExitPlanModeTool.d.ts.map
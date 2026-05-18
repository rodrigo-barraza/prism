declare const _default: {
    name: string;
    schema: {
        name: string;
        description: string;
        parameters: {
            type: string;
            properties: {
                reason: {
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
        reason: any;
        message: string;
    }>;
};
export default _default;
//# sourceMappingURL=EnterPlanModeTool.d.ts.map
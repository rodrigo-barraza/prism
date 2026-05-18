import { ObjectId } from "mongodb";
declare const CustomAgentService: {
    /**
     * List all custom agents.
  
     */
    list(): Promise<import("mongodb").WithId<import("bson").Document>[]>;
    /**
     * Get a single custom agent by MongoDB _id.
  
  
     */
    get(id: any): Promise<import("mongodb").WithId<import("bson").Document> | null>;
    /**
     * Get a custom agent by its derived agentId.
  
  
     */
    getByAgentId(agentId: any): Promise<import("mongodb").WithId<import("bson").Document> | null>;
    /**
     * Create a new custom agent.
  
     * @returns {Promise<object>} The created document
     */
    create(data: any): Promise<{
        _id: ObjectId;
        name: any;
        agentId: string;
        type: any;
        description: any;
        project: any;
        icon: any;
        color: any;
        backgroundImage: any;
        identity: any;
        guidelines: any;
        toolPolicy: any;
        enabledTools: any;
        usesDirectoryTree: any;
        usesCodingGuidelines: any;
        createdAt: string;
        updatedAt: string;
    }>;
    /**
     * Update an existing custom agent.
  
  
     * @returns {Promise<object>} The updated document
     */
    update(id: any, updates: any): Promise<import("mongodb").WithId<import("bson").Document> | null>;
    /**
     * Delete a custom agent.
  
  
     */
    delete(id: any): Promise<boolean>;
};
export default CustomAgentService;
//# sourceMappingURL=CustomAgentService.d.ts.map
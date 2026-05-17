declare const MongoWrapper: {
    createClient(name: any, uri: any): Promise<import("mongodb").Db>;
    getClient(_name: any): never;
    getDb(name: any): import("mongodb").Db;
    getCollection(dbName: any, collectionName: any): import("mongodb").Collection<import("bson").Document>;
    closeClient(name: any): Promise<void>;
};
export default MongoWrapper;
//# sourceMappingURL=MongoWrapper.d.ts.map
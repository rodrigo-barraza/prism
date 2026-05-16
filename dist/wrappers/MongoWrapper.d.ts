declare const MongoWrapper: {
    createClient(name: any, uri: any): Promise<any>;
    getClient(_name: any): never;
    getDb(name: any): any;
    getCollection(dbName: any, collectionName: any): any;
    closeClient(name: any): any;
};
export default MongoWrapper;
//# sourceMappingURL=MongoWrapper.d.ts.map
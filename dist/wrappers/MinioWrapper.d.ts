declare const MinioWrapper: {
    /**
     * Initialize the MinIO client with positional arguments (legacy Prism API).
     * @param {string} endpoint - e.g. "http://<host>:9000"
     * @param {string} accessKey
     * @param {string} secretKey
     * @param {string} bucket
     */
    init(endpoint: any, accessKey: any, secretKey: any, bucket: any): Promise<any>;
    isAvailable: () => any;
    getBucketUrl: () => any;
    getPublicUrl: (key: any) => any;
    upload: (key: any, buffer: any, contentType: any) => any;
    get: (key: any) => any;
    remove: (key: any) => any;
    stat: (key: any) => any;
    listObjects: (prefix: any) => any;
};
export default MinioWrapper;
//# sourceMappingURL=MinioWrapper.d.ts.map
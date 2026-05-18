declare const MinioWrapper: {
    /**
     * Initialize the MinIO client with positional arguments (legacy Prism API).
  
  
     */
    init(endpoint: any, accessKey: any, secretKey: any, bucket: any): Promise<void>;
    isAvailable: () => boolean;
    getBucketUrl: () => string | null;
    getPublicUrl: (key: any) => string | null;
    upload: (key: any, buffer: any, contentType: any) => Promise<void>;
    get: (key: any) => Promise<import("node:stream").Readable>;
    remove: (key: any) => Promise<void>;
    stat: (key: any) => Promise<Record<string, unknown>>;
    listObjects: (prefix: any) => Promise<import("@rodrigo-barraza/service-library/minio").MinioObjectInfo[]>;
};
export default MinioWrapper;
//# sourceMappingURL=MinioWrapper.d.ts.map
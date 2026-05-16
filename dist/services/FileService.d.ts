/**
 * FileService — abstracts file storage with MinIO primary / MongoDB inline fallback.
 *
 * When MinIO is available, files are uploaded to the bucket and a lightweight
 * reference string `minio://files/<uuid>.<ext>` is returned.
 *
 * When MinIO is unavailable, the original base64 data URL is returned unchanged,
 * so it continues to be stored inline in MongoDB.
 */
declare const FileService: {
    /**
     * Whether external (MinIO) storage is active.
     */
    isExternalStorage(): any;
    /**
     * Upload a file from a base64 data URL.
     * @param {string} dataUrl - e.g. "data:image/png;base64,iVBOR..."
     * @param {"uploads"|"generations"} [category="uploads"] - folder to store in
     * @param {string} [project] - project name for path organization
     * @param {string} [username] - username for path organization
     * @returns {Promise<{ ref: string, size: number, contentType: string }>}
     *   ref is either `minio://...` or the original dataUrl.
     */
    uploadFile(dataUrl: any, category?: string, project?: null, username?: null): Promise<{
        ref: any;
        size: number;
        contentType: string;
    } | {
        ref: string;
        size: number;
        contentType: any;
    }>;
    /**
     * Get a file stream from a MinIO reference.
     * @param {string} key - The object key (without the "minio://" prefix)
     * @returns {Promise<{ stream: import('stream').Readable, contentType: string } | null>}
     */
    getFile(key: any): Promise<{
        stream: any;
        contentType: any;
    } | null>;
    /**
     * Check if a string is a MinIO reference.
     * @param {string} ref
     * @returns {boolean}
     */
    isMinioRef(ref: any): boolean;
    /**
     * Extract the object key from a MinIO reference.
     * @param {string} ref - e.g. "minio://files/abc-123.png"
     * @returns {string} - e.g. "files/abc-123.png"
     */
    extractKey(ref: any): any;
};
export default FileService;
//# sourceMappingURL=FileService.d.ts.map
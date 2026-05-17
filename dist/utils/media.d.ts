/**
 * Compress a base64-encoded image to fit within a byte-size limit.
 *
 * Strategy:
 *  - GIFs → ffmpeg resize (preserves animation for models that support it)
 *  - Everything else → sharp JPEG conversion + progressive downscale
 *
 * @param {string} base64Data  - Raw base64 string (no data: prefix)
 * @param {string} mediaType   - MIME type, e.g. "image/png"
 * @param {number} [maxBytes]   - Maximum allowed size in bytes (default: 5 MB)
 * @returns {Promise<{ data: string, mediaType: string }>} Compressed base64 + updated MIME
 */
export declare function compressImageForSizeLimit(base64Data: any, mediaType: any, maxBytes?: number): Promise<{
    data: any;
    mediaType: any;
}>;
/**
 * Constrain image pixel dimensions to MAX_IMAGE_DIMENSION.
 * If either width or height exceeds the limit, the image is downscaled
 * proportionally using sharp's Lanczos3 resampler.
 *
 * GIFs are skipped (ffmpeg handles them separately in byte-size compression).
 *
 * @param {string} base64Data  - Raw base64 string (no data: prefix)
 * @param {string} mediaType   - MIME type, e.g. "image/png"
 * @param {number} [maxDim]    - Max pixels for either axis (default: 7680)
 * @returns {Promise<{ data: string, mediaType: string }>} Possibly resized base64 + MIME
 */
export declare function constrainImageDimensions(base64Data: any, mediaType: any, maxDim?: number): Promise<{
    data: any;
    mediaType: any;
}>;
/**
 * Detect MIME type from a base64 data URL.
 * @param {string} dataUrl - A data: URL string
 * @returns {string|null} The MIME type (e.g. "image/png") or null
 */
export declare function getDataUrlMimeType(dataUrl: any): any;
/**
 * Check if a string is a valid data: URL, HTTP(S) URL, or other ref type.
 * @param {string} url
 * @returns {"data"|"http"|"unknown"}
 */
export declare function getUrlType(url: any): "unknown" | "data" | "http";
/**
 * Infer MIME category from a URL's file extension.
 * @param {string} url
 * @returns {"image"|"pdf"|"text"|"unknown"}
 */
export declare function inferMimeFromUrl(url: any): "unknown" | "text" | "image" | "pdf";
/**
 * Extract frames from a video data URL using ffmpeg.
 * Returns an array of JPEG image data URLs (one per frame at 1fps).
 *
 * Each image frame costs ~256 tokens in vision models. Default maxFrames=8
 * keeps total image tokens ~2K, leaving room for text generation in
 * local models with limited context windows (4K-8K typical).
 *
 * @param {string} videoDataUrl - A data:video/...;base64,... URL
 * @param {object} [options]
 * @param {number} [options.fps=1] - Frames per second to extract
 * @param {number} [options.maxFrames=8] - Maximum frames to extract
 * @param {number} [options.quality=5] - JPEG quality (2=best, 31=worst)
 * @returns {Promise<string[]>} Array of data:image/jpeg;base64,... URLs
 */
export declare function extractVideoFrames(videoDataUrl: any, options?: {}): Promise<any[]>;
//# sourceMappingURL=media.d.ts.map
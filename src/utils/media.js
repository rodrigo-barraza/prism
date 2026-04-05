// ─────────────────────────────────────────────────────────────
// Shared Media & URL Utilities
// ─────────────────────────────────────────────────────────────

/**
 * Detect MIME type from a base64 data URL.
 * @param {string} dataUrl - A data: URL string
 * @returns {string|null} The MIME type (e.g. "image/png") or null
 */
export function getDataUrlMimeType(dataUrl) {
  const match = dataUrl.match(/^data:([^;]+);base64,/);
  return match ? match[1] : null;
}

/**
 * Check if a string is a valid data: URL, HTTP(S) URL, or other ref type.
 * @param {string} url
 * @returns {"data"|"http"|"unknown"}
 */
export function getUrlType(url) {
  if (url.startsWith("data:")) return "data";
  if (url.startsWith("http://") || url.startsWith("https://")) return "http";
  return "unknown";
}

/**
 * Infer MIME category from a URL's file extension.
 * @param {string} url
 * @returns {"image"|"pdf"|"text"|"unknown"}
 */
export function inferMimeFromUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (/\.(png|jpg|jpeg|gif|webp|bmp|svg|avif)$/i.test(pathname)) return "image";
    if (/\.pdf$/i.test(pathname)) return "pdf";
    if (/\.(txt|md|csv|json|xml|html|css|js|ts)$/i.test(pathname)) return "text";
  } catch { /* ignore */ }
  return "unknown";
}

/**
 * Resolves after `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

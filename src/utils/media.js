// ─────────────────────────────────────────────────────────────
// Shared Media & URL Utilities
// ─────────────────────────────────────────────────────────────

import { execFile } from "child_process";
import { writeFile, readFile, mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import logger from "./logger.js";

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

// ── Video Frame Extraction ──────────────────────────────────

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
export async function extractVideoFrames(videoDataUrl, options = {}) {
  const { fps = 1, maxFrames = 8, quality = 5 } = options;
  let tmpDir = null;

  try {
    // Decode video data URL to a temp file.
    // Use string ops instead of regex — regex (.+) on multi-MB base64 causes OOM.
    const b64Marker = ";base64,";
    const markerIdx = videoDataUrl.indexOf(b64Marker);
    if (markerIdx === -1 || !videoDataUrl.startsWith("data:")) {
      throw new Error("Invalid video data URL format");
    }

    const mime = videoDataUrl.slice(5, markerIdx); // "data:" is 5 chars
    const base64Data = videoDataUrl.slice(markerIdx + b64Marker.length);
    const ext = mime.split("/")[1]?.split(";")[0] || "mp4";

    tmpDir = await mkdtemp(join(tmpdir(), "prism-frames-"));
    const inputPath = join(tmpDir, `input.${ext}`);
    const outputPattern = join(tmpDir, "frame_%04d.jpg");

    // Write video to temp file
    const videoBuffer = Buffer.from(base64Data, "base64");
    const fileSizeMB = (videoBuffer.length / (1024 * 1024)).toFixed(1);
    logger.info(`[media] Writing ${fileSizeMB} MB video (${mime}) to ${inputPath}`);
    await writeFile(inputPath, videoBuffer);

    // Extract frames with ffmpeg
    const ffmpegStderr = await new Promise((resolve, reject) => {
      execFile(
        "ffmpeg",
        [
          "-i", inputPath,
          "-vf", `fps=${fps}`,
          "-vframes", String(maxFrames),
          "-q:v", String(quality),
          "-f", "image2",
          outputPattern,
        ],
        { timeout: 30_000 },
        (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(`ffmpeg failed (${fileSizeMB} MB ${ext}): ${stderr?.slice(-200) || error.message}`));
          } else {
            resolve(stderr);
          }
        },
      );
    });

    // Read extracted frames and convert to data URLs
    const frames = [];
    for (let i = 1; i <= maxFrames; i++) {
      const framePath = join(tmpDir, `frame_${String(i).padStart(4, "0")}.jpg`);
      try {
        const frameBuffer = await readFile(framePath);
        const frameBase64 = frameBuffer.toString("base64");
        frames.push(`data:image/jpeg;base64,${frameBase64}`);
      } catch {
        break;
      }
    }

    if (frames.length === 0) {
      // ffmpeg ran but produced no frames — extract error details
      const durationMatch = ffmpegStderr?.match(/Duration: ([^,]+)/);
      const duration = durationMatch?.[1] || "unknown";
      throw new Error(
        `ffmpeg produced 0 frames from ${fileSizeMB} MB ${ext} video (duration: ${duration}). ` +
        `The file may be corrupt, use an unsupported codec, or contain no video stream.`,
      );
    }

    logger.info(`[media] Extracted ${frames.length} frames from video (${ext}, ${fileSizeMB} MB, fps=${fps})`);
    return frames;
  } finally {
    if (tmpDir) {
      rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}


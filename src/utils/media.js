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
 * Per Gemma 4 model card, video supports max 60 seconds at 1fps.
 * Default maxFrames=30 keeps context manageable while providing
 * good temporal coverage.
 *
 * @param {string} videoDataUrl - A data:video/...;base64,... URL
 * @param {object} [options]
 * @param {number} [options.fps=1] - Frames per second to extract
 * @param {number} [options.maxFrames=30] - Maximum frames to extract
 * @param {number} [options.quality=5] - JPEG quality (2=best, 31=worst)
 * @returns {Promise<string[]>} Array of data:image/jpeg;base64,... URLs
 */
export async function extractVideoFrames(videoDataUrl, options = {}) {
  const { fps = 1, maxFrames = 30, quality = 5 } = options;
  let tmpDir = null;

  try {
    // Decode video data URL to a temp file
    const match = videoDataUrl.match(/^data:([^;]+);base64,(.+)$/s);
    if (!match) {
      logger.warn("[media] extractVideoFrames: invalid data URL format");
      return [];
    }

    const [, mime, base64Data] = match;
    const ext = mime.split("/")[1]?.split(";")[0] || "mp4";

    tmpDir = await mkdtemp(join(tmpdir(), "prism-frames-"));
    const inputPath = join(tmpDir, `input.${ext}`);
    const outputPattern = join(tmpDir, "frame_%04d.jpg");

    // Write video to temp file
    await writeFile(inputPath, Buffer.from(base64Data, "base64"));

    // Extract frames with ffmpeg:
    //   -i input.mp4            — input video
    //   -vf fps=1               — extract at 1 frame per second
    //   -vframes 30             — maximum frames to extract
    //   -q:v 5                  — JPEG quality (lower = better)
    //   -f image2               — output as image sequence
    //   frame_%04d.jpg          — output pattern
    await new Promise((resolve, reject) => {
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
        { timeout: 30_000 }, // 30s timeout
        (error, _stdout, stderr) => {
          if (error) {
            logger.warn(`[media] ffmpeg frame extraction failed: ${stderr || error.message}`);
            reject(error);
          } else {
            resolve();
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
        // No more frames — we've read all extracted frames
        break;
      }
    }

    logger.info(`[media] Extracted ${frames.length} frames from video (${ext}, fps=${fps})`);
    return frames;
  } catch (err) {
    logger.warn(`[media] Video frame extraction failed: ${err.message}`);
    return [];
  } finally {
    // Clean up temp directory
    if (tmpDir) {
      rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}


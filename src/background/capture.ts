/**
 * Service-worker half of the region-screenshot pipeline.
 *
 * captureVisibleTab is only callable here, and only for the active tab of a
 * window. It hands back the whole viewport; this module crops the requested
 * rect out of it with OffscreenCanvas and returns base64 JPEG.
 *
 * Two constraints shape the code:
 *
 * - Chrome rate-limits captureVisibleTab to a couple of calls per second and
 *   rejects the rest outright. Calls are serialised through a promise chain
 *   and retried with backoff, so two features asking at once queue instead of
 *   one of them failing.
 *
 * - The captured image is in device pixels while the rect arrived in CSS
 *   pixels, so every coordinate is multiplied by devicePixelRatio before it
 *   touches the canvas.
 */

import type { CaptureRegionRequest, CapturedImage } from '../shared/messages.js';
import { LucidError } from '../shared/messages.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('background:capture');

/**
 * Longest edge of the returned image. Beyond this we are paying for tokens on
 * detail no model uses; scaling down is close to free in comparison.
 */
const MAX_EDGE_PX = 1600;

const JPEG_QUALITY = 0.9;

/** Serialises capture calls; Chrome rejects concurrent ones. */
let queue: Promise<unknown> = Promise.resolve();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** captureVisibleTab with retry on Chrome's rate limiter. */
async function grabViewport(windowId: number | undefined, attempts = 3): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return windowId === undefined
        ? await chrome.tabs.captureVisibleTab({ format: 'png' })
        : await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const rateLimited = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(message);
      const last = attempt === attempts - 1;

      if (rateLimited && !last) {
        await delay(250 * (attempt + 1));
        continue;
      }
      if (/activeTab|permission|cannot be scripted|chrome:\/\//i.test(message)) {
        throw new LucidError(
          'Lucid cannot capture this page. Browser pages and the Chrome Web Store are off limits.',
          'capture_forbidden',
          false,
        );
      }
      throw new LucidError(`Could not capture the page: ${message}`, 'capture_failed', rateLimited);
    }
  }
  throw new LucidError('Could not capture the page.', 'capture_failed', true);
}

/** Blob -> bare base64, chunked so a large image cannot blow the call stack. */
async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function crop(dataUrl: string, request: CaptureRegionRequest): Promise<CapturedImage> {
  const dpr = request.devicePixelRatio || 1;

  const source = await fetch(dataUrl).then((r) => r.blob());
  const bitmap = await createImageBitmap(source);

  try {
    // CSS pixels -> device pixels, then clamp to the image we actually have.
    // Rounding outward keeps a one-pixel border rather than shaving content.
    const sx = Math.max(0, Math.floor(request.rect.x * dpr));
    const sy = Math.max(0, Math.floor(request.rect.y * dpr));
    const sw = Math.min(Math.ceil(request.rect.width * dpr), bitmap.width - sx);
    const sh = Math.min(Math.ceil(request.rect.height * dpr), bitmap.height - sy);

    if (sw <= 0 || sh <= 0) {
      throw new LucidError(
        'That region is outside the visible page area.',
        'region_out_of_bounds',
        false,
      );
    }

    // Scale down only; never upscale a small region into a big blurry one.
    const scale = Math.min(1, MAX_EDGE_PX / Math.max(sw, sh));
    const width = Math.max(1, Math.round(sw * scale));
    const height = Math.max(1, Math.round(sh * scale));

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new LucidError('Could not open a drawing surface to crop the capture.', 'no_canvas');
    }

    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);

    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    const base64 = await blobToBase64(jpeg);

    log.debug('cropped region', { sx, sy, sw, sh, width, height, bytes: jpeg.size });

    return { base64, mediaType: 'image/jpeg', width, height };
  } finally {
    bitmap.close();
  }
}

/**
 * Capture and crop one region.
 *
 * `tabId` is only used to find the right window; the capture always targets
 * that window's active tab, which is what the user is looking at.
 */
export function captureRegion(
  request: CaptureRegionRequest,
  tab?: chrome.tabs.Tab,
): Promise<CapturedImage> {
  const run = async (): Promise<CapturedImage> => {
    const dataUrl = await grabViewport(tab?.windowId);
    return crop(dataUrl, request);
  };

  // Chain onto the queue regardless of whether the previous call succeeded.
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

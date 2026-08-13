/**
 * Content half of the region-screenshot pipeline.
 *
 * The service worker owns the actual pixels (only it can call
 * captureVisibleTab). This side's job is to get the target on screen, measure
 * it correctly, and get Lucid's own UI out of the shot.
 *
 * Four things here are easy to get wrong and all four are deliberate:
 *
 * 1. SCROLL. captureVisibleTab only ever returns the visible viewport, so an
 *    off-screen target must be scrolled into view first - and the page must be
 *    put back exactly where the user left it afterwards, or we have silently
 *    moved someone's reading position.
 *
 * 2. PAINT. getBoundingClientRect is correct the instant scrolling finishes,
 *    but the compositor has not necessarily drawn yet. Capturing too early
 *    yields the pre-scroll frame cropped at post-scroll coordinates - the
 *    classic "screenshot of the wrong part of the page" bug. We wait for two
 *    animation frames plus a short settle.
 *
 * 3. DEVICE PIXELS. The rect is in CSS pixels; the captured image is in device
 *    pixels. On any HiDPI screen (devicePixelRatio 2 or 3) a crop that skips
 *    the multiply lands somewhere near the top-left corner of the target and
 *    is a quarter or a ninth of the size. devicePixelRatio travels with the
 *    rect and the worker does the multiply.
 *
 * 4. OUR OWN UI. The panel and any highlights are real DOM on the page and
 *    will appear in the screenshot - a model then describes Lucid's own panel
 *    back to the user. Both are hidden for the duration of the capture.
 */

import type { CapturedImage, Rect } from '../shared/messages.js';
import { LucidError, sendToBackground } from '../shared/messages.js';
import { createLogger } from '../shared/logger.js';

const log = createLogger('content:capture');

/** Smallest region worth sending; below this there is nothing to describe. */
const MIN_SIZE_PX = 8;

/**
 * Every Lucid-owned overlay host, hidden for the duration of a capture.
 *
 * Two ways to match, both supported so that adding an overlay never requires
 * editing this file:
 *
 *   [data-lucid-overlay]  explicit opt-in - preferred for new overlays
 *   [id^="lucid-"]        the existing convention, which every current host
 *                         already follows (lucid-panel-host,
 *                         lucid-overlay-host, lucid-chart-badges)
 *
 * This used to hide only the panel and the highlight layer, which meant each
 * feature that added an overlay had to hide it again at its own call sites -
 * chart and explain had both written their own copy of that, and explain's
 * reached into chart's DOM by hardcoded id. Anything matching the selector is
 * now hidden centrally, so a new overlay is covered for free.
 */
const OVERLAY_SELECTOR = '[data-lucid-overlay], [id^="lucid-"]';

/** Resolve once the browser has actually painted the current frame. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // A short settle covers sticky headers and scroll-linked layout that
        // reflow one frame late.
        window.setTimeout(resolve, 32);
      });
    });
  });
}

/** Clamp to the visible viewport - anything outside it is not in the capture. */
function clampToViewport(rect: Rect): Rect {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(window.innerWidth, rect.x + rect.width);
  const bottom = Math.min(window.innerHeight, rect.y + rect.height);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/**
 * Hide every Lucid overlay. Returns a restore function that puts each host
 * back to the inline visibility it had, rather than blanket-clearing it - a
 * layer that was already hidden for its own reasons must stay hidden.
 */
function hideOverlays(): () => void {
  const hosts = Array.from(
    document.documentElement.querySelectorAll<HTMLElement>(OVERLAY_SELECTOR),
  );
  const previous = hosts.map((host) => [host, host.style.visibility] as const);

  for (const host of hosts) host.style.visibility = 'hidden';
  log.debug(`hid ${hosts.length} overlay host(s) for capture`);

  return () => {
    for (const [host, value] of previous) host.style.visibility = value;
  };
}

/** Send the measured rect to the worker with all of our own UI hidden. */
async function requestCrop(rect: Rect): Promise<CapturedImage> {
  const restoreOverlays = hideOverlays();
  try {
    // The hide is a style change; it needs a paint too, or our own UI is still
    // in the pixels we are about to grab.
    await nextPaint();
    return await sendToBackground('capture.region', {
      rect,
      devicePixelRatio: window.devicePixelRatio || 1,
    });
  } finally {
    restoreOverlays();
  }
}

/**
 * Capture a viewport-relative rect, in CSS pixels.
 * The caller is responsible for the rect already being on screen.
 */
export async function captureRect(rect: Rect): Promise<CapturedImage> {
  const clamped = clampToViewport(rect);
  if (clamped.width < MIN_SIZE_PX || clamped.height < MIN_SIZE_PX) {
    throw new LucidError(
      'That region is too small or scrolled out of view to capture.',
      'region_too_small',
      false,
    );
  }
  return requestCrop(clamped);
}

/**
 * Capture an element: scroll it into view, wait for paint, crop it out, and
 * put the page back where it was.
 *
 * Elements taller than the viewport are captured as the visible portion after
 * centring - there is no scroll-and-stitch here, by design.
 */
export async function captureElement(element: Element): Promise<CapturedImage> {
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;

  try {
    element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    await nextPaint();

    const bounds = element.getBoundingClientRect();
    const rect = clampToViewport({
      x: bounds.left,
      y: bounds.top,
      width: bounds.width,
      height: bounds.height,
    });

    if (rect.width < MIN_SIZE_PX || rect.height < MIN_SIZE_PX) {
      throw new LucidError(
        'That element is not visible on screen, so there is nothing to capture.',
        'region_too_small',
        false,
      );
    }

    if (bounds.height > window.innerHeight) {
      log.debug('element taller than viewport; capturing the centred portion only');
    }

    return await requestCrop(rect);
  } finally {
    // Always restore, including on failure. Moving someone's scroll position
    // and leaving it moved is worse than the failed capture.
    window.scrollTo({ left: scrollX, top: scrollY, behavior: 'instant' });
  }
}

/**
 * Text near an element, for the `contextText` argument the AI calls take.
 * Prefers the element's own accessible-ish text, then falls back to its
 * container, so a bare <img> still gets the paragraph around it.
 */
export function contextTextFor(element: Element, maxChars = 1200): string {
  const own = (element.textContent ?? '').trim();
  const alt = element.getAttribute('alt') ?? '';
  const ariaLabel = element.getAttribute('aria-label') ?? '';
  const caption = element.closest('figure')?.querySelector('figcaption')?.textContent ?? '';

  let text = [ariaLabel, alt, caption, own].filter(Boolean).join(' ').trim();

  if (text.length < 40) {
    const container = element.closest('figure, section, article, main, div');
    const surrounding = (container?.textContent ?? '').trim();
    if (surrounding.length > text.length) text = surrounding;
  }

  return text.replace(/\s+/g, ' ').slice(0, maxChars);
}

/**
 * Lucid - the Reading Mode cursor.
 * ===========================================================================
 * Design-owned, self-contained, and optional. Nothing else imports it until
 * Reading Mode chooses to; it has no dependencies on the rest of the codebase.
 *
 * WHY THIS EXISTS
 *
 * ctx.highlight.highlightTextSlice() creates a fresh element for every word.
 * Two different elements cannot tween into each other, so the marker
 * disappears in one place and reappears in another - at reading speed that is
 * three or four jumps a second, and it reads as a strobing box rather than
 * something following the voice.
 *
 * This module keeps ONE element alive for the whole session and moves it. A
 * transform transition then does what the eye expects: the marker travels to
 * the next word, and the reader's attention travels with it.
 *
 * USE
 *
 *     import { createReadingCursor } from '../../design/reading-cursor.js';
 *
 *     const cursor = createReadingCursor();
 *     ctx.tts.speak(text, {
 *       onBoundary: ({ charIndex, charLength }) => {
 *         const hit = map.locate(charIndex);
 *         if (hit) cursor.moveToSlice(hit.node, hit.offset, hit.offset + charLength);
 *       },
 *       onPause: () => cursor.setPaused(true),
 *       onResume: () => cursor.setPaused(false),
 *       onEnd: () => cursor.hide(),
 *     });
 *
 * Call destroy() when Reading Mode stops for good. Everything else is safe to
 * call in any order, including before the first move.
 *
 * NOTES ON THE MOTION
 *
 * Travel within a line glides. A jump to a new line does NOT - easing a box
 * diagonally across a paragraph looks like a mistake, so a long move cuts and
 * re-fades instead. That threshold is the single most important number in
 * this file; see LINE_BREAK_RATIO.
 *
 * Under prefers-reduced-motion the cursor still moves and still tracks the
 * voice - it simply arrives instantly. Position is the information here, so it
 * is never the thing we take away.
 */

const HOST_ID = 'lucid-reading-cursor-host';

/** A move further than this many times the cursor's own height is treated as
 *  a line or paragraph break: cut, do not glide. */
const LINE_BREAK_RATIO = 1.4;

export interface ReadingCursor {
  /** Move to a slice of one text node - the Reading Mode case. */
  moveToSlice(node: Text, start: number, end: number): void;
  /** Move to an arbitrary range. */
  moveToRange(range: Range): void;
  /** Dim and stop, without losing the position. */
  setPaused(paused: boolean): void;
  /** Keep the page from scrolling the spoken word out of sight. */
  setFollowScroll(follow: boolean): void;
  hide(): void;
  /** Hide for the duration of `fn` - use around screenshots. */
  withHidden<T>(fn: () => Promise<T>): Promise<T>;
  destroy(): void;
}

const STYLES = `
:host {
  all: initial;
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  /* Just under the overlay layer, which is just under the panel. */
  z-index: 2147483645;
  pointer-events: none;

  --lucid-read: #ffc53d;
  --lucid-halo-dark: rgba(8, 10, 16, 0.42);
  --lucid-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
}
@media (prefers-color-scheme: dark) {
  :host { --lucid-read: #ffce55; --lucid-halo-dark: rgba(0, 0, 0, 0.6); }
}

.cursor {
  position: absolute;
  top: 0;
  left: 0;
  box-sizing: border-box;
  border-radius: 3px;
  opacity: 0;
  pointer-events: none;

  /* Same marker as overlay.css .word, so the gliding path and the plain path
     look identical - only the travel differs. */
  background: color-mix(in srgb, var(--lucid-read) 30%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--lucid-read) 55%, transparent),
    0 0 0 2px var(--lucid-halo-dark);

  transition:
    transform 110ms var(--lucid-ease-out),
    width 110ms var(--lucid-ease-out),
    height 110ms var(--lucid-ease-out),
    opacity 140ms var(--lucid-ease-out);
}

/* The bar the eye actually tracks, below the baseline so no glyph is covered. */
.cursor::after {
  content: "";
  position: absolute;
  inset-block-end: -3px;
  inset-inline: 0;
  height: 3px;
  border-radius: 2px;
  background: var(--lucid-read);
  box-shadow: 0 0 0 1px var(--lucid-halo-dark), 0 1px 6px -1px var(--lucid-read);
}

.cursor[data-visible="true"] { opacity: 1; }

/* A cut rather than a glide, for line and paragraph breaks. */
.cursor[data-jump="true"] { transition: opacity 140ms var(--lucid-ease-out); }

.cursor[data-paused="true"] { opacity: 0.45; }
.cursor[data-paused="true"]::after { box-shadow: 0 0 0 1px var(--lucid-halo-dark); }

@media (prefers-reduced-motion: reduce) {
  .cursor { transition: opacity 140ms var(--lucid-ease-out); }
}

@media (forced-colors: active) {
  .cursor {
    forced-color-adjust: none;
    background: Highlight;
    box-shadow: none;
  }
  .cursor::after { background: Highlight; box-shadow: none; }
}
`;

class ReadingCursorImpl implements ReadingCursor {
  private readonly host: HTMLElement;
  private readonly el: HTMLElement;
  private frame = 0;
  private followScroll = true;
  private destroyed = false;
  /** Last target, in document coordinates, so scrolling can re-place it. */
  private rect: DOMRect | null = null;
  private target: Range | null = null;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    // A visual aid only. The spoken text is already in the accessibility tree,
    // and announcing a moving box over it would be unbearable.
    this.host.setAttribute('aria-hidden', 'true');

    const root = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;

    this.el = document.createElement('div');
    this.el.className = 'cursor';

    root.append(style, this.el);
    document.documentElement.appendChild(this.host);

    this.onViewportChange = this.onViewportChange.bind(this);
    window.addEventListener('scroll', this.onViewportChange, { capture: true, passive: true });
    window.addEventListener('resize', this.onViewportChange, { passive: true });
  }

  moveToSlice(node: Text, start: number, end: number): void {
    const length = node.data.length;
    // Out-of-range offsets mean the caller's index map drifted. Leaving the
    // cursor where it is beats throwing in the middle of a sentence.
    if (start < 0 || end > length || start >= end) return;

    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    this.moveToRange(range);
  }

  moveToRange(range: Range): void {
    if (this.destroyed) return;
    this.target = range;

    const rect = this.documentRect(range);
    if (!rect) return;

    // A move that is mostly vertical, or longer than a line, is a line break:
    // cut to the new position instead of sliding diagonally across the text.
    const previous = this.rect;
    const jumped =
      !previous ||
      Math.abs(rect.top - previous.top) > rect.height * LINE_BREAK_RATIO;

    this.rect = rect;
    this.place(rect, jumped);

    if (this.followScroll) this.keepInView(rect);
  }

  private documentRect(range: Range): DOMRect | null {
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (rects.length === 0) return null;

    // A range that wraps mid-word reports several rects; the first is the one
    // the voice is on.
    const first = rects[0]!;
    return new DOMRect(first.left + window.scrollX, first.top + window.scrollY, first.width, first.height);
  }

  private place(rect: DOMRect, jumped: boolean): void {
    this.el.dataset.jump = jumped ? 'true' : 'false';
    this.el.style.width = `${rect.width}px`;
    this.el.style.height = `${rect.height}px`;
    this.el.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
    this.el.dataset.visible = 'true';

    if (jumped) {
      // Let the cut land before re-enabling the glide, otherwise the next
      // within-line move inherits the jump rule and snaps too.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!this.destroyed) this.el.dataset.jump = 'false';
        });
      });
    }
  }

  /** Scroll only when the word has actually left the comfortable band. */
  private keepInView(rect: DOMRect): void {
    const viewportTop = window.scrollY;
    const viewportBottom = viewportTop + window.innerHeight;
    const margin = Math.min(160, window.innerHeight * 0.2);

    if (rect.top < viewportTop + margin || rect.bottom > viewportBottom - margin) {
      window.scrollTo({
        top: rect.top - window.innerHeight / 2 + rect.height / 2,
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    }
  }

  private onViewportChange(): void {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.target) return;
      const rect = this.documentRect(this.target);
      // Reflowed text moves under us; follow without animating, or the cursor
      // appears to swim while the user scrolls.
      if (rect) {
        this.rect = rect;
        this.place(rect, true);
      }
    });
  }

  setPaused(paused: boolean): void {
    this.el.dataset.paused = paused ? 'true' : 'false';
  }

  setFollowScroll(follow: boolean): void {
    this.followScroll = follow;
  }

  hide(): void {
    this.el.dataset.visible = 'false';
    this.target = null;
    this.rect = null;
  }

  async withHidden<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.host.style.visibility;
    this.host.style.visibility = 'hidden';
    try {
      return await fn();
    } finally {
      this.host.style.visibility = previous;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.frame) cancelAnimationFrame(this.frame);
    window.removeEventListener('scroll', this.onViewportChange, { capture: true });
    window.removeEventListener('resize', this.onViewportChange);
    this.host.remove();
  }
}

let current: ReadingCursorImpl | null = null;

/**
 * The cursor is a singleton: there is one voice, so there is one marker.
 * Calling this twice hands back the same one rather than stacking two.
 */
export function createReadingCursor(): ReadingCursor {
  if (!current) current = new ReadingCursorImpl();
  return current;
}

/** Tear down the singleton. Safe to call when nothing was ever created. */
export function destroyReadingCursor(): void {
  current?.destroy();
  current = null;
}

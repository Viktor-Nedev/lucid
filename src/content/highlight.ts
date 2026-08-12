/**
 * Overlay primitives: outline an element, or highlight a text range.
 *
 * Everything is drawn into one shared overlay layer that sits above the page
 * and below the panel. Nothing is ever injected into the page's own DOM - no
 * wrapper spans around text, no inline style edits - because mutating a page
 * to highlight it breaks the page's own scripts and, worse, moves the screen
 * reader's cursor. Overlays are aria-hidden for the same reason: they are a
 * visual aid, and the text they point at is already in the accessibility tree.
 *
 *     const handle = outlineElement(el, { scrollIntoView: true });
 *     handle.remove();
 *
 * Boxes follow the page: a rAF-throttled scroll/resize listener repositions
 * every live handle, so a highlight stays on its target as the user scrolls.
 */

import { createLogger } from '../shared/logger.js';
import { adoptExternalStyles } from '../shared/theme.js';

const log = createLogger('content:highlight');

const HOST_ID = 'lucid-overlay-host';

export type HighlightVariant = 'outline' | 'fill' | 'word';

export interface HighlightOptions {
  /**
   * outline - a ring around the target, for "this is what I am describing"
   * fill    - a translucent wash, for a block of text being worked on
   * word    - the strong marker Reading Mode moves word by word
   */
  variant?: HighlightVariant;
  /** Extra pixels around the target rect. Default 2 for outline, 0 otherwise. */
  padding?: number;
  /** Scroll the target into view before drawing. Default false. */
  scrollIntoView?: boolean;
}

export interface HighlightHandle {
  /** Recompute position. Called automatically on scroll and resize. */
  update(): void;
  remove(): void;
}

const STYLES = `
:host {
  all: initial;
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  z-index: 2147483646; /* one below the panel */
  pointer-events: none;
}
.box {
  position: absolute;
  box-sizing: border-box;
  pointer-events: none;
  border-radius: 3px;
}
.outline {
  border: 2px solid #1e5fbf;
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85);
}
.fill {
  background: rgba(30, 95, 191, 0.16);
  border: 1px solid rgba(30, 95, 191, 0.5);
}
.word {
  background: #ffd54a;
  mix-blend-mode: darken;
  border-radius: 2px;
}
@media (prefers-color-scheme: dark) {
  .outline { border-color: #6aa5ff; box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.7); }
  .fill { background: rgba(106, 165, 255, 0.22); border-color: rgba(106, 165, 255, 0.55); }
  .word { background: #ffcf3f; mix-blend-mode: normal; color: #000; }
}
@media (forced-colors: active) {
  .outline, .fill, .word {
    border: 2px solid Highlight;
    background: transparent;
    box-shadow: none;
    forced-color-adjust: none;
  }
  .word { background: Highlight; }
}
`;

class OverlayLayer {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly handles = new Set<HighlightImpl>();
  private frame = 0;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.host.setAttribute('aria-hidden', 'true');
    this.root = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLES;
    this.root.appendChild(style);

    // Design-owned overrides, if this build shipped any. See shared/theme.ts.
    adoptExternalStyles(this.root, 'overlay.css');

    document.documentElement.appendChild(this.host);

    this.scheduleUpdate = this.scheduleUpdate.bind(this);
    // Capture phase so we still hear scrolls from inner scroll containers.
    window.addEventListener('scroll', this.scheduleUpdate, { capture: true, passive: true });
    window.addEventListener('resize', this.scheduleUpdate, { passive: true });
  }

  add(handle: HighlightImpl): void {
    this.handles.add(handle);
    this.root.appendChild(handle.fragment);
  }

  remove(handle: HighlightImpl): void {
    this.handles.delete(handle);
  }

  scheduleUpdate(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      for (const handle of this.handles) handle.update();
    });
  }

  clear(): void {
    for (const handle of [...this.handles]) handle.remove();
  }
}

let layer: OverlayLayer | null = null;

function getLayer(): OverlayLayer {
  if (!layer) layer = new OverlayLayer();
  return layer;
}

/** Rects in document coordinates, so they survive scrolling. */
function documentRects(target: Element | Range): DOMRect[] {
  const rects = Array.from(target.getClientRects());
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  return rects
    .filter((r) => r.width > 0 && r.height > 0)
    .map((r) => new DOMRect(r.left + scrollX, r.top + scrollY, r.width, r.height));
}

class HighlightImpl implements HighlightHandle {
  readonly fragment = document.createDocumentFragment();
  private readonly boxes: HTMLElement[] = [];
  private readonly container: HTMLElement;
  private removed = false;

  constructor(
    private readonly target: Element | Range,
    private readonly options: Required<Pick<HighlightOptions, 'variant' | 'padding'>>,
  ) {
    this.container = document.createElement('div');
    this.fragment.appendChild(this.container);
    this.update();
  }

  update(): void {
    if (this.removed) return;

    const rects = documentRects(this.target);
    const pad = this.options.padding;

    // Reuse boxes across updates so scrolling does not thrash the DOM.
    while (this.boxes.length < rects.length) {
      const box = document.createElement('div');
      box.className = `box ${this.options.variant}`;
      this.boxes.push(box);
      this.container.appendChild(box);
    }
    while (this.boxes.length > rects.length) {
      this.boxes.pop()?.remove();
    }

    rects.forEach((rect, index) => {
      const box = this.boxes[index];
      if (!box) return;
      box.style.left = `${rect.x - pad}px`;
      box.style.top = `${rect.y - pad}px`;
      box.style.width = `${rect.width + pad * 2}px`;
      box.style.height = `${rect.height + pad * 2}px`;
    });
  }

  remove(): void {
    if (this.removed) return;
    this.removed = true;
    this.container.remove();
    this.boxes.length = 0;
    getLayer().remove(this);
  }
}

function create(
  target: Element | Range,
  options: HighlightOptions,
  defaultVariant: HighlightVariant,
): HighlightHandle {
  const variant = options.variant ?? defaultVariant;
  const padding = options.padding ?? (variant === 'outline' ? 2 : 0);

  if (options.scrollIntoView) {
    const element =
      target instanceof Range
        ? (target.startContainer.parentElement ?? document.body)
        : (target as Element);
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  const handle = new HighlightImpl(target, { variant, padding });
  getLayer().add(handle);
  return handle;
}

/** Ring an element - "this is the thing I am describing". */
export function outlineElement(element: Element, options: HighlightOptions = {}): HighlightHandle {
  return create(element, options, 'outline');
}

/**
 * Highlight a text range. Multi-line ranges produce one box per line rect,
 * so wrapped text is highlighted correctly rather than as one giant block.
 */
export function highlightRange(range: Range, options: HighlightOptions = {}): HighlightHandle {
  return create(range, options, 'fill');
}

/**
 * Convenience for Reading Mode: highlight `[start, end)` within one text node.
 * Returns null when the offsets do not fit the node, so a bad word index
 * degrades to "no highlight" rather than throwing mid-sentence.
 */
export function highlightTextSlice(
  node: Text,
  start: number,
  end: number,
  options: HighlightOptions = {},
): HighlightHandle | null {
  const length = node.data.length;
  if (start < 0 || end > length || start >= end) {
    log.debug('highlightTextSlice: offsets out of range', { start, end, length });
    return null;
  }
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return create(range, options, 'word');
}

/** Remove every live highlight. */
export function clearHighlights(): void {
  layer?.clear();
}

/**
 * Hide all overlays for the duration of `fn`. capture.ts wraps screenshots in
 * this so highlights do not end up baked into the image the model sees.
 */
export async function withHighlightsHidden<T>(fn: () => Promise<T>): Promise<T> {
  const host = layer?.host;
  const previous = host?.style.visibility ?? '';
  if (host) host.style.visibility = 'hidden';
  try {
    return await fn();
  } finally {
    if (host) host.style.visibility = previous;
  }
}

/**
 * Chart trend narration.
 *
 * Marks every chart-like region on the page with a small button. Pressing it
 * captures that region, sends it for structured extraction, and presents the
 * result two ways at once: a real <table> a screen reader can walk cell by
 * cell, and a spoken narration of what the numbers actually do.
 *
 * DETECTION IS DELIBERATELY LIBRARY-BLIND. The obvious implementation looks
 * for Chart.js / D3 / Plotly signatures, and it fails on the first chart that
 * matters: a <canvas> somebody drew by hand with raw 2D calls carries no
 * signature at all, and neither does server-rendered SVG. So the test is
 * structural - a canvas big enough to be a chart, or an inline SVG with enough
 * graphical nodes to be one - which catches hand-drawn and library charts
 * alike. It also means the occasional false positive on a large decorative
 * canvas, which is the right trade: a spurious button is a small annoyance,
 * a missed chart is the whole feature failing.
 *
 * The badge layer is a THIRD piece of Lucid UI on the page. capture.ts knows
 * to hide the panel and the highlight layer during a screenshot, but it does
 * not know about this one - and the badge sits directly on top of the chart it
 * would photograph. Hence hideBadges() around every capture below. Any future
 * feature that captures a region while badges are visible has the same problem.
 */

import type { ChartData } from '../../shared/messages.js';
import { cacheKeyFor } from '../../shared/storage.js';
import type { FeatureContext } from '../context.js';

/** Below this a region is an icon or a sparkline, not a chart worth reading. */
const MIN_WIDTH = 150;
const MIN_HEIGHT = 80;

/** How many drawing nodes an inline SVG needs before it counts as a chart. */
const MIN_SVG_NODES = 6;

const SVG_GRAPHICAL = 'path,rect,circle,ellipse,line,polyline,polygon,text';

/** Only used for <img>, where there is no structure to inspect. */
const IMG_CHART_HINT = /chart|graph|plot|histogram|trend/i;

/** Re-scan is debounced: a live dashboard can mutate continuously. */
const RESCAN_DELAY_MS = 400;

export function register(ctx: FeatureContext): void {
  const badges = new Map<Element, HTMLButtonElement>();
  let layer: HTMLElement | null = null;
  let root: ShadowRoot | null = null;
  let rescanTimer = 0;
  let frame = 0;
  let lastNarration = '';

  // --- the badge layer ------------------------------------------------------

  function ensureLayer(): ShadowRoot {
    if (root) return root;

    layer = document.createElement('div');
    layer.id = 'lucid-chart-badges';
    // Fixed, so badges follow the page without a scroll listener doing layout
    // maths in page coordinates. The host itself is inert; the buttons inside
    // re-enable pointer events.
    layer.style.cssText =
      'position:fixed;inset:0;z-index:2147483646;pointer-events:none;border:0;margin:0;padding:0;';

    root = layer.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = BADGE_CSS;
    root.append(style);
    document.documentElement.append(layer);
    return root;
  }

  function hideBadges(): void {
    if (layer) layer.style.visibility = 'hidden';
  }

  function showBadges(): void {
    if (layer) layer.style.visibility = '';
  }

  // --- detection ------------------------------------------------------------

  function isBigEnough(rect: DOMRect): boolean {
    return rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT;
  }

  function isDisplayed(el: Element): boolean {
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function isChartCandidate(el: Element): boolean {
    if (!isBigEnough(el.getBoundingClientRect()) || !isDisplayed(el)) return false;

    if (el instanceof HTMLCanvasElement) return true;

    if (el instanceof SVGSVGElement) {
      // Only the outermost SVG; a nested <svg> is part of its parent's drawing.
      if (el.parentElement?.closest('svg')) return false;
      return el.querySelectorAll(SVG_GRAPHICAL).length >= MIN_SVG_NODES;
    }

    if (el instanceof HTMLImageElement) {
      // No structure to inspect, so fall back to what the page calls it. Kept
      // strict on purpose: a photograph that happens to be large is not a chart.
      return IMG_CHART_HINT.test(`${el.alt} ${el.id} ${el.className} ${el.getAttribute('src') ?? ''}`);
    }

    return false;
  }

  /**
   * Collect candidates through open shadow roots as well as the light DOM.
   *
   * This is not defensive coding. The Chart.js docs render their sample canvas
   * inside a shadow root: the canvas is in the accessibility tree, but
   * document.querySelector('canvas') returns null, so a light-DOM-only scan
   * misses a real chart on one of the two reference sites. Closed shadow roots
   * stay invisible to everyone and there is nothing to be done about those.
   */
  function collectDeep(scope: Document | ShadowRoot, out: Element[]): void {
    out.push(...Array.from(scope.querySelectorAll('canvas,svg,img')));
    for (const el of Array.from(scope.querySelectorAll('*'))) {
      const nested = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      // Never descend into our own badge layer - its icons are shadow content too.
      if (nested && el !== layer) collectDeep(nested, out);
    }
  }

  function findCandidates(): Element[] {
    const found: Element[] = [];
    collectDeep(document, found);
    return found.filter(isChartCandidate);
  }

  // --- badges ---------------------------------------------------------------

  function labelFor(el: Element): string {
    const explicit =
      el.getAttribute('aria-label') ??
      (el instanceof HTMLImageElement ? el.alt : '') ??
      '';
    if (explicit.trim()) return `Read chart data: ${explicit.trim()}`;

    const figure = el.closest('figure');
    const caption = figure?.querySelector('figcaption')?.textContent?.trim();
    if (caption) return `Read chart data: ${caption.slice(0, 80)}`;

    return 'Read the data behind this chart';
  }

  function createBadge(el: Element): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'badge';
    button.setAttribute('aria-label', labelFor(el));
    button.title = 'Read this chart with Lucid';
    button.innerHTML = BADGE_ICON;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void describeChart(el);
    });
    return button;
  }

  /** Park a badge in the target's top-right corner, or hide it off-viewport. */
  function positionBadge(el: Element, badge: HTMLButtonElement): void {
    const rect = el.getBoundingClientRect();
    const offscreen =
      rect.bottom <= 0 ||
      rect.top >= window.innerHeight ||
      rect.right <= 0 ||
      rect.left >= window.innerWidth;

    if (offscreen || !isBigEnough(rect)) {
      badge.style.display = 'none';
      return;
    }
    badge.style.display = '';
    badge.style.top = `${Math.max(4, rect.top + 8)}px`;
    badge.style.left = `${Math.min(window.innerWidth - 40, rect.right - 40)}px`;
  }

  function reposition(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const [el, badge] of badges) positionBadge(el, badge);
    });
  }

  function scan(): void {
    const found = new Set(findCandidates());

    for (const [el, badge] of badges) {
      if (!found.has(el) || !el.isConnected) {
        badge.remove();
        badges.delete(el);
      }
    }

    for (const el of found) {
      if (badges.has(el)) continue;
      const badge = createBadge(el);
      ensureLayer().append(badge);
      badges.set(el, badge);
    }

    if (badges.size > 0) ctx.log.debug(`marked ${badges.size} chart(s)`);
    reposition();
  }

  function scheduleScan(): void {
    window.clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(scan, RESCAN_DELAY_MS);
  }

  // --- reading a chart ------------------------------------------------------

  /** Stable enough to cache on: same page, same element, same size. */
  async function cacheKeyFor_(el: Element): Promise<string> {
    const rect = el.getBoundingClientRect();
    const index = Array.from(document.querySelectorAll(el.tagName)).indexOf(el);
    return cacheKeyFor(
      location.href,
      'chart',
      `${el.tagName.toLowerCase()}#${el.id || index}`,
      Math.round(rect.width),
      Math.round(rect.height),
    );
  }

  function narrationFor(chart: ChartData): string {
    const parts = [chart.summary.trim(), ...chart.notes.map((n) => n.trim())];
    return parts.filter(Boolean).join(' ');
  }

  function bodyFor(chart: ChartData): string {
    const notes = chart.notes.filter((n) => n.trim());
    if (notes.length === 0) return chart.summary;
    return `${chart.summary}\n\n${notes.map((n) => `• ${n}`).join('\n')}`;
  }

  async function speakNarration(text: string): Promise<void> {
    if (!text) return;
    const settings = await ctx.settings();
    ctx.tts.speak(text, { rate: settings.tts.rate, voiceURI: settings.tts.voiceURI });
  }

  async function describeChart(el: Element): Promise<void> {
    ctx.panel.show({ title: 'Reading the chart', busy: true, status: 'Reading values…' });

    try {
      // The badge is drawn on top of the chart; capture would photograph it.
      hideBadges();
      let image;
      let contextText: string;
      try {
        image = await ctx.capture.captureElement(el);
        contextText = ctx.capture.contextTextFor(el);
      } finally {
        showBadges();
      }

      const cacheKey = await cacheKeyFor_(el);
      const { chart } = await ctx.send('ai.extractChartData', { image, contextText, cacheKey });

      // panel.update() un-hides a hidden panel, so a result arriving after the
      // user pressed Escape would resurrect a panel they deliberately closed.
      if (!ctx.panel.isOpen()) {
        ctx.log.debug('panel dismissed while reading the chart; dropping result');
        return;
      }

      // Not every image is a chart. When the model cannot read one it returns
      // empty columns and rows and explains why in the summary - showing an
      // empty table there is worse than showing nothing.
      const hasTable = chart.columns.length > 0 && chart.rows.length > 0;
      lastNarration = narrationFor(chart);

      ctx.panel.update({
        title: chart.title || 'Chart data',
        body: bodyFor(chart),
        table: hasTable
          ? { columns: chart.columns, rows: chart.rows, caption: chart.title || undefined }
          : undefined,
        actions: [
          { id: 'chart:speak', label: 'Read aloud' },
          { id: 'chart:stop', label: 'Stop' },
        ],
        busy: false,
        status: undefined,
        error: undefined,
      });

      await speakNarration(lastNarration);
    } catch (err) {
      showBadges();
      ctx.panel.setError(err instanceof Error ? err.message : String(err));
    }
  }

  // --- wiring ---------------------------------------------------------------

  // Action ids are namespaced because onAction handlers are GLOBAL - every
  // feature's handler receives every button id, and content/index.ts maps the
  // bare ids 'explain', 'simplify' and 'read' straight to dispatch(). A button
  // called 'read' here would double-fire into read-aloud.
  ctx.panel.onAction((id) => {
    if (id === 'chart:speak') void speakNarration(lastNarration);
    else if (id === 'chart:stop') ctx.tts.cancelAll();
  });

  // Charts are drawn after DOMContentLoaded more often than not, and a canvas
  // exists in the DOM before anything is painted into it, so one scan at
  // startup is not enough.
  scan();
  window.setTimeout(scan, 800);

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener('scroll', reposition, { passive: true, capture: true });
  window.addEventListener('resize', reposition, { passive: true });

  ctx.log.debug('chart feature registered');
}

const BADGE_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <rect x="2" y="9" width="3" height="5" rx="1"/>
  <rect x="6.5" y="5" width="3" height="9" rx="1"/>
  <rect x="11" y="2" width="3" height="12" rx="1"/>
</svg>`;

const BADGE_CSS = `
:host { all: initial; }
.badge {
  position: fixed;
  width: 32px;
  height: 32px;
  padding: 0;
  display: grid;
  place-items: center;
  pointer-events: auto;
  cursor: pointer;
  border: 1px solid var(--lucid-border, rgba(0, 0, 0, 0.25));
  border-radius: var(--lucid-radius, 8px);
  background: var(--lucid-bg, #ffffff);
  color: var(--lucid-accent, #0b5cad);
  box-shadow: var(--lucid-shadow, 0 2px 8px rgba(0, 0, 0, 0.28));
  line-height: 0;
}
.badge:hover { background: var(--lucid-accent, #0b5cad); color: var(--lucid-bg, #ffffff); }
.badge:focus-visible {
  outline: 3px solid var(--lucid-accent, #0b5cad);
  outline-offset: 2px;
}
.badge svg { width: 17px; height: 17px; fill: currentColor; }

@media (prefers-color-scheme: dark) {
  .badge {
    border-color: var(--lucid-border, rgba(255, 255, 255, 0.3));
    background: var(--lucid-bg, #1d2126);
    color: var(--lucid-accent, #7cc0ff);
  }
}

/* Windows High Contrast: system colours only, and keep a visible edge. */
@media (forced-colors: active) {
  .badge {
    background: ButtonFace;
    color: ButtonText;
    border-color: ButtonBorder;
    forced-color-adjust: none;
  }
  .badge:hover, .badge:focus-visible { background: Highlight; color: HighlightText; }
}
`;

/**
 * Explain - Alt+Shift+E describes whatever visual the user is looking at.
 *
 * This is aimed at content a screen reader passes over in silence: an <img>
 * with no alt text, a canvas chart, an inline SVG marked role="presentation".
 * The description is streamed into the shared panel AND spoken, because the
 * person who most needs it may not be reading the panel at all.
 *
 * PICKING THE TARGET is most of the work. "Explain this" has to mean something
 * when the user has not selected anything, so the target is resolved in
 * priority order: an explicit selection, then whatever the pointer is over,
 * then the focused element, and finally the largest visual in the viewport -
 * which is what makes "scroll a figure into view and press the key" work, and
 * that is how the feature is actually demonstrated.
 *
 * The page is never modified. We capture pixels and draw in shadow roots.
 */

import type { StreamHandle } from '../../shared/messages.js';
import { cacheKeyFor } from '../../shared/storage.js';
import type { FeatureContext } from '../context.js';

/** Speech handle type, taken off ctx so this file never imports tts.js. */
type Speech = ReturnType<FeatureContext['tts']['speak']>;

/** Things worth describing. Ordinary containers are not targets. */
const VISUAL = 'img,svg,canvas,video,[role="img"]';

/** Containers that wrap a visual; hovering one means the visual inside it. */
const VISUAL_WRAPPER = 'figure,picture';

/** Below this a region is an icon or a spacer, not something to describe. */
const MIN_WIDTH = 100;
const MIN_HEIGHT = 60;

/** Action ids are namespaced: every feature's handler sees every button press. */
const ACTION_SPEAK = 'explain:speak';

export function register(ctx: FeatureContext): void {
  let inFlight: StreamHandle | null = null;
  let speech: Speech | null = null;
  let outline: { remove(): void } | null = null;
  let result = '';
  /** Last element the pointer moved over, for "explain what I am pointing at". */
  let hovered: Element | null = null;

  // --- target selection -----------------------------------------------------

  function rectOf(el: Element): DOMRect {
    return el.getBoundingClientRect();
  }

  function isBigEnough(el: Element): boolean {
    const rect = rectOf(el);
    return rect.width >= MIN_WIDTH && rect.height >= MIN_HEIGHT;
  }

  function isDisplayed(el: Element): boolean {
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  function isUsable(el: Element | null): el is Element {
    return !!el && el.isConnected && isDisplayed(el) && isBigEnough(el);
  }

  /** The visual at or around `el`: itself, its enclosing visual, or its content. */
  function visualFor(el: Element | null): Element | null {
    if (!el) return null;
    const self = el.closest(VISUAL);
    if (self) return self;
    // Hovering a <figure> means the picture in it, not the caption.
    const wrapper = el.closest(VISUAL_WRAPPER);
    const inner = wrapper?.querySelector(VISUAL);
    return inner ?? null;
  }

  /** How much of an element is actually on screen, in square pixels. */
  function visibleArea(el: Element): number {
    const rect = rectOf(el);
    const width = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
    const height = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    return width > 0 && height > 0 ? width * height : 0;
  }

  /**
   * The biggest visual currently on screen. This is the fallback that makes
   * the shortcut work with nothing selected and no pointer involved, which is
   * how a keyboard-only or screen reader user reaches it.
   */
  function largestVisualInViewport(): Element | null {
    let best: Element | null = null;
    let bestArea = 0;
    for (const el of Array.from(document.querySelectorAll(VISUAL))) {
      // A nested <svg> is part of its parent's drawing, not its own subject.
      if (el.tagName.toLowerCase() === 'svg' && el.parentElement?.closest('svg')) continue;
      if (!isUsable(el)) continue;
      const area = visibleArea(el);
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  }

  /** The element holding the current selection, if there is a real one. */
  function selectionElement(): Element | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    if (!String(selection).trim()) return null;

    const node = selection.getRangeAt(0).commonAncestorContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    // A selection inside a figure means that figure's picture.
    return visualFor(el) ?? el;
  }

  function pickTarget(): Element | null {
    const selected = selectionElement();
    if (isUsable(selected)) return selected;

    const pointed = visualFor(hovered);
    if (isUsable(pointed)) return pointed;

    const focused = visualFor(document.activeElement);
    if (isUsable(focused)) return focused;

    return largestVisualInViewport();
  }

  // --- speech and actions ---------------------------------------------------

  function stopSpeech(): void {
    speech?.cancel();
    speech = null;
  }

  function cancelInFlight(): void {
    inFlight?.cancel();
    inFlight = null;
  }

  function clearOutline(): void {
    outline?.remove();
    outline = null;
  }

  function renderActions(): void {
    // update() un-hides the panel, so a late callback must not drag a panel
    // the user dismissed back onto the screen.
    if (!ctx.panel.isOpen()) return;
    ctx.panel.update({
      actions: [
        { id: ACTION_SPEAK, label: speech ? 'Stop reading' : 'Read aloud', primary: true },
      ],
    });
  }

  function speakResult(): void {
    if (speech) {
      stopSpeech();
      renderActions();
      return;
    }
    if (!result.trim()) return;

    void ctx.settings().then((settings) => {
      speech = ctx.tts.speak(result, {
        rate: settings.tts.rate,
        voiceURI: settings.tts.voiceURI,
        onEnd: () => {
          speech = null;
          renderActions();
        },
        onError: () => {
          speech = null;
          renderActions();
        },
      });
      renderActions();
    });
  }

  // --- the run --------------------------------------------------------------

  /** Stable per page, target and size, so a repeat press costs no request. */
  async function keyFor(el: Element): Promise<string> {
    const rect = rectOf(el);
    const siblings = Array.from(document.querySelectorAll(el.tagName));
    const index = siblings.indexOf(el);
    return cacheKeyFor(
      location.href,
      'explain',
      `${el.tagName.toLowerCase()}#${el.id || index}`,
      Math.round(rect.width),
      Math.round(rect.height),
    );
  }

  async function explain(): Promise<void> {
    // One request and one voice at a time; a second press replaces the first.
    cancelInFlight();
    stopSpeech();
    clearOutline();

    const target = pickTarget();
    if (!target) {
      ctx.panel.show({
        title: 'Explain',
        body: 'Point at an image, chart or diagram - or scroll one into view - then press Alt+Shift+E. Lucid describes what is actually shown, without changing the page.',
      });
      return;
    }

    // Drawn in the overlay layer, which capture.ts hides for the screenshot.
    outline = ctx.highlight.outlineElement(target);
    ctx.panel.beginStream('Explaining this', 'Looking at it...');
    result = '';

    try {
      // capture.ts hides every Lucid overlay for the shot, the chart feature's
      // badge layer included, so nothing of ours ends up in the pixels.
      const image = await ctx.capture.captureElement(target);
      const contextText = ctx.capture.contextTextFor(target);

      const cacheKey = await keyFor(target);

      inFlight = ctx.stream(
        'ai.explainRegion',
        { image, contextText, cacheKey },
        {
          onDelta: (delta) => {
            result += delta.text;
            ctx.panel.appendBody(delta.text);
          },
          onDone: (data) => {
            inFlight = null;
            if (data.text) result = data.text;
            clearOutline();
            if (!ctx.panel.isOpen()) {
              ctx.log.debug('panel dismissed mid-generation; dropping result');
              return;
            }
            // Not optional: this is what announces the finished description to
            // a screen reader exactly once.
            ctx.panel.endStream();
            renderActions();
            if (data.cached) ctx.panel.update({ status: 'Reused an earlier description.' });
            // Spoken automatically - the person who needs this most is not
            // necessarily reading the panel.
            speakResult();
          },
          onError: (error) => {
            inFlight = null;
            clearOutline();
            // The message is already written for a human, missing_api_key
            // included, so it goes straight into the panel.
            ctx.panel.setError(error.message);
          },
        },
      );
    } catch (err) {
      clearOutline();
      ctx.panel.setError(err instanceof Error ? err.message : String(err));
    }
  }

  // --- wiring ---------------------------------------------------------------

  window.addEventListener(
    'mousemove',
    (event) => {
      hovered = event.target instanceof Element ? event.target : null;
    },
    { passive: true, capture: true },
  );

  ctx.onCommand('command.explainSelection', () => explain());

  ctx.panel.onAction((id) => {
    if (id === ACTION_SPEAK) speakResult();
    // Any other id belongs to another feature.
  });

  ctx.panel.onDismiss(() => {
    // Stop paying for a generation nobody will read. The shared teardown in
    // index.ts already cancels the voice; just drop our handle on it.
    cancelInFlight();
    clearOutline();
    speech = null;
  });

  ctx.log.debug('explain feature registered');
}

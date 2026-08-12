/**
 * STUB - owned by the Explain worker. Fill this file in; touch nothing else.
 *
 * Goal: user selects text or points at an image, presses Alt+Shift+E, and gets
 * a plain-language explanation of it in the panel.
 *
 * Everything you need is on `ctx` - do not import panel.js, capture.js or
 * highlight.js directly, and do not edit content/index.ts. This file is
 * already imported and registered there.
 *
 * Sketch:
 *
 *   export function register(ctx: FeatureContext): void {
 *     ctx.onCommand('command.explainSelection', async () => {
 *       const element = pickTarget();                       // selection or hovered image
 *       const outline = ctx.highlight.outlineElement(element);
 *       ctx.panel.beginStream('Explaining this', 'Looking at it...');
 *       try {
 *         const image = await ctx.capture.captureElement(element);
 *         const contextText = ctx.capture.contextTextFor(element);
 *         ctx.stream('ai.explainRegion', { image, contextText }, {
 *           onDelta: (d) => ctx.panel.appendBody(d.text),
 *           onDone: () => { ctx.panel.endStream(); outline.remove(); },
 *           onError: (e) => { ctx.panel.setError(e.message); outline.remove(); },
 *         });
 *       } catch (err) {
 *         ctx.panel.setError((err as Error).message);
 *         outline.remove();
 *       }
 *     });
 *   }
 *
 * Two things worth getting right:
 *
 * - Capture already handles scrolling, paint timing, HiDPI and hiding Lucid's
 *   own UI. Just hand it an element.
 * - Pass a cacheKey built with cacheKeyFor(location.href, 'explain', selector)
 *   so pressing the shortcut twice on the same image is instant and free.
 */

import type { FeatureContext } from '../context.js';

export function register(ctx: FeatureContext): void {
  ctx.log.debug('explain feature registered (stub)');
}

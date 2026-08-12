/**
 * STUB - owned by the Reading Mode worker. Fill this file in; touch nothing else.
 *
 * Goal: Alt+Shift+L reads the whole page aloud with the current word
 * highlighted in place, so someone can follow along visually while listening.
 *
 * This is the feature the TTS module was designed around. The two pieces that
 * make it work:
 *
 * - ctx.tts.speak() gives you onBoundary with a `charIndex` into the ORIGINAL
 *   text you passed, continuous across the whole document. Chunking happens
 *   internally; you never see it.
 * - ctx.highlight.highlightTextSlice(node, start, end) paints one word without
 *   modifying the page DOM.
 *
 * So the loop is: build a flat string of the page's readable text while
 * recording which text node each character came from, then on each boundary
 * event map charIndex back to (node, offset) and move the highlight.
 *
 *   export function register(ctx: FeatureContext): void {
 *     ctx.onCommand('command.readPage', async () => {
 *       const { text, map } = buildReadableText(document.body);  // yours
 *       let current = null;
 *       const settings = await ctx.settings();
 *       ctx.tts.speak(text, {
 *         rate: settings.tts.rate,
 *         voiceURI: settings.tts.voiceURI,
 *         onBoundary: ({ charIndex, charLength }) => {
 *           const hit = map.locate(charIndex);                   // yours
 *           current?.remove();
 *           if (hit) current = ctx.highlight.highlightTextSlice(
 *             hit.node, hit.offset, hit.offset + charLength, { variant: 'word' });
 *         },
 *         onEnd: () => current?.remove(),
 *       });
 *     });
 *   }
 *
 * Also worth doing: scroll the highlighted word into view when it leaves the
 * viewport, and make a second press of the shortcut stop rather than restart.
 * ctx.tts.isSpeaking() tells you which case you are in.
 */

import type { FeatureContext } from '../context.js';

export function register(ctx: FeatureContext): void {
  ctx.log.debug('reading mode feature registered (stub)');
}

/**
 * STUB - owned by the Simplify worker. Fill this file in; touch nothing else.
 *
 * Goal: Alt+Shift+S rewrites the selected text in plain language and shows it
 * in the panel, keeping every fact intact.
 *
 * The output surface is ctx.panel - the shared in-page panel, NOT the Chrome
 * side panel API. Explain renders into the same panel, so follow the same
 * beginStream / appendBody / endStream shape and the two features will feel
 * like one product.
 *
 *   export function register(ctx: FeatureContext): void {
 *     ctx.onCommand('command.simplifySelection', async () => {
 *       const text = String(window.getSelection() ?? '').trim();
 *       if (!text) {
 *         ctx.panel.show({ title: 'Simplify', body: 'Select some text first, then try again.' });
 *         return;
 *       }
 *       ctx.panel.beginStream('In plain language', 'Rewriting...');
 *       ctx.stream('ai.simplifyText', { text }, {
 *         onDelta: (d) => ctx.panel.appendBody(d.text),
 *         onDone: () => ctx.panel.endStream(),
 *         onError: (e) => ctx.panel.setError(e.message),
 *       });
 *     });
 *   }
 *
 * Reading level comes from settings by default. If you add a control to switch
 * it per-request, pass `readingLevel` in the payload and offer all three
 * ('plain' | 'simple' | 'child') - they are meaningfully different audiences,
 * not a difficulty slider.
 *
 * Nice addition once the basics work: a panel action that reads the simplified
 * text aloud via ctx.tts.speak, since the two audiences overlap heavily.
 */

import type { FeatureContext } from '../context.js';

export function register(ctx: FeatureContext): void {
  ctx.log.debug('simplify feature registered (stub)');
}

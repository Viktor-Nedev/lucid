/**
 * STUB - owned by the Voice worker (Phase 7). Fill this file in; touch nothing else.
 *
 * Goal: hands-free control - the user speaks a command, Lucid runs it.
 *
 * Bound to the 'voice-wake' command, which is declared in the manifest with no
 * default key: Chrome allows only four suggested shortcuts and the other four
 * were spoken for. The user assigns one at chrome://extensions/shortcuts, and
 * the toolbar button is always available as a fallback.
 *
 *   export function register(ctx: FeatureContext): void {
 *     ctx.onCommand('command.voiceWake', async () => {
 *       ctx.panel.show({ title: 'Listening', busy: true, status: 'Say a command...' });
 *       ...
 *     });
 *   }
 *
 * MICROPHONE ACCESS - read this before writing any of it:
 *
 * A content script cannot hold a durable mic grant, and the service worker has
 * no DOM to call getUserMedia from. That is why "offscreen" is already in the
 * manifest permissions and src/offscreen/ already exists: an offscreen
 * document is a hidden page owned by the extension that can hold the grant and
 * run recognition, messaging results back through the normal router.
 *
 * The offscreen scaffold is wired but empty. Create the document from the
 * service worker with chrome.offscreen.createDocument({ url: 'offscreen.html',
 * reasons: ['USER_MEDIA'], justification: '...' }), and remember only one
 * offscreen document may exist at a time - check chrome.offscreen.hasDocument()
 * before creating.
 *
 * If you use SpeechRecognition rather than raw audio, note it is webkit-prefixed
 * in Chrome and needs a network round trip, so it is not instant.
 */

import type { FeatureContext } from '../context.js';

export function register(ctx: FeatureContext): void {
  ctx.log.debug('voice feature registered (stub)');
}

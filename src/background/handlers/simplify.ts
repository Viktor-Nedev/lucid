/**
 * STUB - owned by the Simplify worker. Fill this file in; touch nothing else.
 *
 * Route:    'ai.simplifyText'  (streaming)
 * Request:  SimplifyTextRequest { text, readingLevel?, cacheKey? }
 * Response: SimplifyTextResponse { text, cached }
 * AI call:  client.simplifyText(text, { signal, onDelta, readingLevel })
 *
 * Already wired for you: this file is imported and registered by
 * service-worker.ts, and the panel already renders streamed deltas. Replace
 * the throw with the body below and the feature is live.
 *
 *   export function register(router: MessageRouter<BackgroundRoutes>): void {
 *     router.onStream('ai.simplifyText', async (payload, ctx) => {
 *       if (payload.cacheKey) {
 *         const hit = await getCached<string>(payload.cacheKey);
 *         if (hit) { ctx.emit(hit); return { text: hit, cached: true }; }
 *       }
 *       const client = await getAIClient();
 *       const text = await client.simplifyText(payload.text, {
 *         signal: ctx.signal,
 *         onDelta: ctx.emit,
 *         ...(payload.readingLevel ? { readingLevel: payload.readingLevel } : {}),
 *       });
 *       if (payload.cacheKey) await setCached(payload.cacheKey, text);
 *       return { text, cached: false };
 *     });
 *   }
 *
 * Reading level: omit it and the adapter uses the user's configured default
 * from settings. Only pass it when the UI is overriding for one request.
 *
 * Long selections: shared/prompts.ts caps input at MAX_SIMPLIFY_CHARS. If you
 * need whole-article simplification, chunk on paragraph boundaries here and
 * emit each result as it lands - do not raise the cap.
 */

import type { BackgroundRoutes } from '../../shared/messages.js';
import { LucidError, MessageRouter } from '../../shared/messages.js';

export function register(router: MessageRouter<BackgroundRoutes>): void {
  router.onStream('ai.simplifyText', async () => {
    throw new LucidError(
      'Simplify is not implemented yet (background/handlers/simplify.ts).',
      'not_implemented',
      false,
    );
  });
}

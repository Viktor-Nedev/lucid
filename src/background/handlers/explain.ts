/**
 * STUB - owned by the Explain worker. Fill this file in; touch nothing else.
 *
 * Route:    'ai.explainRegion'  (streaming)
 * Request:  ExplainRegionRequest { image, contextText, cacheKey? }
 * Response: ExplainRegionResponse { text, cached }
 * AI call:  client.describeImage(base64, contextText, { signal, onDelta })
 *
 * Already wired for you: this file is imported and registered by
 * service-worker.ts, the content side already captures the region and opens
 * the stream, and the panel already renders deltas. Replace the throw with the
 * body below and the feature is live.
 *
 *   export function register(router: MessageRouter<BackgroundRoutes>): void {
 *     router.onStream('ai.explainRegion', async (payload, ctx) => {
 *       if (payload.cacheKey) {
 *         const hit = await getCached<string>(payload.cacheKey);
 *         if (hit) { ctx.emit(hit); return { text: hit, cached: true }; }
 *       }
 *       const client = await getAIClient();
 *       const text = await client.describeImage(payload.image.base64, payload.contextText, {
 *         signal: ctx.signal,
 *         onDelta: ctx.emit,
 *       });
 *       if (payload.cacheKey) await setCached(payload.cacheKey, text);
 *       return { text, cached: false };
 *     });
 *   }
 *
 * Note on the cache-hit path: emit the cached text before returning, so the
 * panel renders identically whether the answer was generated or replayed.
 */

import type { BackgroundRoutes } from '../../shared/messages.js';
import { LucidError, MessageRouter } from '../../shared/messages.js';

export function register(router: MessageRouter<BackgroundRoutes>): void {
  router.onStream('ai.explainRegion', async () => {
    throw new LucidError(
      'Explain is not implemented yet (background/handlers/explain.ts).',
      'not_implemented',
      false,
    );
  });
}

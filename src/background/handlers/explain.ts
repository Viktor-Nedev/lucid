/**
 * Explain - accessibility description of a captured screen region.
 *
 * Route:    'ai.explainRegion'  (streaming)
 * Request:  ExplainRegionRequest { image, contextText, cacheKey? }
 * Response: ExplainRegionResponse { text, cached }
 * AI call:  client.describeImage(base64, contextText, { signal, onDelta })
 *
 * Streams for the same reason Simplify does: a description of a complex
 * diagram takes several seconds, and watching words appear beats watching a
 * spinner. `ctx.signal` aborts the HTTP request when the caller disconnects
 * the port, so dismissing the panel mid-generation stops paying for tokens
 * nobody will read.
 *
 * Cached on the content side by page URL plus target, so pressing the
 * shortcut twice on the same image costs one API call rather than two.
 */

import type { BackgroundRoutes } from '../../shared/messages.js';
import { MessageRouter } from '../../shared/messages.js';
import { getCached, setCached } from '../../shared/storage.js';
import { getAIClient } from '../ai/client.js';

export function register(router: MessageRouter<BackgroundRoutes>): void {
  router.onStream('ai.explainRegion', async (payload, ctx) => {
    if (payload.cacheKey) {
      const hit = await getCached<string>(payload.cacheKey);
      if (hit) {
        // Replay through emit so a cache hit renders exactly like a fresh
        // generation - the panel only ever sees deltas.
        ctx.emit(hit);
        return { text: hit, cached: true };
      }
    }

    const client = await getAIClient();
    const text = await client.describeImage(payload.image.base64, payload.contextText, {
      signal: ctx.signal,
      onDelta: ctx.emit,
    });

    if (payload.cacheKey) await setCached(payload.cacheKey, text);
    return { text, cached: false };
  });
}

/**
 * Simplify - plain-language rewrite of selected text.
 *
 * Route:    'ai.simplifyText'  (streaming)
 * Request:  SimplifyTextRequest { text, readingLevel?, cacheKey? }
 * Response: SimplifyTextResponse { text, cached }
 * AI call:  client.simplifyText(text, { signal, onDelta, readingLevel })
 *
 * The rewrite streams because a user should watch words appear rather than a
 * spinner. `ctx.signal` aborts the underlying HTTP request when the caller
 * disconnects the port, so dismissing the panel mid-generation stops paying
 * for tokens nobody will read.
 */

import type { BackgroundRoutes } from '../../shared/messages.js';
import { MessageRouter } from '../../shared/messages.js';
import { getCached, setCached } from '../../shared/storage.js';
import { getAIClient } from '../ai/client.js';

export function register(router: MessageRouter<BackgroundRoutes>): void {
  router.onStream('ai.simplifyText', async (payload, ctx) => {
    if (payload.cacheKey) {
      const hit = await getCached<string>(payload.cacheKey);
      if (hit) {
        // Emit before returning: the panel only ever sees deltas, so replaying
        // the cached answer through the same path makes a cache hit render
        // identically to a fresh generation.
        ctx.emit(hit);
        return { text: hit, cached: true };
      }
    }

    const client = await getAIClient();
    const text = await client.simplifyText(payload.text, {
      signal: ctx.signal,
      onDelta: ctx.emit,
      // Omitted means "use the configured default"; the content script sends
      // it explicitly only when the panel is overriding for one request.
      ...(payload.readingLevel ? { readingLevel: payload.readingLevel } : {}),
    });

    if (payload.cacheKey) await setCached(payload.cacheKey, text);
    return { text, cached: false };
  });
}

/**
 * 'ai.inferFieldPurpose' - work out what each field of a form is asking for.
 *
 * Request/response rather than streaming: the answer is a structured array,
 * and the content script cannot render half of it usefully.
 *
 * The response echoes back the `id` the content script assigned during its
 * scan. Callers correlate on that id and never on array position - the prompt
 * asks for order to be preserved, but a model is not a guarantee.
 *
 * Privacy: the descriptors that arrive here carry field METADATA only - label,
 * name, type, placeholder, nearby text. The content script never reads the
 * value a user has typed, and nothing in this file should ever start.
 */

import type { BackgroundRoutes, FormFieldPurpose } from '../../shared/messages.js';
import { MessageRouter } from '../../shared/messages.js';
import { getCached, setCached } from '../../shared/storage.js';

import { getAIClient } from '../ai/client.js';

export function register(router: MessageRouter<BackgroundRoutes>): void {
  router.on('ai.inferFieldPurpose', async (payload) => {
    if (payload.cacheKey) {
      const hit = await getCached<FormFieldPurpose[]>(payload.cacheKey);
      if (hit) return { fields: hit, cached: true };
    }

    // Throws LucidError('missing_api_key') when no key is set; the router
    // serialises it and the panel shows the message as written.
    const client = await getAIClient();
    const fields = await client.inferFieldPurpose(payload.domContext);

    if (payload.cacheKey) await setCached(payload.cacheKey, fields);
    return { fields, cached: false };
  });
}

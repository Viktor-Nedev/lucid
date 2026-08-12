/**
 * STUB - owned by the Form worker. Fill this file in; touch nothing else.
 *
 * Route:    'ai.inferFieldPurpose'  (request/response, not streaming)
 * Request:  InferFieldPurposeRequest { domContext, cacheKey? }
 * Response: InferFieldPurposeResponse { fields, cached }
 * AI call:  client.inferFieldPurpose(domContext, { signal })
 *
 *   export function register(router: MessageRouter<BackgroundRoutes>): void {
 *     router.on('ai.inferFieldPurpose', async (payload) => {
 *       if (payload.cacheKey) {
 *         const hit = await getCached<FormFieldPurpose[]>(payload.cacheKey);
 *         if (hit) return { fields: hit, cached: true };
 *       }
 *       const client = await getAIClient();
 *       const fields = await client.inferFieldPurpose(payload.domContext);
 *       if (payload.cacheKey) await setCached(payload.cacheKey, fields);
 *       return { fields, cached: false };
 *     });
 *   }
 *
 * The response carries `id` back for every field, matching the id the content
 * script assigned during its scan - correlate on that, never on array order,
 * even though the prompt asks for order to be preserved.
 *
 * `sensitive: true` marks fields collecting government identifiers, payment
 * details, health data or passwords. Surface that visibly: the point of the
 * feature is helping someone understand what a form is asking for, and "this
 * is asking for your national insurance number" is the part that matters most.
 *
 * Privacy: send field metadata only - labels, names, types, nearby text. Never
 * send the value a user has typed into a field.
 */

import type { BackgroundRoutes } from '../../shared/messages.js';
import { LucidError, MessageRouter } from '../../shared/messages.js';

export function register(router: MessageRouter<BackgroundRoutes>): void {
  router.on('ai.inferFieldPurpose', async () => {
    throw new LucidError(
      'Form field inference is not implemented yet (background/handlers/form.ts).',
      'not_implemented',
      false,
    );
  });
}

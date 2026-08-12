/**
 * STUB - owned by the Form worker. Fill this file in; touch nothing else.
 *
 * Goal: explain what a confusing form is actually asking for, field by field.
 *
 * Scan the form into FormFieldDescriptor[] (the shape is in shared/messages.ts)
 * and send it as `domContext`. Everything the model needs to infer a field's
 * purpose is in that descriptor - label text, name attribute, placeholder,
 * type, and the visible text near the control.
 *
 *   export function register(ctx: FeatureContext): void {
 *     async function explainForm(form: HTMLFormElement) {
 *       const fields = scanFields(form);            // yours -> FormFieldDescriptor[]
 *       ctx.panel.show({ title: 'What this form is asking for', busy: true });
 *       const { fields: purposes } = await ctx.send('ai.inferFieldPurpose', {
 *         domContext: { url: location.href, title: document.title, fields },
 *       });
 *       // correlate on id, never on array position
 *       const byId = new Map(purposes.map((p) => [p.id, p]));
 *       ...
 *     }
 *   }
 *
 * Assign each descriptor a stable `id` during the scan and keep your own map
 * from id back to the live element - the response echoes the id, and that is
 * how you find the control again to outline it with ctx.highlight.
 *
 * PRIVACY, and this one is not negotiable: send field metadata only. Never
 * read or transmit the value a user has typed. A form-explaining feature that
 * exfiltrates a half-typed credit card number is worse than no feature.
 *
 * Surface `sensitive: true` prominently. Telling someone "this is asking for
 * your national insurance number, and it is not marked required" is the most
 * valuable thing this feature does.
 */

import type { FeatureContext } from '../context.js';

export function register(ctx: FeatureContext): void {
  ctx.log.debug('form feature registered (stub)');
}

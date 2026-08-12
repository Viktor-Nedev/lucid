/**
 * Every prompt string Lucid sends to a model lives here and nowhere else.
 *
 * Both provider adapters (claude.ts, gemini.ts) read from this file, so tuning
 * a prompt changes both at once. If you find yourself writing prompt text
 * inside an adapter or a handler, move it here instead.
 *
 * The JSON schemas below are shared too: Claude takes them via structured
 * outputs, Gemini via responseSchema. Keep them in sync with the TypeScript
 * types in messages.ts by hand - they are the wire contract for model output.
 */

import type { DomContext, ReadingLevel } from './messages.js';

// ---------------------------------------------------------------------------
// Token budgets
// ---------------------------------------------------------------------------

/**
 * Output ceilings per task. Generous enough that answers are never cut
 * mid-sentence, tight enough that a runaway response cannot stall the panel.
 */
export const MAX_TOKENS = {
  // Headroom above what a description needs: on models with thinking on by
  // default this ceiling covers reasoning tokens too, and a description cut
  // off mid-sentence is worse than a few unused tokens.
  describeImage: 2048,
  simplifyText: 4096,
  extractChartData: 4096,
  inferFieldPurpose: 4096,
} as const;

/** Longest input we send for simplification; longer selections are chunked. */
export const MAX_SIMPLIFY_CHARS = 12_000;

// ---------------------------------------------------------------------------
// 1. Accessibility image description
// ---------------------------------------------------------------------------

export const IMAGE_DESCRIPTION_SYSTEM = `You write image descriptions for people using screen readers.

Describe what is actually visible, in the order a sighted reader would take it in: what kind of thing it is, then its content, then any detail that changes the meaning. Read out text that appears in the image verbatim - labels, captions, button text, error messages - because that text is often the whole point of the image.

Keep it to two or three sentences for a simple image. Go longer only when the image carries dense information a reader would otherwise lose, such as a diagram, a screenshot of an interface, or a table.

Write plain declarative sentences. Do not open with "an image of", "this picture shows", or similar - start with the content itself. Do not comment on visual style, colour palette, or composition unless it carries meaning. Do not guess at things you cannot see clearly; if part of the image is illegible or ambiguous, say so briefly rather than inventing a reading.`;

export function imageDescriptionUser(contextText: string): string {
  const context = contextText.trim();
  if (!context) return 'Describe this image for a screen reader user.';
  return `Describe this image for a screen reader user.

Surrounding page text, for context on what the image is doing here:
"""
${truncate(context, 2000)}
"""`;
}

// ---------------------------------------------------------------------------
// 2. Chart data extraction
// ---------------------------------------------------------------------------

export const CHART_EXTRACTION_SYSTEM = `You read charts and turn them back into the data behind them, so that someone who cannot see the chart can still work with the numbers.

Read values off the axes, gridlines, and any data labels. Where a value falls between gridlines, estimate it and keep the precision the chart itself supports - do not report more decimal places than you can actually read. If a series is unlabelled, name it by what it plainly represents rather than "Series 1".

The first column of the table is the category or x-axis value; one further column per data series. Every row must have exactly as many cells as there are columns.

In the notes, call out what a reader would notice at a glance: the overall direction, the largest and smallest points, any crossover between series, any break in the pattern. Skip anything the numbers already make obvious.

If the image is not a chart, or is too low-resolution to read values from, say so in the summary and return empty columns and rows rather than guessing.`;

export function chartExtractionUser(contextText: string): string {
  const context = contextText.trim();
  if (!context) return 'Extract the underlying data from this chart.';
  return `Extract the underlying data from this chart.

Surrounding page text, which may name the units or the time period:
"""
${truncate(context, 2000)}
"""`;
}

/** Shared JSON schema for chart extraction. Mirrors ChartData in messages.ts. */
export const CHART_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'The chart title as printed, or a short descriptive one if it has none.',
    },
    summary: {
      type: 'string',
      description: 'One paragraph, plain language, on what the chart shows.',
    },
    columns: {
      type: 'array',
      items: { type: 'string' },
      description: 'Column headers. First is the category/x axis, then one per series.',
    },
    rows: {
      type: 'array',
      items: { type: 'array', items: { type: 'string' } },
      description: 'Data rows. Each row has exactly as many cells as there are columns.',
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Trends or outliers worth calling out, one per entry.',
    },
  },
  required: ['title', 'summary', 'columns', 'rows', 'notes'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// 3. Plain-language simplification
// ---------------------------------------------------------------------------

const READING_LEVEL_GUIDANCE: Record<ReadingLevel, string> = {
  plain: `Aim at a general adult reader who is not a specialist in this subject. Keep precise terms that carry real meaning, but define each one the first time it appears.`,
  simple: `Aim at a reader who finds dense text hard going - because of a cognitive disability, because they are reading in a second language, or because they are tired. Short sentences, one idea each. Common words over technical ones wherever an ordinary word will do.`,
  child: `Aim at a reader around ten years old. Very short sentences. Everyday words only. Where a hard idea cannot be avoided, explain it with something familiar.`,
};

export function simplifySystem(level: ReadingLevel): string {
  return `You rewrite text so it is easier to read, without changing what it says.

${READING_LEVEL_GUIDANCE[level]}

Rules that hold at every level:
- Keep every fact, number, date, name, and condition from the original. Simplifying is not summarising - do not drop information to make it shorter.
- Never add facts, examples, or advice that were not in the original.
- Preserve the meaning of anything conditional or qualified. "May be eligible" must not become "is eligible"; "up to 30 days" must not become "30 days".
- Keep the original's structure: a list stays a list, steps stay in order, headings stay headings.
- Where the original is legal, medical, or financial text, keep any term with a specific legal or clinical meaning and explain it in the same sentence.

Return only the rewritten text. No preamble, no notes about what you changed.`;
}

export function simplifyUser(text: string): string {
  return `Rewrite this text:

"""
${truncate(text, MAX_SIMPLIFY_CHARS)}
"""`;
}

// ---------------------------------------------------------------------------
// 4. Form field purpose inference
// ---------------------------------------------------------------------------

export const FORM_FIELD_SYSTEM = `You explain what a web form is actually asking for.

Forms fail people when the label is a jargon term, an abbreviation, an internal code name, or missing entirely. For each field you are given, work out what a person is meant to type into it, using the label, placeholder, name attribute, type, and the visible text around it.

For each field return:
- label: a short plain-language name, in sentence case, no more than about four words.
- purpose: one sentence saying what to enter and, where it is not obvious, why it is being asked.
- autocomplete: the HTML autocomplete token that fits (for example "email", "tel", "cc-number", "postal-code", "given-name"), or null if none applies. Use only real tokens from the HTML spec.
- sensitive: true when the field collects personal data a user should think twice about - government identifiers, payment details, health information, passwords, exact date of birth.

Judge each field from the evidence in front of you. Where a field is genuinely ambiguous, say so in the purpose rather than picking a confident wrong answer. Return one entry per field you were given, keeping the id exactly as supplied, in the same order.`;

export function formFieldUser(domContext: DomContext): string {
  const fields = domContext.fields
    .map((f) => {
      const attrs = [
        `id: ${f.id}`,
        `tag: ${f.tag}`,
        f.type ? `type: ${f.type}` : null,
        f.name ? `name: ${f.name}` : null,
        f.labelText ? `label: ${f.labelText}` : null,
        f.ariaLabel ? `aria-label: ${f.ariaLabel}` : null,
        f.placeholder ? `placeholder: ${f.placeholder}` : null,
        f.autocomplete ? `autocomplete: ${f.autocomplete}` : null,
        f.required ? 'required' : null,
        f.nearbyText ? `nearby text: ${truncate(f.nearbyText, 200)}` : null,
      ].filter(Boolean);
      return `- ${attrs.join(' | ')}`;
    })
    .join('\n');

  return `Page: ${domContext.title}
URL: ${domContext.url}

Form fields:
${fields}`;
}

/** Shared JSON schema for form-field inference. Mirrors FormFieldPurpose[]. */
export const FORM_FIELD_SCHEMA = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Exactly the id supplied for this field.' },
          label: { type: 'string', description: 'Short plain-language name, sentence case.' },
          purpose: { type: 'string', description: 'One sentence on what to enter and why.' },
          // anyOf rather than `type: ['string','null']`: the array form is not
          // in the supported JSON Schema subset, and gemini.ts collapses anyOf
          // into its own `nullable` flag.
          autocomplete: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'HTML autocomplete token, or null if none applies.',
          },
          sensitive: { type: 'boolean', description: 'True for sensitive personal data.' },
        },
        required: ['id', 'label', 'purpose', 'autocomplete', 'sensitive'],
        additionalProperties: false,
      },
    },
  },
  required: ['fields'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------

/** Cut `text` to `limit` characters on a word boundary where possible. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > limit * 0.8 ? cut.slice(0, lastSpace) : cut) + '…';
}

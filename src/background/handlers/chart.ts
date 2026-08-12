/**
 * STUB - owned by the Chart worker. Fill this file in; touch nothing else.
 *
 * Route:    'ai.extractChartData'  (request/response, not streaming)
 * Request:  ExtractChartDataRequest { image, contextText, cacheKey? }
 * Response: ExtractChartDataResponse { chart, cached }
 * AI call:  client.extractChartData(base64, contextText, { signal })
 *
 * This one is not streamed: the result is a structured table, and half a table
 * is not useful. The adapters constrain the model to CHART_SCHEMA from
 * shared/prompts.ts, so `chart` arrives already shaped and numeric-looking
 * cells are already coerced to numbers.
 *
 *   export function register(router: MessageRouter<BackgroundRoutes>): void {
 *     router.on('ai.extractChartData', async (payload) => {
 *       if (payload.cacheKey) {
 *         const hit = await getCached<ChartData>(payload.cacheKey);
 *         if (hit) return { chart: hit, cached: true };
 *       }
 *       const client = await getAIClient();
 *       const chart = await client.extractChartData(payload.image.base64, payload.contextText);
 *       if (payload.cacheKey) await setCached(payload.cacheKey, chart);
 *       return { chart, cached: false };
 *     });
 *   }
 *
 * Rendering: hand `{ columns, rows }` straight to panel.update({ table }).
 * The panel renders a real <table> with row and column headers, which is what
 * makes it navigable cell-by-cell in a screen reader - do not reformat it into
 * text first.
 *
 * When the image is not actually a chart the model returns empty columns and
 * rows with an explanation in `summary`. Show the summary rather than an
 * empty table.
 */

import type { BackgroundRoutes } from '../../shared/messages.js';
import { LucidError, MessageRouter } from '../../shared/messages.js';

export function register(router: MessageRouter<BackgroundRoutes>): void {
  router.on('ai.extractChartData', async () => {
    throw new LucidError(
      'Chart extraction is not implemented yet (background/handlers/chart.ts).',
      'not_implemented',
      false,
    );
  });
}

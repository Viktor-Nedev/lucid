/**
 * Chart data extraction.
 *
 * Route:    'ai.extractChartData'  (request/response, not streaming)
 * Request:  ExtractChartDataRequest { image, contextText, cacheKey? }
 * Response: ExtractChartDataResponse { chart, cached }
 *
 * Not streamed on purpose: the result is a structured table, and half a table
 * is not useful. The adapters constrain the model to CHART_SCHEMA from
 * shared/prompts.ts, so `chart` arrives already shaped.
 *
 * When the image is not actually a chart the model returns empty columns and
 * rows with the reason in `summary`; that is a valid result, not an error, and
 * the content side renders the summary alone. It is still cached - re-reading
 * the same non-chart costs the same tokens as reading a real one.
 */

import type { BackgroundRoutes, ChartData } from '../../shared/messages.js';
import { MessageRouter } from '../../shared/messages.js';
import { getCached, setCached } from '../../shared/storage.js';
import { getAIClient } from '../ai/client.js';

export function register(router: MessageRouter<BackgroundRoutes>): void {
  router.on('ai.extractChartData', async (payload) => {
    if (payload.cacheKey) {
      const hit = await getCached<ChartData>(payload.cacheKey);
      if (hit) return { chart: hit, cached: true };
    }

    const client = await getAIClient();
    const chart = await client.extractChartData(payload.image.base64, payload.contextText);

    if (payload.cacheKey) await setCached(payload.cacheKey, chart);
    return { chart, cached: false };
  });
}

/**
 * STUB - owned by the Chart worker. Fill this file in; touch nothing else.
 *
 * Goal: turn a chart image into the numbers behind it, presented as a real
 * table a screen reader can navigate cell by cell.
 *
 * No keyboard command is bound to this one. Trigger it however suits the
 * demo - a panel action, detecting <canvas>/<svg>/chart-ish <img> on the page,
 * or reusing the explain shortcut when the target looks like a chart.
 *
 *   export function register(ctx: FeatureContext): void {
 *     // however you decide to trigger it:
 *     async function describeChart(element: Element) {
 *       ctx.panel.show({ title: 'Reading the chart', busy: true, status: 'Reading values...' });
 *       try {
 *         const image = await ctx.capture.captureElement(element);
 *         const contextText = ctx.capture.contextTextFor(element);
 *         const { chart } = await ctx.send('ai.extractChartData', { image, contextText });
 *         ctx.panel.update({
 *           title: chart.title || 'Chart data',
 *           body: chart.summary,
 *           table: { columns: chart.columns, rows: chart.rows, caption: chart.title },
 *           busy: false,
 *           status: undefined,
 *         });
 *       } catch (err) {
 *         ctx.panel.setError((err as Error).message);
 *       }
 *     }
 *   }
 *
 * Hand `columns` and `rows` to the panel unchanged. It renders a proper
 * <table> with a <th scope="col"> header row and <th scope="row"> first
 * column, which is exactly what makes the data navigable in a screen reader.
 * Flattening it to prose throws that away.
 *
 * Not every image is a chart: when the model cannot read one it returns empty
 * columns and rows with the reason in `summary`. Check `chart.rows.length`
 * and show the summary alone rather than an empty table.
 */

import type { FeatureContext } from '../context.js';

export function register(ctx: FeatureContext): void {
  ctx.log.debug('chart feature registered (stub)');
}

/**
 * Anthropic adapter.
 *
 * Uses the official SDK. It runs unmodified in an MV3 service worker as long
 * as `dangerouslyAllowBrowser` is set - the flag exists to stop people
 * shipping keys in web pages, which does not apply here: the key lives in
 * chrome.storage.local and every request originates from the extension's own
 * worker, never from a page.
 *
 * No prompt text lives in this file. See shared/prompts.ts.
 */

import Anthropic from '@anthropic-ai/sdk';

import type { ChartData, DomContext, FormFieldPurpose } from '../../shared/messages.js';
import { LucidError } from '../../shared/messages.js';
import {
  CHART_EXTRACTION_SYSTEM,
  CHART_SCHEMA,
  FORM_FIELD_SCHEMA,
  FORM_FIELD_SYSTEM,
  IMAGE_DESCRIPTION_SYSTEM,
  MAX_TOKENS,
  chartExtractionUser,
  formFieldUser,
  imageDescriptionUser,
  simplifySystem,
  simplifyUser,
} from '../../shared/prompts.js';
import type { AIClient, AdapterConfig, CallOptions } from './client.js';
import { normalizeChartData, parseJsonResponse } from './client.js';

/**
 * Models that take `output_config.effort` and adaptive thinking. Older tiers
 * (Haiku 4.5 and earlier) reject both, so we omit them there rather than
 * hard-coding one model and breaking anyone who picks another.
 */
function supportsEffort(model: string): boolean {
  return /^claude-(opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable-5|mythos-5)/.test(model);
}

/** Models where a safety classifier can decline, so server-side fallback is worth enabling. */
function supportsFallbacks(model: string): boolean {
  return /^claude-(opus-5|fable-5|mythos-5)/.test(model);
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Effort per task. The two interactive paths run low - a screen reader user
 * waiting on a description cares more about latency than about the last few
 * points of quality. The structured extractions run medium because reading
 * values off a chart is where accuracy actually matters.
 */
const EFFORT = {
  describeImage: 'low',
  simplifyText: 'low',
  extractChartData: 'medium',
  inferFieldPurpose: 'medium',
} as const;

type TaskName = keyof typeof EFFORT;

export function createClaudeClient(config: AdapterConfig): AIClient {
  const client = new Anthropic({
    apiKey: config.apiKey,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });

  const { model } = config;

  /** Shared request shape. `output_config` is omitted on models that reject it. */
  function baseParams(task: TaskName, system: string, maxTokens: number) {
    const params: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      system,
    };
    if (supportsEffort(model)) {
      params['output_config'] = { effort: EFFORT[task] };
    }
    return params;
  }

  /** Turn a finished message into plain text, surfacing refusals as errors. */
  function textFromMessage(message: {
    stop_reason?: string | null;
    content: Array<{ type: string; text?: string }>;
  }): string {
    if (message.stop_reason === 'refusal') {
      throw new LucidError(
        'The model declined to answer this one. Try a different region or page.',
        'refusal',
        false,
      );
    }
    return message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
  }

  /**
   * Streaming text call.
   *
   * On models that support it we ask for a server-side fallback so a safety
   * decline is re-served by another model inside the same request instead of
   * surfacing as a dead end mid-demo. If the beta is not available to this
   * key, we retry once without it - but only when nothing has streamed yet,
   * so the panel never shows duplicated text.
   */
  async function streamText(
    task: TaskName,
    system: string,
    content: unknown,
    maxTokens: number,
    opts?: CallOptions,
  ): Promise<string> {
    let emitted = false;

    const run = async (withFallbacks: boolean): Promise<string> => {
      const params = {
        ...baseParams(task, system, maxTokens),
        messages: [{ role: 'user', content }],
        ...(withFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
      };

      const requestOptions = opts?.signal ? { signal: opts.signal } : {};
      const stream = withFallbacks
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client.beta.messages.stream as any)(params, requestOptions)
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client.messages.stream as any)(params, requestOptions);

      stream.on('text', (delta: string) => {
        emitted = true;
        opts?.onDelta?.(delta);
      });

      return textFromMessage(await stream.finalMessage());
    };

    const wantFallbacks = supportsFallbacks(model);
    try {
      return await run(wantFallbacks);
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : '';
      const isFallbackParamProblem =
        status === 400 && /fallback|beta/i.test(message) && !emitted;
      if (wantFallbacks && isFallbackParamProblem) {
        return run(false);
      }
      throw err;
    }
  }

  /** Non-streaming call constrained to a JSON schema. */
  async function structured<T>(
    task: TaskName,
    system: string,
    content: unknown,
    maxTokens: number,
    schema: unknown,
    what: string,
    opts?: CallOptions,
  ): Promise<T> {
    const params = {
      ...baseParams(task, system, maxTokens),
      messages: [{ role: 'user', content }],
      output_config: {
        ...(supportsEffort(model) ? { effort: EFFORT[task] } : {}),
        format: { type: 'json_schema', schema },
      },
    };

    const requestOptions = opts?.signal ? { signal: opts.signal } : {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (client.messages.create as any)(params, requestOptions);
    return parseJsonResponse<T>(textFromMessage(message), what);
  }

  function imageBlock(base64: string) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
    };
  }

  return {
    async describeImage(base64, contextText, opts) {
      return streamText(
        'describeImage',
        IMAGE_DESCRIPTION_SYSTEM,
        [imageBlock(base64), { type: 'text', text: imageDescriptionUser(contextText) }],
        MAX_TOKENS.describeImage,
        opts,
      );
    },

    async simplifyText(text, opts) {
      const level = opts?.readingLevel ?? config.readingLevel;
      return streamText(
        'simplifyText',
        simplifySystem(level),
        [{ type: 'text', text: simplifyUser(text) }],
        MAX_TOKENS.simplifyText,
        opts,
      );
    },

    async extractChartData(base64, contextText, opts) {
      const chart = await structured<ChartData>(
        'extractChartData',
        CHART_EXTRACTION_SYSTEM,
        [imageBlock(base64), { type: 'text', text: chartExtractionUser(contextText) }],
        MAX_TOKENS.extractChartData,
        CHART_SCHEMA,
        'chart',
        opts,
      );
      return normalizeChartData(chart);
    },

    async inferFieldPurpose(domContext: DomContext, opts) {
      const result = await structured<{ fields: FormFieldPurpose[] }>(
        'inferFieldPurpose',
        FORM_FIELD_SYSTEM,
        [{ type: 'text', text: formFieldUser(domContext) }],
        MAX_TOKENS.inferFieldPurpose,
        FORM_FIELD_SCHEMA,
        'form field',
        opts,
      );
      return result.fields ?? [];
    },
  };
}

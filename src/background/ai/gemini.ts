/**
 * Google Gemini adapter, over the REST API.
 *
 * Deliberately no @google/genai dependency: the surface we need is two
 * endpoints and an SSE parse, and a second SDK would roughly double the
 * bundle for no gain. The tradeoff is that the request shapes below are
 * hand-written, so they are documented inline.
 *
 * No prompt text lives in this file. See shared/prompts.ts.
 */

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
import { httpError, normalizeChartData, parseJsonResponse } from './client.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

/**
 * Only the Flash tiers allow thinking to be switched off entirely; Pro
 * enforces a minimum budget. We disable it on the interactive paths where
 * latency matters more than depth.
 */
function canDisableThinking(model: string): boolean {
  return /^gemini-2\.5-flash/.test(model);
}

export function createGeminiClient(config: AdapterConfig): AIClient {
  const { apiKey, model } = config;

  function buildBody(
    system: string,
    parts: GeminiPart[],
    maxTokens: number,
    options: { schema?: unknown; lowLatency?: boolean } = {},
  ): Record<string, unknown> {
    const generationConfig: Record<string, unknown> = { maxOutputTokens: maxTokens };

    if (options.schema) {
      generationConfig['responseMimeType'] = 'application/json';
      generationConfig['responseSchema'] = toGeminiSchema(options.schema);
    }
    if (options.lowLatency && canDisableThinking(model)) {
      generationConfig['thinkingConfig'] = { thinkingBudget: 0 };
    }

    return {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts }],
      generationConfig,
    };
  }

  async function post(
    method: 'generateContent' | 'streamGenerateContent',
    body: unknown,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url =
      method === 'streamGenerateContent'
        ? `${API_ROOT}/${model}:streamGenerateContent?alt=sse`
        : `${API_ROOT}/${model}:generateContent`;

    const init: RequestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    };
    if (signal) init.signal = signal;

    const response = await fetch(url, init);

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      let message = `Gemini request failed (${response.status}).`;
      try {
        const parsed = JSON.parse(detail) as GeminiResponse;
        if (parsed.error?.message) message = parsed.error.message;
      } catch {
        if (detail) message = detail.slice(0, 300);
      }
      throw httpError(response.status, message);
    }
    return response;
  }

  /** Pull text out of one response object, turning safety blocks into errors. */
  function textFrom(payload: GeminiResponse): string {
    if (payload.promptFeedback?.blockReason) {
      throw new LucidError(
        'Gemini declined to answer this one. Try a different region or page.',
        'refusal',
        false,
      );
    }
    const candidate = payload.candidates?.[0];
    if (candidate?.finishReason === 'SAFETY') {
      throw new LucidError(
        'Gemini declined to answer this one. Try a different region or page.',
        'refusal',
        false,
      );
    }
    return (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('');
  }

  /**
   * Stream `:streamGenerateContent` as SSE.
   *
   * Chunk boundaries do not respect line boundaries, so we buffer and only
   * consume complete lines.
   */
  async function streamText(
    system: string,
    parts: GeminiPart[],
    maxTokens: number,
    opts?: CallOptions,
  ): Promise<string> {
    const response = await post(
      'streamGenerateContent',
      buildBody(system, parts, maxTokens, { lowLatency: true }),
      opts?.signal,
    );

    if (!response.body) {
      throw new LucidError('Gemini returned an empty response stream.', 'empty_response', true);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    const consumeLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const json = trimmed.slice(5).trim();
      if (!json || json === '[DONE]') return;

      let payload: GeminiResponse;
      try {
        payload = JSON.parse(json) as GeminiResponse;
      } catch {
        return; // keep-alive or partial frame; ignore
      }

      const text = textFrom(payload);
      if (text) {
        full += text;
        opts?.onDelta?.(text);
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          consumeLine(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
        }
      }
      if (buffer.trim()) consumeLine(buffer);
    } finally {
      reader.releaseLock();
    }

    return full;
  }

  async function structured<T>(
    system: string,
    parts: GeminiPart[],
    maxTokens: number,
    schema: unknown,
    what: string,
    opts?: CallOptions,
  ): Promise<T> {
    const response = await post(
      'generateContent',
      buildBody(system, parts, maxTokens, { schema }),
      opts?.signal,
    );
    const payload = (await response.json()) as GeminiResponse;
    return parseJsonResponse<T>(textFrom(payload), what);
  }

  const imagePart = (base64: string): GeminiPart => ({
    inlineData: { mimeType: 'image/jpeg', data: base64 },
  });

  return {
    async describeImage(base64, contextText, opts) {
      return streamText(
        IMAGE_DESCRIPTION_SYSTEM,
        [imagePart(base64), { text: imageDescriptionUser(contextText) }],
        MAX_TOKENS.describeImage,
        opts,
      );
    },

    async simplifyText(text, opts) {
      const level = opts?.readingLevel ?? config.readingLevel;
      return streamText(
        simplifySystem(level),
        [{ text: simplifyUser(text) }],
        MAX_TOKENS.simplifyText,
        opts,
      );
    },

    async extractChartData(base64, contextText, opts) {
      const chart = await structured<ChartData>(
        CHART_EXTRACTION_SYSTEM,
        [imagePart(base64), { text: chartExtractionUser(contextText) }],
        MAX_TOKENS.extractChartData,
        CHART_SCHEMA,
        'chart',
        opts,
      );
      return normalizeChartData(chart);
    },

    async inferFieldPurpose(domContext: DomContext, opts) {
      const result = await structured<{ fields: FormFieldPurpose[] }>(
        FORM_FIELD_SYSTEM,
        [{ text: formFieldUser(domContext) }],
        MAX_TOKENS.inferFieldPurpose,
        FORM_FIELD_SCHEMA,
        'form field',
        opts,
      );
      return result.fields ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// Schema translation
// ---------------------------------------------------------------------------

interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  required?: readonly string[];
  enum?: readonly unknown[];
  anyOf?: readonly JsonSchemaNode[];
  additionalProperties?: boolean;
}

/**
 * Translate the shared JSON Schema into Gemini's OpenAPI subset.
 *
 * Three differences that will bite you if you skip this: Gemini wants
 * uppercase type names, rejects `additionalProperties` outright, and expresses
 * nullability as a `nullable` flag rather than a union with "null".
 */
function toGeminiSchema(schema: unknown): Record<string, unknown> {
  const node = schema as JsonSchemaNode;
  const out: Record<string, unknown> = {};

  // Collapse `anyOf: [X, null]` into X + nullable.
  if (node.anyOf) {
    const nonNull = node.anyOf.filter((entry) => entry.type !== 'null');
    const nullable = nonNull.length !== node.anyOf.length;
    const first = nonNull[0];
    const inner = first ? toGeminiSchema(first) : { type: 'STRING' };
    if (nullable) inner['nullable'] = true;
    if (node.description) inner['description'] = node.description;
    return inner;
  }

  let type = node.type;
  let nullable = false;
  if (Array.isArray(type)) {
    nullable = type.includes('null');
    type = type.find((t) => t !== 'null') ?? 'string';
  }

  if (typeof type === 'string') out['type'] = type.toUpperCase();
  if (nullable) out['nullable'] = true;
  if (node.description) out['description'] = node.description;
  if (node.enum) out['enum'] = [...node.enum];

  if (node.properties) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node.properties)) {
      properties[key] = toGeminiSchema(value);
    }
    out['properties'] = properties;
  }
  if (node.required) out['required'] = [...node.required];
  if (node.items) out['items'] = toGeminiSchema(node.items);

  // `additionalProperties` is intentionally dropped - Gemini rejects it.
  return out;
}

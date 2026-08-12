/**
 * The AI seam.
 *
 * Everything above this file - handlers, content features, UI - talks to
 * `AIClient` and never to a provider. Adapters live in claude.ts and gemini.ts
 * and are selected from settings at call time, so switching provider in the
 * options page takes effect on the next request with no reload.
 *
 * Adding a provider means writing one adapter that satisfies AIClient and
 * adding a case to `createClient`. Nothing else changes.
 */

import type { ChartData, DomContext, FormFieldPurpose, ReadingLevel } from '../../shared/messages.js';
import { LucidError } from '../../shared/messages.js';
import type { ProviderId, Settings } from '../../shared/storage.js';
import { activeApiKey, activeModel, getSettings } from '../../shared/storage.js';
import { createClaudeClient } from './claude.js';
import { createGeminiClient } from './gemini.js';

/** Per-call knobs. Every field is optional so the four core signatures stay clean. */
export interface CallOptions {
  /** Abort the underlying HTTP request. Wired to the stream port's lifetime. */
  signal?: AbortSignal;
  /**
   * Called with each chunk of text as it generates. Only the two text-producing
   * methods emit deltas; the structured ones resolve once.
   */
  onDelta?: (text: string) => void;
  /** simplifyText only. Falls back to the configured default. */
  readingLevel?: ReadingLevel;
}

/**
 * The four capabilities Lucid needs from a model.
 *
 * `base64` arguments are bare base64 JPEG - no `data:` prefix - exactly as
 * `capture.ts` returns them.
 */
export interface AIClient {
  /** Accessibility description of an image region, for screen reader users. */
  describeImage(base64: string, contextText: string, opts?: CallOptions): Promise<string>;

  /** Plain-language rewrite that preserves every fact in the original. */
  simplifyText(text: string, opts?: CallOptions): Promise<string>;

  /** Read a chart image back into the table of numbers behind it. */
  extractChartData(base64: string, contextText: string, opts?: CallOptions): Promise<ChartData>;

  /** Work out what each field of a form is actually asking for. */
  inferFieldPurpose(domContext: DomContext, opts?: CallOptions): Promise<FormFieldPurpose[]>;
}

/** What an adapter needs to construct itself. */
export interface AdapterConfig {
  apiKey: string;
  model: string;
  readingLevel: ReadingLevel;
}

type AdapterFactory = (config: AdapterConfig) => AIClient;

/**
 * Both adapters are imported statically and always bundled.
 *
 * Do not make these dynamic imports to "load providers on demand": an MV3
 * service worker may not call import() after its initial evaluation, so a
 * lazy adapter throws the first time a user actually needs it - and only for
 * whichever provider they picked, which is the worst kind of bug to find.
 * The whole worker is one bundle loaded at startup regardless, so there is
 * nothing to defer anyway.
 */
const adapters: Record<ProviderId, AdapterFactory> = {
  claude: createClaudeClient,
  gemini: createGeminiClient,
};

/** Cache the constructed adapter so we are not rebuilding an HTTP client per call. */
let cached: { key: string; client: AIClient } | null = null;

/**
 * Resolve the AIClient for the currently selected provider.
 *
 * Throws LucidError('missing_api_key') when the active provider has no key -
 * handlers should surface that to the panel with a link to the options page
 * rather than treating it as an unexpected failure.
 */
export async function getAIClient(settings?: Settings): Promise<AIClient> {
  const resolved = settings ?? (await getSettings());
  const apiKey = activeApiKey(resolved);
  const model = activeModel(resolved);

  if (!apiKey) {
    throw new LucidError(
      `No ${resolved.provider === 'claude' ? 'Anthropic' : 'Google AI'} API key set. Open Lucid's options page to add one.`,
      'missing_api_key',
      false,
    );
  }

  const cacheKey = `${resolved.provider}:${model}:${apiKey}:${resolved.readingLevel}`;
  if (cached?.key === cacheKey) return cached.client;

  const factory = adapters[resolved.provider];
  const client = factory({ apiKey, model, readingLevel: resolved.readingLevel });
  cached = { key: cacheKey, client };
  return client;
}

/** Drop the cached adapter. Called when settings change. */
export function resetAIClient(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Shared adapter helpers
// ---------------------------------------------------------------------------

/**
 * Parse model output that is supposed to be JSON.
 *
 * Structured-output modes make this almost always a plain JSON.parse, but a
 * model occasionally wraps the object in a ```json fence, and one bad response
 * should not surface as a raw SyntaxError in the panel.
 */
export function parseJsonResponse<T>(raw: string, what: string): T {
  const text = raw.trim();
  const unfenced = text.startsWith('```')
    ? text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    : text;

  try {
    return JSON.parse(unfenced) as T;
  } catch {
    // Last resort: pull the outermost {...} out of a chatty response.
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1)) as T;
      } catch {
        /* fall through to the error below */
      }
    }
    throw new LucidError(
      `The model returned something that is not valid ${what} JSON.`,
      'bad_model_output',
      true,
    );
  }
}

/** Coerce numeric-looking cells to numbers so chart consumers can plot them. */
export function normalizeChartData(chart: ChartData): ChartData {
  return {
    ...chart,
    rows: (chart.rows ?? []).map((row) =>
      (row ?? []).map((cell) => {
        if (typeof cell === 'number') return cell;
        const trimmed = String(cell).trim();
        // Only convert clean numerics; "12%" and "1,200" keep their formatting.
        if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
        return cell;
      }),
    ),
  };
}

/** Attach an HTTP status so serializeError() can classify the failure. */
export function httpError(status: number, message: string): Error {
  const err = new Error(message);
  (err as Error & { status: number }).status = status;
  return err;
}

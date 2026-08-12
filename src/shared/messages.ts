/**
 * FROZEN CONTRACT - every message that crosses a runtime boundary.
 *
 * Two directions, two route tables:
 *   BackgroundRoutes  content script / options page  ->  service worker
 *   TabRoutes         service worker                 ->  content script
 *
 * Adding a route is additive: add an entry to the relevant table and the
 * generic helpers below type-check every call site for free. Changing or
 * removing an existing route's shape is a breaking change - don't.
 *
 * Long-running text generation uses the streaming helpers (a chrome.runtime
 * Port) rather than sendMessage, because MV3 tears down a sendMessage round
 * trip that outlives the service worker's idle timer.
 */

import type { Settings } from './storage.js';

export const PROTOCOL_VERSION = 1;

/** chrome.runtime.connect port name used for every streaming call. */
export const STREAM_PORT = 'lucid/stream';

/** Discriminator on sendMessage payloads so we ignore unrelated traffic. */
const RPC_CHANNEL = 'lucid/rpc';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Viewport-relative rectangle in CSS pixels, as getBoundingClientRect returns. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A cropped region screenshot.
 *
 * `base64` is bare base64 with no `data:` prefix - that is the form both the
 * Anthropic and Gemini image blocks want. Use `toDataUrl()` to render it.
 */
export interface CapturedImage {
  base64: string;
  mediaType: 'image/jpeg';
  /** Device pixels, i.e. CSS pixels multiplied by devicePixelRatio. */
  width: number;
  height: number;
}

export function toDataUrl(image: CapturedImage): string {
  return `data:${image.mediaType};base64,${image.base64}`;
}

export type ReadingLevel = 'plain' | 'simple' | 'child';

/** Structured result of reading a chart image. */
export interface ChartData {
  title: string;
  /** One-paragraph plain-language description of what the chart shows. */
  summary: string;
  /** Column headers for `rows`; the first column is the category / x axis. */
  columns: string[];
  rows: Array<Array<string | number>>;
  /** Trends or outliers worth calling out, in plain language. */
  notes: string[];
}

/** What the content script can observe about one form control. */
export interface FormFieldDescriptor {
  /** Stable within a single page scan; correlates the response back. */
  id: string;
  tag: string;
  type: string | null;
  name: string | null;
  placeholder: string | null;
  labelText: string | null;
  ariaLabel: string | null;
  autocomplete: string | null;
  required: boolean;
  /** Visible text immediately around the control, trimmed. */
  nearbyText: string | null;
}

/** What the model infers a field is actually for. */
export interface FormFieldPurpose {
  id: string;
  /** Short human label, e.g. "Billing postcode". */
  label: string;
  /** One sentence on what to enter and why it is being asked. */
  purpose: string;
  /** Suggested HTML autocomplete token, or null if none applies. */
  autocomplete: string | null;
  /** True when the field looks like it collects sensitive personal data. */
  sensitive: boolean;
}

export interface DomContext {
  url: string;
  title: string;
  fields: FormFieldDescriptor[];
}

export interface SerializedError {
  name: string;
  message: string;
  /** Machine-readable cause, e.g. 'missing_api_key' | 'rate_limited'. */
  code: string;
  /** True when retrying the same request could plausibly succeed. */
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Request / response payloads
// ---------------------------------------------------------------------------

export interface PingResponse {
  ok: true;
  protocol: number;
  version: string;
  /** Which provider is currently selected. */
  provider: string;
  /** False when no API key is configured yet - UI should prompt for setup. */
  configured: boolean;
}

export interface CaptureRegionRequest {
  /** Viewport-relative, CSS pixels. */
  rect: Rect;
  /** window.devicePixelRatio at the moment the rect was measured. */
  devicePixelRatio: number;
}

export interface ExplainRegionRequest {
  image: CapturedImage;
  /** Text near or inside the region; gives the model page context. */
  contextText: string;
  /** Opaque cache key from shared/storage.ts. Omit to bypass the cache. */
  cacheKey?: string;
}

export interface ExplainRegionResponse {
  text: string;
  /** True when the answer came from the local cache rather than the API. */
  cached: boolean;
}

export interface SimplifyTextRequest {
  text: string;
  readingLevel?: ReadingLevel;
  cacheKey?: string;
}

export interface SimplifyTextResponse {
  text: string;
  cached: boolean;
}

export interface ExtractChartDataRequest {
  image: CapturedImage;
  contextText: string;
  cacheKey?: string;
}

export interface ExtractChartDataResponse {
  chart: ChartData;
  cached: boolean;
}

export interface InferFieldPurposeRequest {
  domContext: DomContext;
  cacheKey?: string;
}

export interface InferFieldPurposeResponse {
  fields: FormFieldPurpose[];
  cached: boolean;
}

/** Payload of every streaming `delta` frame. */
export interface TextDelta {
  text: string;
}

// ---------------------------------------------------------------------------
// Route tables
// ---------------------------------------------------------------------------

/**
 * Routes handled BY the service worker. Callers: content script, options page.
 *
 * Declared as a type alias rather than an interface on purpose: only type
 * aliases get an implicit index signature, which is what lets MessageRouter
 * take the whole table as a generic parameter.
 */
export type BackgroundRoutes = {
  ping: { request: null; response: PingResponse };

  'settings.get': { request: null; response: Settings };
  'settings.patch': { request: Partial<Settings>; response: Settings };
  'cache.clear': { request: null; response: { cleared: number } };

  'capture.region': { request: CaptureRegionRequest; response: CapturedImage };

  'ai.explainRegion': {
    request: ExplainRegionRequest;
    response: ExplainRegionResponse;
    stream: TextDelta;
  };
  'ai.simplifyText': {
    request: SimplifyTextRequest;
    response: SimplifyTextResponse;
    stream: TextDelta;
  };
  'ai.extractChartData': { request: ExtractChartDataRequest; response: ExtractChartDataResponse };
  'ai.inferFieldPurpose': { request: InferFieldPurposeRequest; response: InferFieldPurposeResponse };
};

/**
 * Routes handled BY the content script. Caller: service worker.
 *
 * The `command.*` routes are the tab-side landing point for the keyboard
 * commands declared in manifest.json. The manifest command NAME strings are
 * stable and feature workers bind to them; the mapping from command name to
 * route lives in service-worker.ts.
 *
 * A type alias, not an interface - see the note on BackgroundRoutes.
 */
export type TabRoutes = {
  'panel.toggle': { request: null; response: { open: boolean } };
  'command.explainSelection': { request: null; response: null };
  'command.simplifySelection': { request: null; response: null };
  'command.readAloud': { request: null; response: null };
  /** Reading Mode: read the whole page with synced highlighting. */
  'command.readPage': { request: null; response: null };
  /** Start voice control. Needs the offscreen document for the mic grant. */
  'command.voiceWake': { request: null; response: null };
  'tts.stop': { request: null; response: null };
};

export type BackgroundRoute = keyof BackgroundRoutes;
export type TabRoute = keyof TabRoutes;

type Req<T> = T extends { request: infer R } ? R : never;
type Res<T> = T extends { response: infer R } ? R : never;

/** Routes that stream text deltas before resolving. */
export type StreamRoute = {
  [K in BackgroundRoute]: BackgroundRoutes[K] extends { stream: unknown } ? K : never;
}[BackgroundRoute];

// ---------------------------------------------------------------------------
// Wire envelopes
// ---------------------------------------------------------------------------

interface RpcEnvelope {
  channel: typeof RPC_CHANNEL;
  protocol: number;
  route: string;
  payload: unknown;
}

type RpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError };

/** Frames a stream port emits back to the caller. */
export type StreamFrame<T> =
  | { type: 'delta'; delta: TextDelta }
  | { type: 'done'; data: T }
  | { type: 'error'; error: SerializedError };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class LucidError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(message: string, code = 'unknown', retryable = false) {
    super(message);
    this.name = 'LucidError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof LucidError) {
    return { name: err.name, message: err.message, code: err.code, retryable: err.retryable };
  }
  if (err instanceof Error) {
    // Both provider adapters attach a numeric `status` to HTTP failures.
    const status = (err as { status?: number }).status;
    const retryable = status === 429 || (typeof status === 'number' && status >= 500);
    let code = 'unknown';
    if (status === 401 || status === 403) code = 'bad_api_key';
    else if (status === 429) code = 'rate_limited';
    else if (typeof status === 'number' && status >= 500) code = 'server_error';
    return { name: err.name, message: err.message, code, retryable };
  }
  return { name: 'Error', message: String(err), code: 'unknown', retryable: false };
}

export function deserializeError(e: SerializedError): LucidError {
  const err = new LucidError(e.message, e.code, e.retryable);
  err.name = e.name;
  return err;
}

// ---------------------------------------------------------------------------
// Caller side
// ---------------------------------------------------------------------------

/** Call a service-worker route. Rejects with a LucidError on failure. */
export async function sendToBackground<K extends BackgroundRoute>(
  route: K,
  payload: Req<BackgroundRoutes[K]>,
): Promise<Res<BackgroundRoutes[K]>> {
  const envelope: RpcEnvelope = {
    channel: RPC_CHANNEL,
    protocol: PROTOCOL_VERSION,
    route,
    payload,
  };
  const result = (await chrome.runtime.sendMessage(envelope)) as
    | RpcResult<Res<BackgroundRoutes[K]>>
    | undefined;
  if (!result) {
    throw new LucidError(`No response from Lucid for "${route}".`, 'no_receiver', true);
  }
  if (!result.ok) throw deserializeError(result.error);
  return result.data;
}

/** Call a content-script route in a specific tab. */
export async function sendToTab<K extends TabRoute>(
  tabId: number,
  route: K,
  payload: Req<TabRoutes[K]>,
): Promise<Res<TabRoutes[K]>> {
  const envelope: RpcEnvelope = {
    channel: RPC_CHANNEL,
    protocol: PROTOCOL_VERSION,
    route,
    payload,
  };
  const result = (await chrome.tabs.sendMessage(tabId, envelope)) as
    | RpcResult<Res<TabRoutes[K]>>
    | undefined;
  if (!result) {
    throw new LucidError(
      'Lucid is not running in that tab. Reload the page and try again.',
      'no_content_script',
      true,
    );
  }
  if (!result.ok) throw deserializeError(result.error);
  return result.data;
}

export interface StreamHandlers<T> {
  onDelta?: (delta: TextDelta) => void;
  onDone?: (data: T) => void;
  onError?: (error: LucidError) => void;
}

export interface StreamHandle {
  /** Abort the request. Safe to call more than once. */
  cancel(): void;
}

/**
 * Start a streaming call. Deltas arrive as they are generated; `onDone` fires
 * once with the assembled result. Cancelling disconnects the port, which the
 * service worker turns into an AbortSignal on the underlying API request.
 */
export function openStream<K extends StreamRoute>(
  route: K,
  payload: Req<BackgroundRoutes[K]>,
  handlers: StreamHandlers<Res<BackgroundRoutes[K]>> = {},
): StreamHandle {
  const port = chrome.runtime.connect({ name: STREAM_PORT });
  let settled = false;

  const finish = () => {
    if (settled) return;
    settled = true;
    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
  };

  port.onMessage.addListener((frame: StreamFrame<Res<BackgroundRoutes[K]>>) => {
    switch (frame.type) {
      case 'delta':
        handlers.onDelta?.(frame.delta);
        break;
      case 'done':
        handlers.onDone?.(frame.data);
        finish();
        break;
      case 'error':
        handlers.onError?.(deserializeError(frame.error));
        finish();
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    if (settled) return;
    settled = true;
    handlers.onError?.(
      new LucidError('Lucid disconnected before finishing.', 'disconnected', true),
    );
  });

  port.postMessage({ route, payload });
  return { cancel: finish };
}

// ---------------------------------------------------------------------------
// Handler side
// ---------------------------------------------------------------------------

export type RpcHandler<Q, S> = (payload: Q, sender: chrome.runtime.MessageSender) => S | Promise<S>;

export interface StreamContext {
  /** Push a text delta to the caller. */
  emit(text: string): void;
  /** Aborts when the caller cancels or their page goes away. */
  signal: AbortSignal;
}

export type StreamHandler<Q, S> = (payload: Q, ctx: StreamContext) => Promise<S>;

/**
 * Route handler registry. The service worker installs one over BackgroundRoutes;
 * the content script installs one over TabRoutes.
 */
export class MessageRouter<Table extends Record<string, { request: unknown; response: unknown }>> {
  private readonly handlers = new Map<string, RpcHandler<never, unknown>>();
  private readonly streams = new Map<string, StreamHandler<never, unknown>>();
  private installed = false;

  on<K extends keyof Table & string>(
    route: K,
    handler: RpcHandler<Req<Table[K]>, Res<Table[K]>>,
  ): this {
    this.handlers.set(route, handler as unknown as RpcHandler<never, unknown>);
    return this;
  }

  onStream<K extends keyof Table & string>(
    route: K,
    handler: StreamHandler<Req<Table[K]>, Res<Table[K]>>,
  ): this {
    this.streams.set(route, handler as unknown as StreamHandler<never, unknown>);
    return this;
  }

  /** Wire up chrome.runtime listeners. Call once, after registering handlers. */
  install(): void {
    if (this.installed) return;
    this.installed = true;

    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      const envelope = message as RpcEnvelope | undefined;
      if (!envelope || envelope.channel !== RPC_CHANNEL) return false;

      const handler = this.handlers.get(envelope.route);
      // Not ours - another context in this extension may own the route.
      if (!handler) return false;

      Promise.resolve()
        .then(() => (handler as RpcHandler<unknown, unknown>)(envelope.payload, sender))
        .then((data) => sendResponse({ ok: true, data } as RpcResult<unknown>))
        .catch((err) => sendResponse({ ok: false, error: serializeError(err) } as RpcResult<unknown>));

      return true; // keep the channel open for the async response
    });

    if (this.streams.size === 0) return;

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== STREAM_PORT) return;

      const controller = new AbortController();
      let closed = false;

      port.onDisconnect.addListener(() => {
        closed = true;
        controller.abort();
      });

      const post = (frame: StreamFrame<unknown>) => {
        if (closed) return;
        try {
          port.postMessage(frame);
        } catch {
          closed = true; // caller vanished mid-stream
        }
      };

      port.onMessage.addListener((raw: unknown) => {
        const { route, payload } = raw as { route: string; payload: unknown };
        const handler = this.streams.get(route);
        if (!handler) {
          post({
            type: 'error',
            error: serializeError(new LucidError(`Unknown streaming route "${route}".`, 'no_route')),
          });
          return;
        }

        const ctx: StreamContext = {
          emit: (text) => post({ type: 'delta', delta: { text } }),
          signal: controller.signal,
        };

        Promise.resolve()
          .then(() => (handler as StreamHandler<unknown, unknown>)(payload, ctx))
          .then((data) => {
            post({ type: 'done', data });
            if (!closed) port.disconnect();
          })
          .catch((err) => {
            if (controller.signal.aborted) return; // caller cancelled; nobody to tell
            post({ type: 'error', error: serializeError(err) });
          });
      });
    });
  }
}

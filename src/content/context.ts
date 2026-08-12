/**
 * What a content feature is handed at registration.
 *
 * A feature file imports TYPES from here and nothing else. Every capability it
 * needs already exists on the context object, constructed once by index.ts.
 * That is the whole point: six people can work in six files without anyone
 * touching the content entry point, and there is exactly one panel, one
 * overlay layer and one speech session on the page no matter how many
 * features are live.
 *
 * If you find yourself importing panel.js or tts.js directly in a feature,
 * stop - take it off the context instead.
 */

import type { Logger } from '../shared/logger.js';
import type {
  BackgroundRoute,
  BackgroundRoutes,
  StreamHandle,
  StreamHandlers,
  StreamRoute,
  TabRoute,
} from '../shared/messages.js';
import type { Settings } from '../shared/storage.js';
import type { CapturedImage, Rect } from '../shared/messages.js';
import type { HighlightHandle, HighlightOptions } from './highlight.js';
import type { Panel } from './panel.js';
import type { SpeakOptions, TtsController } from './tts.js';

type Req<T> = T extends { request: infer R } ? R : never;
type Res<T> = T extends { response: infer R } ? R : never;

export interface FeatureContext {
  /** The page's one shared panel. */
  panel: Panel;

  highlight: {
    outlineElement(element: Element, options?: HighlightOptions): HighlightHandle;
    highlightRange(range: Range, options?: HighlightOptions): HighlightHandle;
    highlightTextSlice(
      node: Text,
      start: number,
      end: number,
      options?: HighlightOptions,
    ): HighlightHandle | null;
    clearHighlights(): void;
  };

  tts: {
    speak(text: string, options?: SpeakOptions): TtsController;
    cancelAll(): void;
    listVoices(): Promise<SpeechSynthesisVoice[]>;
    isSpeaking(): boolean;
  };

  capture: {
    captureElement(element: Element): Promise<CapturedImage>;
    captureRect(rect: Rect): Promise<CapturedImage>;
    contextTextFor(element: Element, maxChars?: number): string;
  };

  /** Call a service-worker route and await the result. */
  send<K extends BackgroundRoute>(
    route: K,
    payload: Req<BackgroundRoutes[K]>,
  ): Promise<Res<BackgroundRoutes[K]>>;

  /** Start a streaming service-worker call. */
  stream<K extends StreamRoute>(
    route: K,
    payload: Req<BackgroundRoutes[K]>,
    handlers?: StreamHandlers<Res<BackgroundRoutes[K]>>,
  ): StreamHandle;

  /** Current settings. Reads storage; cheap but not free, so do not poll it. */
  settings(): Promise<Settings>;

  /**
   * Handle a keyboard command or other worker-initiated event.
   *
   * Route names map to the manifest commands:
   *   command.explainSelection   Alt+Shift+E
   *   command.simplifySelection  Alt+Shift+S
   *   command.readAloud          Alt+Shift+R
   *   command.readPage           Alt+Shift+L   (Reading Mode)
   *   command.voiceWake          no default key
   *   panel.toggle               toolbar button, no key
   *
   * More than one feature may listen to the same route; all handlers run.
   */
  onCommand(route: TabRoute, handler: () => void | Promise<void>): void;

  /**
   * Invoke a route - the counterpart to onCommand, for handing work to
   * whichever feature owns it.
   *
   * Voice control is the motivating case: it recognises "read this" and needs
   * to trigger Reading Mode without importing it or duplicating what it does.
   *
   *     ctx.dispatch('command.readAloud');
   *
   * Runs every handler registered for the route, exactly as a keyboard
   * shortcut would, and resolves when they have all settled. A handler that
   * throws is logged and surfaced in the panel without stopping the others.
   * If no feature handles the route, the panel says so.
   *
   * There is no cycle detection. If A dispatches B and B dispatches A, that
   * loops until the page gives up - so dispatch routes you do not own, and do
   * not dispatch a route from inside its own handler.
   */
  dispatch(route: TabRoute): Promise<void>;

  /** Namespaced logger, e.g. `[lucid:content:explain]`. */
  log: Logger;
}

/** Every feature module exports exactly this. */
export type FeatureRegistration = (ctx: FeatureContext) => void;

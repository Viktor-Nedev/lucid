/**
 * Namespaced logging, gated on the `debug` setting.
 *
 * Warnings and errors always print - a swallowed error during a live demo is
 * worse than a noisy console. Only debug/info are gated.
 */

import { getSettings, onSettingsChanged } from './storage.js';

let debugEnabled = false;

// Best-effort: the first few log lines in a fresh context may be dropped
// before this resolves. That is fine; nothing depends on log ordering.
void getSettings()
  .then((s) => {
    debugEnabled = s.debug;
  })
  .catch(() => {
    /* storage unavailable in this context; stay quiet */
  });

onSettingsChanged((s) => {
  debugEnabled = s.debug;
});

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /** Derive a sub-logger, e.g. `log.child('tts')` -> `[lucid:content:tts]`. */
  child(suffix: string): Logger;
}

export function createLogger(namespace: string): Logger {
  const tag = `[lucid:${namespace}]`;
  return {
    debug: (...args) => {
      if (debugEnabled) console.debug(tag, ...args);
    },
    info: (...args) => {
      if (debugEnabled) console.info(tag, ...args);
    },
    warn: (...args) => console.warn(tag, ...args),
    error: (...args) => console.error(tag, ...args),
    child: (suffix) => createLogger(`${namespace}:${suffix}`),
  };
}

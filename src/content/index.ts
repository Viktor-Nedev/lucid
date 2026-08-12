/**
 * Content entry point.
 *
 * Constructs the single shared context - one panel, one overlay layer, one
 * speech session - registers every feature against it, and routes commands
 * from the service worker to whichever features asked for them.
 *
 * FEATURE WORKERS: you should not need to edit this file. Your module is
 * already imported and registered below. If something you need is missing,
 * add it to FeatureContext in context.ts rather than importing modules
 * directly inside a feature.
 */

import { createLogger } from '../shared/logger.js';
import type { TabRoute, TabRoutes } from '../shared/messages.js';
import { MessageRouter, openStream, sendToBackground } from '../shared/messages.js';
import { getSettings } from '../shared/storage.js';

import { captureElement, captureRect, contextTextFor } from './capture.js';
import type { FeatureContext } from './context.js';
import {
  clearHighlights,
  highlightRange,
  highlightTextSlice,
  outlineElement,
} from './highlight.js';
import { getPanel } from './panel.js';
import { cancelAll, isSpeaking, listVoices, speak } from './tts.js';

import { register as registerChart } from './features/chart.js';
import { register as registerExplain } from './features/explain.js';
import { register as registerForm } from './features/form.js';
import { register as registerReading } from './features/reading.js';
import { register as registerSimplify } from './features/simplify.js';
import { register as registerVoice } from './features/voice.js';

const log = createLogger('content');

/**
 * A page can end up with two copies of the content script - reloading the
 * extension while a tab is open injects a second one. Without this guard that
 * means two panels, two overlay layers, and every command firing twice.
 */
declare global {
  interface Window {
    __lucidInjected?: boolean;
  }
}

if (window.__lucidInjected) {
  log.debug('already injected, skipping');
} else {
  window.__lucidInjected = true;
  boot();
}

function boot(): void {
  const panel = getPanel();

  /** route -> the features that asked to handle it */
  const commandHandlers = new Map<TabRoute, Array<() => void | Promise<void>>>();

  const ctx: FeatureContext = {
    panel,
    highlight: { outlineElement, highlightRange, highlightTextSlice, clearHighlights },
    tts: { speak, cancelAll, listVoices, isSpeaking },
    capture: { captureElement, captureRect, contextTextFor },
    send: sendToBackground,
    stream: openStream,
    settings: getSettings,
    onCommand(route, handler) {
      const existing = commandHandlers.get(route);
      if (existing) existing.push(handler);
      else commandHandlers.set(route, [handler]);
    },
    log: log.child('feature'),
  };

  // Registration order is display order for anything that competes for the
  // panel; it is otherwise not significant.
  registerExplain(ctx);
  registerSimplify(ctx);
  registerReading(ctx);
  registerChart(ctx);
  registerForm(ctx);
  registerVoice(ctx);

  /** Run every handler for a route; one failing must not block the others. */
  async function dispatch(route: TabRoute): Promise<void> {
    const handlers = commandHandlers.get(route) ?? [];
    if (handlers.length === 0) {
      log.debug('no feature is handling', route);
      panel.show({
        title: 'Not wired up yet',
        body: `Nothing is handling "${route}" in this build.`,
      });
      return;
    }
    await Promise.all(
      handlers.map(async (handler) => {
        try {
          await handler();
        } catch (err) {
          log.error(`handler for ${route} failed`, err);
          panel.setError(err instanceof Error ? err.message : String(err));
        }
      }),
    );
  }

  const router = new MessageRouter<TabRoutes>();

  router
    .on('panel.toggle', () => {
      if (panel.isOpen()) {
        panel.hide();
      } else {
        panel.show({
          title: 'Lucid',
          body: 'Select something on the page, then use a shortcut:',
          actions: [
            { id: 'explain', label: 'Explain', hint: 'Alt+Shift+E' },
            { id: 'simplify', label: 'Simplify', hint: 'Alt+Shift+S' },
            { id: 'read', label: 'Read aloud', hint: 'Alt+Shift+R' },
          ],
        });
      }
      return { open: panel.isOpen() };
    })
    .on('command.explainSelection', async () => {
      await dispatch('command.explainSelection');
      return null;
    })
    .on('command.simplifySelection', async () => {
      await dispatch('command.simplifySelection');
      return null;
    })
    .on('command.readAloud', async () => {
      await dispatch('command.readAloud');
      return null;
    })
    .on('command.readPage', async () => {
      await dispatch('command.readPage');
      return null;
    })
    .on('command.voiceWake', async () => {
      await dispatch('command.voiceWake');
      return null;
    })
    .on('tts.stop', () => {
      cancelAll();
      clearHighlights();
      return null;
    });

  router.install();

  // The panel's default action buttons map onto the same routes, so the
  // buttons and the keyboard shortcuts always do the same thing.
  panel.onAction((id) => {
    if (id === 'explain') void dispatch('command.explainSelection');
    else if (id === 'simplify') void dispatch('command.simplifySelection');
    else if (id === 'read') void dispatch('command.readAloud');
  });

  // Dismissing the panel stops anything it started.
  panel.onDismiss(() => {
    cancelAll();
    clearHighlights();
  });

  // Leaving or hiding the page should not leave a voice talking to an empty room.
  window.addEventListener('pagehide', () => cancelAll());

  log.info('content script ready');
}

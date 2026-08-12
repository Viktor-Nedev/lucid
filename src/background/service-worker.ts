/**
 * Service worker entry point.
 *
 * Owns everything a content script cannot do: talking to model providers,
 * capturing the tab, and holding the settings/cache of record. It is also the
 * only place that knows which keyboard command maps to which tab route.
 *
 * MV3 note: this worker is torn down when idle and restarted on the next
 * event, so there is no meaningful in-memory state here. Anything that must
 * survive lives in chrome.storage (see shared/storage.ts). That is also why
 * long generations run over a Port rather than a sendMessage round trip.
 *
 * HANDLER WORKERS: your file in background/handlers/ is already imported and
 * registered below. You should not need to edit this file.
 */

import { createLogger } from '../shared/logger.js';
import type { BackgroundRoutes, TabRoute } from '../shared/messages.js';
import { MessageRouter, sendToTab } from '../shared/messages.js';
import { activeApiKey, clearCache, getSettings, onSettingsChanged, patchSettings } from '../shared/storage.js';

import { resetAIClient } from './ai/client.js';
import { captureRegion } from './capture.js';

import { register as registerChart } from './handlers/chart.js';
import { register as registerExplain } from './handlers/explain.js';
import { register as registerForm } from './handlers/form.js';
import { register as registerSimplify } from './handlers/simplify.js';

const log = createLogger('background');

const VERSION = chrome.runtime.getManifest().version;

/**
 * Manifest command name -> content-script route.
 * The command names are a published contract; feature workers bind to them.
 */
const COMMAND_ROUTES: Record<string, TabRoute> = {
  'toggle-panel': 'panel.toggle',
  'explain-selection': 'command.explainSelection',
  'simplify-selection': 'command.simplifySelection',
  'read-aloud': 'command.readAloud',
  'read-page': 'command.readPage',
  'voice-wake': 'command.voiceWake',
};

const router = new MessageRouter<BackgroundRoutes>();

// --- core routes -----------------------------------------------------------

router
  .on('ping', async () => {
    const settings = await getSettings();
    return {
      ok: true as const,
      protocol: 1,
      version: VERSION,
      provider: settings.provider,
      configured: activeApiKey(settings).length > 0,
    };
  })
  .on('settings.get', () => getSettings())
  .on('settings.patch', (patch) => patchSettings(patch))
  .on('cache.clear', async () => ({ cleared: await clearCache() }))
  .on('capture.region', (request, sender) => captureRegion(request, sender.tab));

// --- feature handlers (stubs until their owners land) ----------------------

registerExplain(router);
registerSimplify(router);
registerChart(router);
registerForm(router);

router.install();

// --- provider cache invalidation -------------------------------------------

// Switching provider, key or model in the options page must take effect on the
// next request, not the next worker restart.
onSettingsChanged(() => resetAIClient());

// --- commands and toolbar --------------------------------------------------

/** Send a route to the active tab, explaining the failure rather than swallowing it. */
async function dispatchToActiveTab(route: TabRoute): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    log.warn('no active tab for', route);
    return;
  }
  try {
    await sendToTab(tab.id, route, null);
  } catch (err) {
    // Almost always: the page predates the extension, or it is a chrome:// URL
    // where content scripts are not allowed to run.
    log.warn(`could not deliver ${route} to tab ${tab.id}`, err);
  }
}

chrome.commands.onCommand.addListener((command) => {
  const route = COMMAND_ROUTES[command];
  if (!route) {
    log.warn('unmapped command', command);
    return;
  }
  void dispatchToActiveTab(route);
});

chrome.action.onClicked.addListener(() => {
  void dispatchToActiveTab('panel.toggle');
});

// --- context menu ----------------------------------------------------------

const MENU_ITEMS: Array<{ id: string; title: string; contexts: chrome.contextMenus.ContextType[] }> = [
  { id: 'explain-selection', title: 'Explain this with Lucid', contexts: ['selection', 'image'] },
  { id: 'simplify-selection', title: 'Simplify this with Lucid', contexts: ['selection'] },
  { id: 'read-aloud', title: 'Read this aloud', contexts: ['selection'] },
];

function installMenus(): void {
  // removeAll first: onInstalled and onStartup can both fire in one session
  // and duplicate ids throw.
  chrome.contextMenus.removeAll(() => {
    for (const item of MENU_ITEMS) {
      chrome.contextMenus.create({ id: item.id, title: item.title, contexts: item.contexts });
    }
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  installMenus();
  // First run: send people to the options page, because nothing works without
  // an API key and silently failing is a bad first impression.
  if (details.reason === 'install') {
    void chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(installMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const route = COMMAND_ROUTES[String(info.menuItemId)];
  if (!route || !tab?.id) return;
  void sendToTab(tab.id, route, null).catch((err) =>
    log.warn('context menu dispatch failed', err),
  );
});

log.info(`service worker ready (v${VERSION})`);

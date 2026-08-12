/**
 * Options page.
 *
 * Saves on change rather than behind a Save button - there is no partial state
 * worth protecting, and a button people forget to press is a support problem.
 * Every save announces itself through a role="status" region so the change is
 * perceivable without sight.
 */

import { sendToBackground } from '../shared/messages.js';
import type { ProviderId, Settings } from '../shared/storage.js';
import { DEFAULT_MODELS, getSettings, patchSettings } from '../shared/storage.js';
import { listVoices } from '../content/tts.js';

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`options.html is missing #${id}`);
  return found as T;
}

const providerSelect = el<HTMLSelectElement>('provider');
const claudeKey = el<HTMLInputElement>('claude-key');
const geminiKey = el<HTMLInputElement>('gemini-key');
const claudeFields = el<HTMLElement>('claude-fields');
const geminiFields = el<HTMLElement>('gemini-fields');
const modelInput = el<HTMLInputElement>('model');
const readingLevel = el<HTMLSelectElement>('reading-level');
const ttsRate = el<HTMLInputElement>('tts-rate');
const ttsRateValue = el<HTMLOutputElement>('tts-rate-value');
const ttsVoice = el<HTMLSelectElement>('tts-voice');
const fontScale = el<HTMLInputElement>('font-scale');
const fontScaleValue = el<HTMLOutputElement>('font-scale-value');
const highContrast = el<HTMLInputElement>('high-contrast');
const cacheEnabled = el<HTMLInputElement>('cache-enabled');
const debug = el<HTMLInputElement>('debug');
const testButton = el<HTMLButtonElement>('test');
const clearCacheButton = el<HTMLButtonElement>('clear-cache');
const status = el<HTMLElement>('status');

let settings: Settings;
let statusTimer = 0;

function announce(message: string): void {
  status.textContent = message;
  window.clearTimeout(statusTimer);
  // Clear after a while so a stale "Saved" is not read out on the next visit.
  statusTimer = window.setTimeout(() => {
    status.textContent = '';
  }, 6000);
}

/** Only the selected provider's key field is relevant; hide the other. */
function syncProviderVisibility(provider: ProviderId): void {
  claudeFields.hidden = provider !== 'claude';
  geminiFields.hidden = provider !== 'gemini';
  modelInput.placeholder = DEFAULT_MODELS[provider];
}

function render(): void {
  providerSelect.value = settings.provider;
  claudeKey.value = settings.apiKeys.claude;
  geminiKey.value = settings.apiKeys.gemini;
  modelInput.value = settings.models[settings.provider];
  readingLevel.value = settings.readingLevel;

  ttsRate.value = String(settings.tts.rate);
  ttsRateValue.textContent = settings.tts.rate.toFixed(1);
  ttsVoice.value = settings.tts.voiceURI ?? '';

  fontScale.value = String(settings.panel.fontScale);
  fontScaleValue.textContent = String(Math.round(settings.panel.fontScale * 100));
  highContrast.checked = settings.panel.highContrast;

  cacheEnabled.checked = settings.cacheEnabled;
  debug.checked = settings.debug;

  syncProviderVisibility(settings.provider);
}

async function save(patch: Partial<Settings>, message = 'Saved'): Promise<void> {
  settings = await patchSettings(patch);
  announce(message);
}

async function populateVoices(): Promise<void> {
  const voices = await listVoices();
  const current = settings.tts.voiceURI ?? '';

  for (const voice of voices) {
    const option = document.createElement('option');
    option.value = voice.voiceURI;
    option.textContent = voice.default
      ? `${voice.name} (${voice.lang}) - default`
      : `${voice.name} (${voice.lang})`;
    ttsVoice.appendChild(option);
  }
  ttsVoice.value = current;
}

async function init(): Promise<void> {
  settings = await getSettings();
  render();
  void populateVoices();

  providerSelect.addEventListener('change', () => {
    const provider = providerSelect.value as ProviderId;
    syncProviderVisibility(provider);
    modelInput.value = settings.models[provider];
    void save({ provider }, `Using ${provider === 'claude' ? 'Claude' : 'Gemini'}`);
  });

  claudeKey.addEventListener('change', () => {
    void save({ apiKeys: { ...settings.apiKeys, claude: claudeKey.value.trim() } }, 'Anthropic key saved');
  });

  geminiKey.addEventListener('change', () => {
    void save({ apiKeys: { ...settings.apiKeys, gemini: geminiKey.value.trim() } }, 'Google AI key saved');
  });

  modelInput.addEventListener('change', () => {
    const provider = providerSelect.value as ProviderId;
    const value = modelInput.value.trim() || DEFAULT_MODELS[provider];
    modelInput.value = value;
    void save({ models: { ...settings.models, [provider]: value } });
  });

  readingLevel.addEventListener('change', () => {
    void save({ readingLevel: readingLevel.value as Settings['readingLevel'] });
  });

  ttsRate.addEventListener('input', () => {
    ttsRateValue.textContent = Number(ttsRate.value).toFixed(1);
  });
  ttsRate.addEventListener('change', () => {
    void save({ tts: { ...settings.tts, rate: Number(ttsRate.value) } });
  });

  ttsVoice.addEventListener('change', () => {
    void save({ tts: { ...settings.tts, voiceURI: ttsVoice.value || null } });
  });

  fontScale.addEventListener('input', () => {
    fontScaleValue.textContent = String(Math.round(Number(fontScale.value) * 100));
  });
  fontScale.addEventListener('change', () => {
    void save({ panel: { ...settings.panel, fontScale: Number(fontScale.value) } });
  });

  highContrast.addEventListener('change', () => {
    void save({ panel: { ...settings.panel, highContrast: highContrast.checked } });
  });

  cacheEnabled.addEventListener('change', () => {
    void save({ cacheEnabled: cacheEnabled.checked });
  });

  debug.addEventListener('change', () => {
    void save({ debug: debug.checked });
  });

  testButton.addEventListener('click', async () => {
    testButton.disabled = true;
    announce('Checking...');
    try {
      const result = await sendToBackground('ping', null);
      announce(
        result.configured
          ? `Lucid ${result.version} is running, using ${result.provider}. An API key is set.`
          : `Lucid ${result.version} is running, but ${result.provider} has no API key yet.`,
      );
    } catch (err) {
      announce(`Could not reach the extension: ${(err as Error).message}`);
    } finally {
      testButton.disabled = false;
    }
  });

  clearCacheButton.addEventListener('click', async () => {
    clearCacheButton.disabled = true;
    try {
      const { cleared } = await sendToBackground('cache.clear', null);
      announce(cleared === 0 ? 'Nothing was cached.' : `Cleared ${cleared} cached responses.`);
    } catch (err) {
      announce(`Could not clear the cache: ${(err as Error).message}`);
    } finally {
      clearCacheButton.disabled = false;
    }
  });
}

void init();

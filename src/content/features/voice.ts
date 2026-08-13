/**
 * Voice control - say what you want instead of remembering four shortcuts.
 *
 * Bound to 'command.voiceWake' (declared in the manifest with no default key,
 * because Chrome allows four suggested shortcuts and all four were spent) and
 * additionally to an in-page Alt+Shift+V, so the feature is reachable without
 * first assigning a key at chrome://extensions/shortcuts.
 *
 * WHY RECOGNITION RUNS HERE AND NOT IN THE OFFSCREEN DOCUMENT. The offscreen
 * document exists to hold a durable microphone grant, and that is the right
 * design - but a grant has to be obtained before it can be held, and an
 * offscreen document is hidden, so Chrome has no surface on which to prompt
 * for one. getUserMedia there fails with NotAllowedError until the extension
 * origin has been granted the microphone by some other means. Recognition in
 * the content script prompts against the page's own origin, which is a prompt
 * the user recognises and can act on. src/offscreen/ is left in place for
 * whoever wires up an extension-origin grant.
 *
 * PRIVACY. The microphone is opened when the user presses the wake key and
 * closed the moment a command is recognised, the user cancels, or the panel is
 * dismissed. It is never opened on page load, and the panel says "Listening"
 * for exactly as long as that is true. Note that Chrome's SpeechRecognition is
 * a server-side service: audio leaves the machine while listening. That is the
 * platform's behaviour, not something this file can opt out of, and it is why
 * listening is a discrete, visible, user-initiated act rather than a mode.
 *
 * HANDOFF. Voice owns no reading or explaining logic of its own; it recognises
 * an intent and dispatches the route that owns it, so "read this" behaves
 * identically however it was triggered. ctx.dispatch has no cycle detection,
 * so this file dispatches only routes it does not own - and never
 * 'command.voiceWake', which would loop.
 */

import type { TabRoute } from '../../shared/messages.js';
import type { FeatureContext } from '../context.js';

/** Action ids are namespaced: every feature's handler sees every button press. */
const ACTION_LISTEN = 'voice:listen';
const ACTION_CANCEL = 'voice:cancel';

/** Give up if the user says nothing. Longer than this and it is just open. */
const SILENCE_TIMEOUT_MS = 9000;

// ---------------------------------------------------------------------------
// SpeechRecognition, typed by hand
// ---------------------------------------------------------------------------

// Chrome exposes this webkit-prefixed and lib.dom does not declare it, so the
// shape we rely on is spelled out rather than cast away with `any`.
interface RecognitionAlternative {
  transcript: string;
  confidence: number;
}
interface RecognitionResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: RecognitionAlternative;
}
interface RecognitionResultList {
  readonly length: number;
  [index: number]: RecognitionResult;
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: RecognitionResultList;
}
interface RecognitionErrorEvent {
  readonly error: string;
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type RecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): RecognitionConstructor | null {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

// ---------------------------------------------------------------------------
// Grammar
// ---------------------------------------------------------------------------

interface Intent {
  /** Shown to the user as the thing Lucid understood. */
  label: string;
  test: RegExp;
  /** A route this feature does not own, or null for locally-handled intents. */
  route: TabRoute | null;
  /** Runs instead of a dispatch when route is null. */
  local?: 'stop' | 'close' | 'help';
}

/**
 * Ordered, first match wins. Order is the whole design here: "stop reading"
 * has to stop rather than read, and "read the page" has to beat "read this".
 */
const INTENTS: Intent[] = [
  {
    label: 'Stop speaking',
    test: /\b(stop|quiet|silence|shut up|be quiet|enough|cancel)\b/,
    route: null,
    local: 'stop',
  },
  {
    label: 'Close the panel',
    test: /\b(close|hide|dismiss|go away)\b/,
    route: null,
    local: 'close',
  },
  {
    label: 'What can I say?',
    test: /\b(help|commands|what can (i|you) (say|do))\b/,
    route: null,
    local: 'help',
  },
  {
    label: 'Read the whole page',
    test: /\b(read|speak)\b.*\b(page|everything|whole thing|article|all of it)\b/,
    route: 'command.readPage',
  },
  {
    label: 'Simplify this',
    test: /\b(simplify|simpler|simplified|plain (english|language)|easier to read|dumb (it|this) down)\b/,
    route: 'command.simplifySelection',
  },
  {
    label: 'Explain this',
    test: /\b(explain|describe|what('s| is) (this|that)|what am i looking at)\b/,
    route: 'command.explainSelection',
  },
  {
    label: 'Read this aloud',
    test: /\b(read|speak|say)\b/,
    route: 'command.readAloud',
  },
];

/** Lower-case, strip punctuation, collapse spaces - recognisers vary on all three. */
function normalize(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function match(transcript: string): Intent | null {
  const text = normalize(transcript);
  if (!text) return null;
  return INTENTS.find((intent) => intent.test.test(text)) ?? null;
}

const HELP_BODY = [
  '"read this" - reads the selection aloud',
  '"read the page" - reads the whole page with the words highlighted',
  '"explain this" - describes the visual in view',
  '"simplify this" - rewrites the selection in plain language',
  '"stop" - stops speaking',
  '"close" - hides this panel',
].join('\n');

// ---------------------------------------------------------------------------
// Feature
// ---------------------------------------------------------------------------

export function register(ctx: FeatureContext): void {
  let recognition: SpeechRecognitionLike | null = null;
  let silenceTimer = 0;
  /** Set when we stop the recogniser ourselves, so onend stays quiet. */
  let settled = false;

  function stopListening(): void {
    window.clearTimeout(silenceTimer);
    const active = recognition;
    recognition = null;
    if (!active) return;
    try {
      active.abort();
    } catch {
      /* already gone */
    }
  }

  function showHelp(title: string, status?: string): void {
    ctx.panel.show({
      title,
      body: HELP_BODY,
      status,
      actions: [{ id: ACTION_LISTEN, label: 'Listen again', primary: true }],
    });
  }

  async function run(intent: Intent, heard: string): Promise<void> {
    if (intent.local === 'stop') {
      ctx.tts.cancelAll();
      if (ctx.panel.isOpen()) ctx.panel.update({ title: 'Stopped', status: undefined, busy: false });
      return;
    }
    if (intent.local === 'close') {
      ctx.panel.hide();
      return;
    }
    if (intent.local === 'help') {
      showHelp('What you can say');
      return;
    }
    if (!intent.route) return;

    // Tell the user what was understood, then hand over. The feature that owns
    // the route takes the panel from here, which is what keeps a spoken
    // "explain this" identical to Alt+Shift+E.
    ctx.panel.update({ title: intent.label, status: `Heard "${heard}"`, busy: true });
    await ctx.dispatch(intent.route);
  }

  function onTranscript(transcript: string): void {
    const heard = transcript.trim();
    const intent = match(heard);

    if (!intent) {
      ctx.panel.show({
        title: 'Not one of the commands',
        body: heard ? `Heard "${heard}".\n\n${HELP_BODY}` : HELP_BODY,
        actions: [{ id: ACTION_LISTEN, label: 'Listen again', primary: true }],
      });
      return;
    }
    void run(intent, heard);
  }

  function explainFailure(code: string): void {
    const messages: Record<string, string> = {
      'not-allowed':
        'Lucid could not use the microphone on this page. Allow microphone access for this site and press the voice key again.',
      'service-not-allowed':
        'Chrome blocked speech recognition on this page. Allow microphone access for this site and try again.',
      'audio-capture':
        'No microphone was found. Check that one is connected and selected in Chrome, then try again.',
      network:
        'Speech recognition needs a network connection and could not reach the service. Check your connection and try again.',
      'no-speech': 'Lucid did not hear anything. Press the voice key and speak straight away.',
    };
    // The reason goes in `error`, not `body`: the panel announces status and
    // error, and never the body. A microphone failure written into the body
    // would be visible and completely silent, which in an accessibility tool
    // is the same as not reporting it at all.
    ctx.panel.show({
      title: 'Voice control',
      error:
        messages[code] ??
        `Speech recognition stopped unexpectedly (${code}). Press the voice key to try again.`,
      body: HELP_BODY,
      actions: [{ id: ACTION_LISTEN, label: 'Try again', primary: true }],
    });
  }

  function startListening(): void {
    // A second press while listening means "never mind".
    if (recognition) {
      stopListening();
      if (ctx.panel.isOpen()) {
        ctx.panel.update({ title: 'Stopped listening', status: undefined, busy: false });
      }
      return;
    }

    const Recognition = recognitionConstructor();
    if (!Recognition) {
      ctx.panel.show({
        title: 'Voice control',
        error: 'This browser does not provide speech recognition, so voice control is unavailable here.',
      });
      return;
    }
    // Checked before isSecureContext, not after: Chrome counts file:// as a
    // secure context, so that flag alone would wave this through to a
    // getUserMedia that cannot work and a failure with no explanation.
    if (location.protocol === 'file:') {
      ctx.panel.show({
        title: 'Voice control',
        error: 'The microphone is not available on file:// pages. Serve this page over http://localhost and try again.',
      });
      return;
    }
    if (!window.isSecureContext) {
      ctx.panel.show({
        title: 'Voice control',
        error: 'The microphone is only available on secure pages. Open this page over https (or localhost) and try again.',
      });
      return;
    }

    // Anything already being spoken would be fed straight back into the mic.
    ctx.tts.cancelAll();

    const active = new Recognition();
    active.lang = document.documentElement.lang || navigator.language || 'en-US';
    active.continuous = false;
    active.interimResults = true;
    active.maxAlternatives = 1;
    settled = false;

    let finalText = '';

    active.onstart = () => {
      ctx.panel.show({
        title: 'Listening',
        status: 'Say a command, for example "read this".',
        body: HELP_BODY,
        busy: true,
        actions: [{ id: ACTION_CANCEL, label: 'Stop listening', primary: true }],
      });
    };

    active.onresult = (event) => {
      let interim = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (!result) continue;
        const alternative = result[0];
        if (!alternative) continue;
        if (result.isFinal) finalText += alternative.transcript;
        else interim += alternative.transcript;
      }

      // Live feedback without announcing every fragment: the body is not a
      // live region, so a screen reader is not told about each syllable.
      const showing = (finalText + interim).trim();
      if (showing && ctx.panel.isOpen()) ctx.panel.update({ body: `"${showing}"` });

      if (finalText.trim()) {
        settled = true;
        window.clearTimeout(silenceTimer);
        stopListening();
        onTranscript(finalText);
      }
    };

    active.onerror = (event) => {
      if (event.error === 'aborted') return; // we cancelled; nothing to report
      settled = true;
      window.clearTimeout(silenceTimer);
      recognition = null;
      explainFailure(event.error);
    };

    active.onend = () => {
      recognition = null;
      window.clearTimeout(silenceTimer);
      if (settled) return;
      // Ended on its own with nothing final: usually a pause it read as the end.
      if (finalText.trim()) {
        onTranscript(finalText);
        return;
      }
      if (ctx.panel.isOpen()) {
        ctx.panel.update({
          title: 'Did not catch that',
          status: 'Lucid did not catch that. Press the voice key and speak straight away.',
          busy: false,
          actions: [{ id: ACTION_LISTEN, label: 'Listen again', primary: true }],
        });
      }
    };

    recognition = active;
    silenceTimer = window.setTimeout(() => {
      settled = true;
      stopListening();
      if (ctx.panel.isOpen()) {
        ctx.panel.update({
          title: 'Stopped listening',
          status: undefined,
          busy: false,
          actions: [{ id: ACTION_LISTEN, label: 'Listen again', primary: true }],
        });
      }
    }, SILENCE_TIMEOUT_MS);

    try {
      active.start();
    } catch (error) {
      recognition = null;
      ctx.log.warn('could not start recognition', error);
      explainFailure('start-failed');
    }
  }

  ctx.onCommand('command.voiceWake', () => startListening());

  // The manifest command has no default key, so give the demo a way in that
  // does not require a trip to chrome://extensions/shortcuts first.
  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
      if (event.code !== 'KeyV' && event.key.toLowerCase() !== 'v') return;
      event.preventDefault();
      event.stopPropagation();
      startListening();
    },
    true,
  );

  ctx.panel.onAction((id) => {
    if (id === ACTION_LISTEN) startListening();
    else if (id === ACTION_CANCEL) {
      stopListening();
      if (ctx.panel.isOpen()) {
        ctx.panel.update({ title: 'Stopped listening', status: undefined, busy: false });
      }
    }
    // Any other id belongs to another feature.
  });

  // Dismissing the panel closes the microphone: the panel saying "Listening"
  // is the only indication it is open, so the two must not outlive each other.
  ctx.panel.onDismiss(() => stopListening());
  window.addEventListener('pagehide', () => stopListening());

  ctx.log.debug('voice feature registered');
}

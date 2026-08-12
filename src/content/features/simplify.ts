/**
 * Simplify - Alt+Shift+S rewrites the selected text in plain language.
 *
 * THE INVARIANT THIS FEATURE IS BUILT AROUND: the page is never modified.
 * The rewrite goes into the shared panel and nowhere else, and the original
 * stays on screen exactly as the author wrote it. Silently swapping a page's
 * own words for a model's paraphrase could misstate a medical dosage, a legal
 * condition or a price, and the reader would have no way to tell. Everything
 * here is read-only with respect to the document: we read the selection, and
 * we draw in the panel's shadow root.
 *
 * Output surface is ctx.panel - the shared in-page panel, not the Chrome side
 * panel API. Explain renders into the same panel with the same
 * beginStream / appendBody / endStream shape, so the two features read as one
 * product.
 */

import type { ReadingLevel, StreamHandle } from '../../shared/messages.js';
import { MAX_SIMPLIFY_CHARS } from '../../shared/prompts.js';
import { cacheKeyFor } from '../../shared/storage.js';
import type { FeatureContext } from '../context.js';

/** Speech handle type, taken off ctx so this file never imports tts.js. */
type Speech = ReturnType<FeatureContext['tts']['speak']>;

/**
 * Below this there is nothing to simplify - a few words are already as plain
 * as they are going to get, and a round trip would only cost the user time.
 */
const MIN_CHARS = 25;

const LEVELS = ['plain', 'simple', 'child'] as const;

/**
 * These are three different audiences, not three notches on a difficulty
 * slider, so the labels name the reader rather than a degree of simplicity.
 */
const LEVEL_LABELS: Record<ReadingLevel, string> = {
  plain: 'General reader',
  simple: 'Easy read',
  child: 'Age 10',
};

/** Action ids are namespaced: every feature's handler sees every button press. */
const ACTION_SPEAK = 'simplify:speak';
const ACTION_LEVEL = 'simplify:level:';

function isLevel(value: string): value is ReadingLevel {
  return (LEVELS as readonly string[]).includes(value);
}

/**
 * Collapse whitespace so two slightly different selections of one paragraph
 * produce one cache key rather than two.
 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Trim to the cap on a word boundary, so the model is not handed half a word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastBreak = cut.lastIndexOf(' ');
  return (lastBreak > max * 0.8 ? cut.slice(0, lastBreak) : cut).trimEnd();
}

function selectionText(): string {
  return String(window.getSelection() ?? '');
}

export function register(ctx: FeatureContext): void {
  let inFlight: StreamHandle | null = null;
  let speech: Speech | null = null;

  /** The original selection, kept so a reading-level switch can re-run it. */
  let source = '';
  /** The finished rewrite, for read-aloud. */
  let result = '';
  /** Level used for the current result. */
  let level: ReadingLevel = 'plain';
  /** Set once the user picks a level in the panel; overrides the setting. */
  let override: ReadingLevel | null = null;
  /** Anything worth saying after the text lands (truncation, cache hit). */
  let notice = '';

  function stopSpeech(): void {
    speech?.cancel();
    speech = null;
  }

  function cancelInFlight(): void {
    inFlight?.cancel();
    inFlight = null;
  }

  /** Read-aloud, plus the two reading levels we are not currently showing. */
  function renderActions(): void {
    // update() un-hides the panel, so a late callback (speech finishing after
    // the user dismissed it) must not drag it back on screen.
    if (!ctx.panel.isOpen()) return;
    ctx.panel.update({
      actions: [
        {
          id: ACTION_SPEAK,
          label: speech ? 'Stop reading' : 'Read aloud',
          primary: true,
        },
        ...LEVELS.filter((candidate) => candidate !== level).map((candidate) => ({
          id: ACTION_LEVEL + candidate,
          label: LEVEL_LABELS[candidate],
        })),
      ],
    });
  }

  function speakResult(): void {
    if (speech) {
      stopSpeech();
      renderActions();
      return;
    }
    if (!result.trim()) return;

    void ctx.settings().then((settings) => {
      speech = ctx.tts.speak(result, {
        rate: settings.tts.rate,
        voiceURI: settings.tts.voiceURI,
        onEnd: () => {
          speech = null;
          renderActions();
        },
        onError: () => {
          speech = null;
          renderActions();
        },
      });
      renderActions();
    });
  }

  async function run(text: string, requested?: ReadingLevel): Promise<void> {
    // One request and one voice at a time; a second press replaces the first.
    cancelInFlight();
    stopSpeech();

    const trimmed = text.trim();
    if (!trimmed) {
      ctx.panel.show({
        title: 'Simplify',
        body: 'Select some text on the page first, then press Alt+Shift+S. The page itself is never changed - the plain-language version appears here.',
      });
      return;
    }
    if (trimmed.length < MIN_CHARS) {
      ctx.panel.show({
        title: 'Simplify',
        body: 'That selection is too short to be worth rewriting. Select a full sentence or more and try again.',
      });
      return;
    }

    const settings = await ctx.settings();
    const target = requested ?? override ?? settings.readingLevel;

    let payloadText = trimmed;
    notice = '';
    if (payloadText.length > MAX_SIMPLIFY_CHARS) {
      payloadText = clip(payloadText, MAX_SIMPLIFY_CHARS);
      notice = `That selection was too long to send at once, so this covers the first ${payloadText.length.toLocaleString()} characters of it.`;
    }

    source = trimmed;
    level = target;
    result = '';

    ctx.panel.beginStream('In plain language', `Rewriting for "${LEVEL_LABELS[target]}"...`);

    // Keyed on the TEXT, not on where it came from: the same paragraph selected
    // slightly differently must hit the same entry. The level is part of the
    // key because the same text at a different level is a different answer -
    // leave it out and switching level silently replays the old rewrite.
    const cacheKey = await cacheKeyFor(location.href, 'simplify', target, normalize(payloadText));

    inFlight = ctx.stream(
      'ai.simplifyText',
      { text: payloadText, readingLevel: target, cacheKey },
      {
        onDelta: (delta) => {
          result += delta.text;
          ctx.panel.appendBody(delta.text);
        },
        onDone: (data) => {
          inFlight = null;
          if (data.text) result = data.text;
          // Not optional: this is what announces the finished text to a screen
          // reader exactly once.
          ctx.panel.endStream();
          renderActions();
          if (data.cached && !notice) notice = 'Reused an earlier rewrite of this text.';
          if (notice) ctx.panel.update({ status: notice });
        },
        onError: (error) => {
          inFlight = null;
          // Covers missing_api_key too - the message is already written for a
          // human, so it goes straight in rather than being swallowed.
          ctx.panel.setError(error.message);
        },
      },
    );
  }

  ctx.onCommand('command.simplifySelection', () => run(selectionText()));

  ctx.panel.onAction((id) => {
    if (id === ACTION_SPEAK) {
      speakResult();
      return;
    }
    if (id.startsWith(ACTION_LEVEL)) {
      const next = id.slice(ACTION_LEVEL.length);
      // Re-run the ORIGINAL text, not the rewrite, so levels never compound.
      if (isLevel(next) && source) {
        override = next;
        void run(source, next);
      }
    }
    // Any other id belongs to another feature.
  });

  ctx.panel.onDismiss(() => {
    // Stop paying for a generation nobody is going to read. The shared teardown
    // in index.ts already cancels the voice; just drop our handle on it.
    cancelInFlight();
    speech = null;
  });

  ctx.log.debug('simplify feature registered');
}

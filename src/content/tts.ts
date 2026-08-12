/**
 * speechSynthesis wrapper.
 *
 * Reading Mode syncs a word highlight to the spoken word, so `onBoundary` and
 * its `charIndex` are the load-bearing part of this module - everything else
 * exists to keep that index correct and continuous.
 *
 * WHY THIS CHUNKS TEXT, which is the one thing to understand before editing:
 *
 * Chrome silently stops speaking after roughly fifteen seconds of a single
 * utterance. The fix is to split long text into short utterances and play
 * them back to back. That would normally wreck word sync, because each
 * utterance reports `charIndex` relative to its own text - the second chunk
 * would start counting from zero again. So every chunk records its offset in
 * the original string, and boundary events are rewritten back into
 * document coordinates before they reach the caller.
 *
 * A caller therefore sees one continuous stream of charIndex values over the
 * full text and never has to know chunking happened.
 *
 *     const handle = speak(article, {
 *       onBoundary: ({ charIndex, charLength }) => moveHighlight(charIndex, charLength),
 *       onEnd: () => clearHighlight(),
 *     });
 *     handle.pause(); handle.resume(); handle.cancel();
 */

import { createLogger } from '../shared/logger.js';

const log = createLogger('content:tts');

/** Utterances longer than this risk Chrome's silent cutoff. */
const MAX_CHUNK_CHARS = 180;

export interface TtsBoundary {
  /** Index into the ORIGINAL text passed to speak(), not into a chunk. */
  charIndex: number;
  /** Length of the word being spoken. Derived when the browser omits it. */
  charLength: number;
  /** Milliseconds since this utterance started. Resets per chunk. */
  elapsedTime: number;
  /** 'word' or 'sentence', as reported by the browser. */
  name: string;
}

export interface SpeakOptions {
  /** 0.1 - 10, though anything outside 0.5 - 2 is hard to follow. Default 1. */
  rate?: number;
  /** 0 - 2. Default 1. */
  pitch?: number;
  /** 0 - 1. Default 1. */
  volume?: number;
  /** voiceURI of a voice from listVoices(). Falls back to the browser default. */
  voiceURI?: string | null;
  /** BCP-47 tag. Defaults to the document language, then the browser's. */
  lang?: string;

  onStart?: () => void;
  onBoundary?: (boundary: TtsBoundary) => void;
  onPause?: () => void;
  onResume?: () => void;
  /** Fires once, after the final chunk. Not called when cancelled. */
  onEnd?: () => void;
  onError?: (error: Error) => void;
}

export interface TtsController {
  pause(): void;
  resume(): void;
  /** Stop immediately. onEnd does not fire. Safe to call repeatedly. */
  cancel(): void;
  readonly speaking: boolean;
  readonly paused: boolean;
}

interface Chunk {
  text: string;
  /** Start index of this chunk within the original text. */
  offset: number;
}

/**
 * Split text into utterance-sized chunks, preserving exact offsets.
 *
 * Offsets must index into the original string, so this never trims or
 * normalises - it only slices.
 */
export function chunkText(text: string, maxChars = MAX_CHUNK_CHARS): Chunk[] {
  const chunks: Chunk[] = [];
  if (!text) return chunks;

  // Sentence ends: terminal punctuation with optional closing quotes/brackets,
  // followed by whitespace. Plus blank lines, which are paragraph breaks.
  const sentenceEnd = /([.!?…]["'”’)\]]*\s+|\n{2,})/g;

  const sentences: Chunk[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = sentenceEnd.exec(text)) !== null) {
    const end = match.index + match[0].length;
    sentences.push({ text: text.slice(cursor, end), offset: cursor });
    cursor = end;
  }
  if (cursor < text.length) {
    sentences.push({ text: text.slice(cursor), offset: cursor });
  }

  /** Break a too-long sentence at the last space before the limit. */
  const split = (chunk: Chunk): Chunk[] => {
    if (chunk.text.length <= maxChars) return [chunk];
    const out: Chunk[] = [];
    let local = 0;
    while (local < chunk.text.length) {
      let end = Math.min(local + maxChars, chunk.text.length);
      if (end < chunk.text.length) {
        const lastSpace = chunk.text.lastIndexOf(' ', end);
        if (lastSpace > local) end = lastSpace + 1;
      }
      out.push({ text: chunk.text.slice(local, end), offset: chunk.offset + local });
      local = end;
    }
    return out;
  };

  // Merge consecutive sentences while they fit, so short sentences do not each
  // become their own utterance (which adds an audible gap between them).
  let pending: Chunk | null = null;
  for (const sentence of sentences) {
    for (const piece of split(sentence)) {
      if (!pending) {
        pending = { ...piece };
      } else if (pending.text.length + piece.text.length <= maxChars) {
        pending.text += piece.text;
      } else {
        chunks.push(pending);
        pending = { ...piece };
      }
    }
  }
  if (pending) chunks.push(pending);

  return chunks;
}

/** Length of the word starting at `index`, for browsers that omit charLength. */
function wordLengthAt(text: string, index: number): number {
  if (index >= text.length) return 0;
  const match = /^\S+/.exec(text.slice(index));
  return match ? match[0].length : 1;
}

let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;

/**
 * Voices load asynchronously - getVoices() returns [] on first call in a fresh
 * page. This resolves once they are actually available.
 */
export function listVoices(): Promise<SpeechSynthesisVoice[]> {
  if (voicesPromise) return voicesPromise;

  voicesPromise = new Promise((resolve) => {
    const immediate = speechSynthesis.getVoices();
    if (immediate.length > 0) {
      resolve(immediate);
      return;
    }
    const done = () => {
      speechSynthesis.removeEventListener('voiceschanged', done);
      window.clearTimeout(timer);
      resolve(speechSynthesis.getVoices());
    };
    // Some builds never fire voiceschanged; do not hang the caller forever.
    const timer = window.setTimeout(done, 2000);
    speechSynthesis.addEventListener('voiceschanged', done);
  });

  return voicesPromise;
}

/** True when anything is currently being spoken by this page. */
export function isSpeaking(): boolean {
  return speechSynthesis.speaking;
}

/** Stop whatever is speaking, including utterances queued outside this module. */
export function cancelAll(): void {
  active?.cancel();
  speechSynthesis.cancel();
}

let active: TtsController | null = null;

class Session implements TtsController {
  private readonly chunks: Chunk[];
  private index = 0;
  private cancelled = false;
  private userPaused = false;
  private started = false;
  private watchdog = 0;
  private voice: SpeechSynthesisVoice | null = null;

  constructor(
    private readonly text: string,
    private readonly options: SpeakOptions,
  ) {
    this.chunks = chunkText(text);
    void this.begin();
  }

  private async begin(): Promise<void> {
    if (this.options.voiceURI) {
      const voices = await listVoices();
      this.voice = voices.find((v) => v.voiceURI === this.options.voiceURI) ?? null;
      if (!this.voice) log.warn('voice not found, using default', this.options.voiceURI);
    }
    if (this.cancelled) return;

    if (this.chunks.length === 0) {
      this.options.onEnd?.();
      return;
    }

    // Chrome queues rather than replaces, so clear anything already speaking.
    speechSynthesis.cancel();
    this.startWatchdog();
    this.speakNext();
  }

  /**
   * Chrome occasionally leaves synthesis in a paused state that the user never
   * asked for, which reads to them as "it just stopped". If we did not pause
   * it, un-pause it.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdog = window.setInterval(() => {
      if (this.cancelled || this.userPaused) return;
      if (speechSynthesis.paused) {
        log.debug('watchdog: resuming unexpectedly paused synthesis');
        speechSynthesis.resume();
      }
    }, 4000);
  }

  private stopWatchdog(): void {
    if (this.watchdog) {
      window.clearInterval(this.watchdog);
      this.watchdog = 0;
    }
  }

  private speakNext(): void {
    if (this.cancelled) return;

    const chunk = this.chunks[this.index];
    if (!chunk) {
      this.finish();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(chunk.text);
    utterance.rate = this.options.rate ?? 1;
    utterance.pitch = this.options.pitch ?? 1;
    utterance.volume = this.options.volume ?? 1;
    utterance.lang = this.options.lang ?? document.documentElement.lang ?? navigator.language;
    if (this.voice) utterance.voice = this.voice;

    utterance.onstart = () => {
      if (this.cancelled || this.started) return;
      this.started = true;
      this.options.onStart?.();
    };

    // The whole point of this module: rewrite chunk-local indices back into
    // coordinates over the original text.
    utterance.onboundary = (event: SpeechSynthesisEvent) => {
      if (this.cancelled) return;
      const local = event.charIndex ?? 0;
      const length = event.charLength || wordLengthAt(chunk.text, local);
      this.options.onBoundary?.({
        charIndex: chunk.offset + local,
        charLength: length,
        elapsedTime: event.elapsedTime,
        name: event.name || 'word',
      });
    };

    utterance.onend = () => {
      // cancel() also fires onend in Chrome; the flag keeps us from advancing.
      if (this.cancelled) return;
      this.index += 1;
      this.speakNext();
    };

    utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
      if (this.cancelled || event.error === 'interrupted' || event.error === 'canceled') return;
      this.stopWatchdog();
      if (active === this) active = null;
      this.options.onError?.(new Error(`Speech synthesis failed: ${event.error}`));
    };

    speechSynthesis.speak(utterance);
  }

  private finish(): void {
    this.stopWatchdog();
    if (active === this) active = null;
    this.options.onEnd?.();
  }

  pause(): void {
    if (this.cancelled || this.userPaused) return;
    this.userPaused = true;
    speechSynthesis.pause();
    this.options.onPause?.();
  }

  resume(): void {
    if (this.cancelled || !this.userPaused) return;
    this.userPaused = false;
    speechSynthesis.resume();
    this.options.onResume?.();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.stopWatchdog();
    speechSynthesis.cancel();
    if (active === this) active = null;
  }

  get speaking(): boolean {
    return !this.cancelled && speechSynthesis.speaking;
  }

  get paused(): boolean {
    return this.userPaused;
  }

  /** Total characters, so callers can size a progress indicator. */
  get length(): number {
    return this.text.length;
  }
}

/**
 * Speak `text`. Cancels anything already speaking - there is one voice, so
 * there is one session.
 */
export function speak(text: string, options: SpeakOptions = {}): TtsController {
  active?.cancel();
  const session = new Session(text, options);
  active = session;
  return session;
}

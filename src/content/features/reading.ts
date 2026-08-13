/**
 * Reading Mode.
 *
 *   Alt+Shift+L  command.readPage    read the whole page
 *   Alt+Shift+R  command.readAloud   read the current selection
 *
 * Both do the same thing to a different span of the page: speak it, move a word
 * highlight in step with the voice, and wash the paragraph being read, so
 * someone can follow along visually while listening. A second press of the same
 * shortcut stops, as does Escape, the Stop button, and leaving the page.
 *
 * This feature calls no model. Everything here is local - speechSynthesis plus
 * the overlay layer - so it costs nothing, works offline, and works with no API
 * key set, which is the point of having it in the demo.
 *
 * HOW THE WORD SYNC WORKS, which is the whole design:
 *
 * ctx.tts.speak() reports boundaries as a charIndex into the exact string it
 * was handed, continuous across the document. So we flatten the page into one
 * string and remember, for every word we emit, which text node it came from and
 * at what offset. A boundary event is then a binary search back to (node,
 * offset), and ctx.highlight.highlightTextSlice() paints it without touching
 * the page's own DOM.
 *
 * Flattening is the fiddly half, because the flat string has to read the way
 * the page renders:
 *   - hidden, aria-hidden, script/style and form-control subtrees are dropped
 *     whole, so we never speak something invisible;
 *   - open shadow roots are walked, and slotted content is read once, where it
 *     renders - a plain TreeWalker stops dead at a shadow boundary and leaves a
 *     component-built page looking half empty with no error to explain why;
 *   - page furniture (nav, aside, footer) is dropped when reading a page, but
 *     kept when the user selected it on purpose;
 *   - a block boundary becomes a blank line, which chunkText() turns into a
 *     real pause, and <br> becomes a single newline.
 */

import type { FeatureContext } from '../context.js';

// Types taken off the context: a feature imports context.js and nothing else,
// so it can never end up with a second panel or a second voice.
type Marker = ReturnType<FeatureContext['highlight']['outlineElement']>;
type SpeakOptions = NonNullable<Parameters<FeatureContext['tts']['speak']>[1]>;
type Boundary = Parameters<NonNullable<SpeakOptions['onBoundary']>>[0];
type PanelActions = NonNullable<Parameters<FeatureContext['panel']['show']>[0]['actions']>;

type Mode = 'page' | 'selection';

// Panel action ids are namespaced: onAction handlers are global, so every
// feature sees every id, and the bare ids 'explain', 'simplify' and 'read' are
// already wired to dispatch() in content/index.ts.
const ACTION_PAUSE = 'reading:pause';
const ACTION_BACK = 'reading:back';
const ACTION_SKIP = 'reading:skip';
const ACTION_STOP = 'reading:stop';

/** Ceiling on one reading, so a pathological page cannot hang the tab. */
const MAX_CHARS = 200_000;

/** Keep the spoken word at least this far from the viewport edge. */
const SCROLL_MARGIN_PX = 96;

/** After a manual scroll, leave the user where they put themselves. */
const MANUAL_SCROLL_GRACE_MS = 4000;

/** speechSynthesis.speaking is false for a moment while a session starts. */
const START_GRACE_MS = 2000;

/**
 * Words into a paragraph that still count as "at the start", so Back goes to
 * the previous paragraph rather than restarting this one. Same as every audio
 * player's back button.
 */
const BACK_RESTART_WORDS = 2;

/** A "paragraph" taller than this is page scaffolding; do not wash it. */
const MAX_BLOCK_WASH_RATIO = 1.5;

// ---------------------------------------------------------------------------
// What counts as readable
// ---------------------------------------------------------------------------

/** Not content, or content a voice can do nothing with. Dropped subtree and all. */
const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'SVG', 'MATH', 'CANVAS',
  'IFRAME', 'FRAME', 'OBJECT', 'EMBED', 'VIDEO', 'AUDIO', 'TRACK', 'SOURCE',
  'MAP', 'AREA', 'DIALOG', 'DATALIST',
  // Form controls: the value in them is the user's, and reading a half-typed
  // card number aloud in an open office is its own privacy problem. The labels
  // around them still get read.
  'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'OPTGROUP',
]);

/** Page furniture. "Read the page" means the page, not the menu. */
const FURNITURE_TAGS = new Set(['NAV', 'ASIDE', 'FOOTER']);
const FURNITURE_ROLES = new Set(['navigation', 'complementary', 'contentinfo', 'search']);

/**
 * Lucid's own surfaces. The panel and overlay layer are shadow-hosted, and so
 * is the chart feature's badge layer - now that this walk goes through open
 * shadow roots, skipping the hosts is what stops us reading our own buttons
 * back to the user.
 */
const OWN_HOST_IDS = new Set([
  'lucid-panel-host',
  'lucid-overlay-host',
  'lucid-chart-badges',
]);

/**
 * Tags that do not break the line when rendered, so crossing one is not a
 * pause. Used instead of getComputedStyle('display') per element: the
 * difference only shows up on pages that restyle spans as blocks, and this
 * costs nothing on the pages people actually read.
 */
const INLINE_TAGS = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'BUTTON', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN',
  'EM', 'FONT', 'I', 'IMG', 'INS', 'KBD', 'LABEL', 'MARK', 'METER', 'NOBR',
  'OUTPUT', 'PICTURE', 'PROGRESS', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SAMP', 'SLOT',
  'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR',
]);

function isReadableElement(element: Element, skipFurniture: boolean): boolean {
  const tag = element.tagName;
  if (SKIP_TAGS.has(tag)) return false;
  if (OWN_HOST_IDS.has(element.id)) return false;
  if (skipFurniture) {
    if (FURNITURE_TAGS.has(tag)) return false;
    const role = element.getAttribute('role');
    if (role !== null && FURNITURE_ROLES.has(role.trim().toLowerCase())) return false;
  }
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (element instanceof HTMLElement && element.hidden) return false;

  // One getComputedStyle per element, not per text node, because failing here
  // drops everything inside the element too.
  const style = getComputedStyle(element);
  if (style.display === 'none') return false;
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (style.opacity === '0') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Flattening the page
// ---------------------------------------------------------------------------

/** One span of the flat string that maps back to something on the page. */
type Piece =
  | { kind: 'text'; start: number; end: number; block: Element; node: Text; nodeStart: number }
  | { kind: 'image'; start: number; end: number; block: Element; element: Element };

interface Readable {
  text: string;
  /** Sorted, non-overlapping. The gaps between them are separators. */
  pieces: Piece[];
  /** True when the page was longer than MAX_CHARS and we stopped early. */
  truncated: boolean;
}

/**
 * How much space belongs before the next word. Strongest pending gap wins.
 *
 * 'none' is the interesting one: it means the source had no whitespace at this
 * junction, so the page renders the two runs glued together and we speak them
 * glued too. That is what keeps "1<sup>st</sup>", "$<span>1,299</span>" and
 * "un<b>break</b>able" intact. The cost is that deliberately abutted separate
 * words - <a>Vehicles</a><a>Drivers</a> in a menu - are read as one word, but
 * those render glued on screen as well, and menus are furniture we skip.
 */
type Gap = 'none' | 'space' | 'line' | 'para';

const GAP_RANK: Record<Gap, number> = { none: 0, space: 1, line: 2, para: 3 };
const GAP_TEXT: Record<Gap, string> = { none: '', space: ' ', line: '\n', para: '\n\n' };

class FlatText {
  private readonly parts: string[] = [];
  private readonly pieces: Piece[] = [];
  private length = 0;
  private gap: Gap = 'none';
  truncated = false;

  get size(): number {
    return this.length;
  }

  mark(gap: Gap): void {
    if (GAP_RANK[gap] > GAP_RANK[this.gap]) this.gap = gap;
  }

  word(node: Text, nodeStart: number, word: string, block: Element): void {
    const start = this.separate();
    this.append(word);
    this.pieces.push({ kind: 'text', start, end: this.length, block, node, nodeStart });
  }

  /** Alt text has no text node to highlight, so the image itself gets ringed. */
  image(element: Element, label: string, block: Element): void {
    const start = this.separate();
    this.append(label);
    this.pieces.push({ kind: 'image', start, end: this.length, block, element });
  }

  finish(): Readable {
    return { text: this.parts.join(''), pieces: this.pieces, truncated: this.truncated };
  }

  private append(text: string): void {
    this.parts.push(text);
    this.length += text.length;
  }

  /** Emit the pending gap; returns the index the next run starts at. */
  private separate(): number {
    // Nothing leads the string: a gap before the first word would shift every
    // offset in the map by one.
    if (this.length > 0) {
      const text = GAP_TEXT[this.gap];
      if (text) this.append(text);
    }
    this.gap = 'none';
    return this.length;
  }
}

/** True when `node` is at least partly inside `range`. */
function inRange(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    // A node in another tree - a shadow root, typically - is not comparable.
    return false;
  }
}

/**
 * Walks the flattened tree: light DOM, open shadow roots, and slotted content
 * where it renders rather than where it was written.
 *
 * Following the flattened tree is what makes slots correct. Content in the
 * light DOM of a component renders inside that component's shadow tree, at the
 * <slot> that claimed it, so walking both trees verbatim reads it twice.
 * Closed shadow roots are unreachable for everyone and are left alone.
 *
 * The block a word sits in is threaded down the recursion rather than looked up
 * by climbing back out of it, which is both exact across shadow boundaries and
 * free.
 */
class Flattener {
  private readonly flat = new FlatText();
  /** Block that produced the last word, for deciding where pauses go. */
  private lastBlock: Element | null = null;
  private stopped = false;

  constructor(
    private readonly range: Range | null,
    private readonly skipFurniture: boolean,
  ) {}

  run(root: Element): Readable {
    this.children(root, root);
    return this.flat.finish();
  }

  private children(parent: Node, block: Element): void {
    for (let child = parent.firstChild; child !== null; child = child.nextSibling) {
      if (this.stopped) return;
      this.visit(child, block);
    }
  }

  private visit(node: Node, block: Element): void {
    if (this.stopped) return;
    if (this.flat.size >= MAX_CHARS) {
      this.flat.truncated = true;
      this.stopped = true;
      return;
    }

    if (node.nodeType === Node.TEXT_NODE) {
      this.text(node as Text, block);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node as Element;
    if (!isReadableElement(element, this.skipFurniture)) return;

    if (element.tagName === 'BR') {
      this.flat.mark('line');
      return;
    }
    if (element.tagName === 'IMG') {
      this.image(element, block);
      return;
    }

    // Slotted content renders at the slot, so it is read at the slot.
    // assignedNodes({ flatten: true }) also hands back the slot's own fallback
    // children when nothing was assigned, which is exactly what renders.
    if (element instanceof HTMLSlotElement) {
      for (const assigned of element.assignedNodes({ flatten: true })) {
        this.visit(assigned, block);
      }
      return;
    }

    const inner = INLINE_TAGS.has(element.tagName) ? block : element;

    // An open shadow root replaces the element's own children: those only
    // render if a <slot> inside pulls them in.
    const shadow = element.shadowRoot;
    if (shadow) {
      this.children(shadow, inner);
      return;
    }
    this.children(element, inner);
  }

  private text(node: Text, block: Element): void {
    const data = node.data;
    if (!data) return;
    if (!data.trim()) {
      // Whitespace between two words, wherever it happens to live. The space
      // between two inline elements is often a text node of its own, and it is
      // the only evidence that those are separate words.
      this.flat.mark('space');
      return;
    }

    let from = 0;
    let to = data.length;
    if (this.range) {
      if (!inRange(this.range, node)) return;
      if (node === this.range.startContainer) from = Math.max(from, this.range.startOffset);
      if (node === this.range.endContainer) to = Math.min(to, this.range.endOffset);
      if (from >= to) return;
    }

    const slice = data.slice(from, to);
    const words = /\S+/g;
    let match: RegExpExecArray | null;
    let first = true;

    while ((match = words.exec(slice)) !== null) {
      const word = match[0];
      if (!word) break;

      if (!first) {
        this.flat.mark('space');
      } else if (this.lastBlock !== null && block !== this.lastBlock) {
        this.flat.mark('para');
      } else if (match.index > 0) {
        // Leading whitespace in the source is a word gap.
        this.flat.mark('space');
      }

      this.flat.word(node, from + match.index, word, block);
      first = false;
    }

    if (!first) {
      this.lastBlock = block;
      // Trailing whitespace separates this node from whatever comes next.
      if (/\s$/.test(slice)) this.flat.mark('space');
    }
  }

  private image(element: Element, block: Element): void {
    const alt = (element.getAttribute('alt') ?? '').trim();
    if (!alt) return;
    if (this.range && !inRange(this.range, element)) return;

    this.flat.mark(this.lastBlock !== null && block !== this.lastBlock ? 'para' : 'space');
    this.flat.image(element, `Image: ${alt}`, block);
    this.lastBlock = block;
  }
}

function buildPage(): Readable {
  const root = document.body ?? document.documentElement;
  return new Flattener(null, true).run(root);
}

/**
 * Flatten the selection. Furniture is kept here: if someone selected the nav
 * and asked for it to be read, read it.
 */
function buildSelection(): Readable | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (!range.toString().trim()) return null;

  const container = range.commonAncestorContainer;
  const root =
    container.nodeType === Node.ELEMENT_NODE
      ? (container as Element)
      : (container.parentElement ?? document.body);
  if (!root) return null;

  return new Flattener(range, false).run(root);
}

/**
 * Index of the piece being spoken at `index`, or -1. A boundary can land on the
 * separator just before a word, so a near miss forwards to the word about to be
 * spoken rather than dropping the highlight for a beat.
 */
function pieceIndexAt(pieces: Piece[], index: number): number {
  let low = 0;
  let high = pieces.length - 1;
  let next = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const piece = pieces[mid];
    if (!piece) break;
    if (index < piece.start) {
      next = mid;
      high = mid - 1;
    } else if (index >= piece.end) {
      low = mid + 1;
    } else {
      return mid;
    }
  }

  // Longest separator we ever emit is "\n\n".
  if (next >= 0) {
    const piece = pieces[next];
    if (piece && piece.start - index <= 2) return next;
  }
  return -1;
}

function rectForSlice(node: Text, start: number, end: number): DOMRect | null {
  if (start < 0 || end > node.data.length || start >= end) return null;
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  return range.getBoundingClientRect();
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Nearest ancestor that scrolls, or null when the page itself is the scroller.
 *
 * Text inside a scrolling panel - half of every dashboard - cannot be reached
 * by scrolling the window, so following the voice has to know the difference.
 */
function scrollableAncestor(element: Element | null): Element | null {
  for (let node = element; node !== null; node = node.parentElement) {
    if (node === document.body || node === document.documentElement) break;
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      return node;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The reading session
// ---------------------------------------------------------------------------

class Narration {
  private speech: ReturnType<FeatureContext['tts']['speak']> | null = null;
  private readable: Readable | null = null;
  private voice: { rate: number; voiceURI: string | null } | null = null;

  private wordMarker: Marker | null = null;
  private blockMarker: Marker | null = null;
  private markedPiece: Piece | null = null;
  private markedBlock: Element | null = null;

  private mode: Mode = 'page';
  private paused = false;
  private startedAt = 0;
  private sawWord = false;
  /**
   * Skipping restarts speech from part-way through the flat text, so boundary
   * indices are relative to that offset. Everything outside onBoundary works in
   * whole-document coordinates.
   */
  private base = 0;
  private cursor = 0;

  private manualScrollAt = 0;
  private detachScrollWatch: (() => void) | null = null;

  constructor(private readonly ctx: FeatureContext) {}

  /**
   * Whether a reading is still going. speechSynthesis.speaking dips to false
   * between chunks and before the first utterance, and stays true while
   * paused, so the flag alone answers neither question.
   */
  private get live(): boolean {
    if (!this.speech) return false;
    if (this.paused) return true;
    if (Date.now() - this.startedAt < START_GRACE_MS) return true;
    return this.ctx.tts.isSpeaking();
  }

  async start(mode: Mode): Promise<void> {
    const { ctx } = this;

    // Second press of the same shortcut stops. The other shortcut switches.
    if (this.live) {
      const same = this.mode === mode;
      this.stop();
      if (same) return;
    } else if (this.speech) {
      // Something else cancelled the voice (Escape, another feature). Tidy up
      // and start fresh rather than treating this press as the stop.
      this.reset();
    }

    if (!('speechSynthesis' in window)) {
      ctx.panel.show({
        title: 'Reading Mode',
        error: 'This browser has no speech synthesis, so Lucid cannot read aloud.',
      });
      return;
    }

    const readable = mode === 'selection' ? buildSelection() : buildPage();
    if (!readable || !readable.text.trim()) {
      ctx.panel.show({
        title: mode === 'selection' ? 'Nothing selected' : 'Nothing to read',
        body:
          mode === 'selection'
            ? 'Select some text and press Alt+Shift+R again, or press Alt+Shift+L to read the whole page.'
            : 'No readable text was found on this page.',
      });
      return;
    }

    const settings = await ctx.settings();

    this.readable = readable;
    this.mode = mode;
    this.sawWord = false;
    this.voice = { rate: settings.tts.rate, voiceURI: settings.tts.voiceURI };
    this.watchManualScroll();

    ctx.panel.show({
      title: mode === 'selection' ? 'Reading the selection' : 'Reading Mode',
      status: mode === 'selection' ? 'Reading the selection aloud' : 'Reading the page aloud',
      body: this.bodyText(readable),
      actions: this.actions(),
    });

    this.speakFrom(0);
    ctx.log.debug('reading started', { mode, chars: readable.text.length });
  }

  /** Stop and say so. Safe to call when nothing is reading. */
  stop(): void {
    const wasReading = this.speech !== null;
    this.reset();
    // update() un-hides the panel, so never touch one the user has dismissed.
    if (wasReading && this.ctx.panel.isOpen()) {
      this.ctx.panel.update({ status: 'Stopped reading', actions: [], busy: false });
    }
  }

  /** The voice was stopped for us - panel dismissed, or the page is going away. */
  abandon(): void {
    this.reset();
  }

  togglePause(): void {
    const speech = this.speech;
    if (!speech || !this.ctx.panel.isOpen()) return;

    if (this.paused) {
      this.paused = false;
      speech.resume();
      this.ctx.panel.update({ status: 'Reading again', actions: this.actions() });
    } else {
      this.paused = true;
      speech.pause();
      this.ctx.panel.update({ status: 'Paused', actions: this.actions() });
    }
  }

  /**
   * Jump a paragraph. There is no seeking in speechSynthesis, so this restarts
   * the voice from the paragraph's first word and rebases the boundary offsets.
   */
  jump(direction: 1 | -1): void {
    const readable = this.readable;
    if (!readable || !this.speech) return;

    const pieces = readable.pieces;
    const at = pieceIndexAt(pieces, this.cursor);
    const here = at >= 0 ? pieces[at] : undefined;
    if (!here) return;

    if (direction > 0) {
      let index = at;
      while (index < pieces.length && pieces[index]?.block === here.block) index += 1;
      const target = pieces[index];
      // Skipping off the end is the same as reaching it.
      if (!target) {
        this.finish();
        return;
      }
      this.speakFrom(target.start);
      return;
    }

    // Back goes to the top of this paragraph, or to the one before it if we
    // only just got here.
    let start = at;
    while (start > 0 && pieces[start - 1]?.block === here.block) start -= 1;
    if (at - start <= BACK_RESTART_WORDS && start > 0) {
      const earlierBlock = pieces[start - 1]?.block;
      while (start > 0 && pieces[start - 1]?.block === earlierBlock) start -= 1;
    }
    const target = pieces[start];
    if (target) this.speakFrom(target.start);
  }

  /** Speak from `offset` in the flat text, keeping the session otherwise intact. */
  private speakFrom(offset: number): void {
    const readable = this.readable;
    if (!readable) return;

    const wasPaused = this.paused;
    // cancel() never fires onEnd, so this does not look like a finished read.
    this.speech?.cancel();
    this.clearWordMarker();

    this.base = offset;
    this.cursor = offset;
    this.paused = false;
    this.startedAt = Date.now();

    this.speech = this.ctx.tts.speak(readable.text.slice(offset), {
      rate: this.voice?.rate ?? 1,
      voiceURI: this.voice?.voiceURI ?? null,
      onBoundary: (boundary) => this.onBoundary(boundary),
      onEnd: () => this.finish(),
      onError: (error) => this.onError(error),
    });

    // Only repaint the buttons when one of them has to change: render()
    // rebuilds them all, which throws away the focus of whoever clicked.
    if (wasPaused && this.ctx.panel.isOpen()) {
      this.ctx.panel.update({ actions: this.actions() });
    }
  }

  private onBoundary(boundary: Boundary): void {
    const readable = this.readable;
    if (!readable) return;

    // Voices that report sentence boundaries as well as word boundaries would
    // otherwise drag the highlight back to the start of the sentence. Once a
    // word boundary has been seen, words are the only thing we follow.
    if (boundary.name === 'word') this.sawWord = true;
    else if (this.sawWord) return;

    const index = this.base + boundary.charIndex;
    this.cursor = index;

    const at = pieceIndexAt(readable.pieces, index);
    const piece = at >= 0 ? readable.pieces[at] : undefined;
    if (!piece) {
      this.clearWordMarker();
      return;
    }

    this.washBlock(piece.block);

    // Alt text is spoken over several boundaries; the ring is already up.
    if (piece.kind === 'image' && piece === this.markedPiece) return;

    this.clearWordMarker();
    this.markedPiece = piece;

    if (piece.kind === 'image') {
      this.wordMarker = this.ctx.highlight.outlineElement(piece.element);
      this.keepInView(piece.element.getBoundingClientRect(), piece.element);
      return;
    }

    const offset = piece.nodeStart + (index - piece.start);
    const remaining = piece.nodeStart + (piece.end - piece.start) - offset;
    const length = Math.max(1, Math.min(boundary.charLength || 1, remaining));

    this.wordMarker = this.ctx.highlight.highlightTextSlice(piece.node, offset, offset + length, {
      variant: 'word',
    });
    this.keepInView(rectForSlice(piece.node, offset, offset + length), piece.node.parentElement);
  }

  /**
   * Wash the paragraph being read - a soft block behind the text, under the
   * word marker, so it is obvious where on the page the voice is even when the
   * word itself is off to one side.
   */
  private washBlock(block: Element): void {
    if (block === this.markedBlock) return;

    this.blockMarker?.remove();
    this.blockMarker = null;
    this.markedBlock = block;

    // Pages with no paragraph markup put everything in one container; washing
    // that is just tinting the whole screen.
    if (block === document.body || block === document.documentElement) return;
    const height = block.getBoundingClientRect().height;
    if (height > window.innerHeight * MAX_BLOCK_WASH_RATIO) return;

    this.blockMarker = this.ctx.highlight.outlineElement(block, {
      variant: 'fill',
      padding: 4,
    });
  }

  private finish(): void {
    const finished = this.mode;
    this.reset();
    if (!this.ctx.panel.isOpen()) return;
    this.ctx.panel.update({
      status: finished === 'selection' ? 'Finished the selection' : 'Finished reading the page',
      body: '',
      actions: [],
      busy: false,
    });
  }

  private onError(error: Error): void {
    this.reset();
    this.ctx.log.warn('reading failed', error);
    // setError() also un-hides; a dismissed panel means the user already
    // walked away from this reading.
    if (this.ctx.panel.isOpen()) this.ctx.panel.setError(error.message);
  }

  /** Drop every bit of session state. Does not touch the panel. */
  private reset(): void {
    this.speech?.cancel();
    this.speech = null;
    this.readable = null;
    this.voice = null;
    this.paused = false;
    this.sawWord = false;
    this.base = 0;
    this.cursor = 0;
    this.clearWordMarker();
    this.blockMarker?.remove();
    this.blockMarker = null;
    this.markedBlock = null;
    this.detachScrollWatch?.();
    this.detachScrollWatch = null;
  }

  private clearWordMarker(): void {
    this.wordMarker?.remove();
    this.wordMarker = null;
    this.markedPiece = null;
  }

  private actions(): PanelActions {
    return [
      { id: ACTION_PAUSE, label: this.paused ? 'Resume' : 'Pause', primary: true },
      { id: ACTION_BACK, label: 'Back' },
      { id: ACTION_SKIP, label: 'Skip' },
      {
        id: ACTION_STOP,
        label: 'Stop',
        hint: this.mode === 'selection' ? 'Alt+Shift+R' : 'Alt+Shift+L',
      },
    ];
  }

  /**
   * Static text, deliberately. render() rebuilds the action buttons on every
   * update(), which would throw away a keyboard user's focus, and every status
   * change is announced - so a per-word progress readout would both steal focus
   * and talk over the voice it was reporting on.
   */
  private bodyText(readable: Readable): string {
    const lines = [
      this.mode === 'selection'
        ? 'Reading your selection. Press Alt+Shift+R again to stop.'
        : 'Reading this page. Press Alt+Shift+L again to stop.',
    ];
    if (readable.truncated) {
      lines.push('This page is very long, so only the first part will be read.');
    }
    return lines.join('\n');
  }

  /** Follow the voice down the page, without fighting a user who scrolled. */
  private keepInView(rect: DOMRect | null, target: Element | null): void {
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    if (Date.now() - this.manualScrollAt < MANUAL_SCROLL_GRACE_MS) return;

    const above = rect.top < SCROLL_MARGIN_PX;
    const below = rect.bottom > window.innerHeight - SCROLL_MARGIN_PX;
    if (!above && !below) return;

    // Reduced motion means reduced motion: jump, do not glide.
    const behavior = prefersReducedMotion() ? 'auto' : 'smooth';

    // scrollIntoView walks every scrollable ancestor, which is the only way to
    // reach a word inside a panel that scrolls independently of the page.
    if (target && scrollableAncestor(target)) {
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior });
      return;
    }

    // Otherwise centre the word itself, which is more precise than centring
    // whatever element happens to contain it.
    const top = window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2;
    window.scrollTo({ top: Math.max(0, top), behavior });
  }

  /**
   * Only direct input counts as a manual scroll - our own scrollTo fires
   * 'scroll', so listening for that would silence the auto-scroll for good.
   */
  private watchManualScroll(): void {
    this.detachScrollWatch?.();
    const seen = () => {
      this.manualScrollAt = Date.now();
    };
    const options = { passive: true, capture: true } as const;
    window.addEventListener('wheel', seen, options);
    window.addEventListener('touchmove', seen, options);
    this.detachScrollWatch = () => {
      window.removeEventListener('wheel', seen, options);
      window.removeEventListener('touchmove', seen, options);
    };
  }
}

export function register(ctx: FeatureContext): void {
  const narration = new Narration(ctx);

  ctx.onCommand('command.readPage', () => narration.start('page'));
  ctx.onCommand('command.readAloud', () => narration.start('selection'));

  ctx.panel.onAction((id) => {
    if (id === ACTION_PAUSE) narration.togglePause();
    else if (id === ACTION_BACK) narration.jump(-1);
    else if (id === ACTION_SKIP) narration.jump(1);
    else if (id === ACTION_STOP) narration.stop();
  });

  // Escape and the close button stop the voice in index.ts; this drops the
  // session state that went with it.
  ctx.panel.onDismiss(() => narration.abandon());

  // Navigating away cancels the voice in index.ts. Clearing our own state too
  // matters for a back-forward-cache restore, where the page comes back alive
  // with the session it had when it left.
  window.addEventListener('pagehide', () => narration.abandon());

  ctx.log.debug('reading mode feature registered');
}

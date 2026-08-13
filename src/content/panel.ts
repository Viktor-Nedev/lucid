/**
 * The shared floating panel. Every Lucid feature renders into this one
 * surface - there is never a second panel on the page.
 *
 * Consumers get a singleton via `getPanel()`. See ARCHITECTURE.md for the
 * consumer-facing walkthrough; the short version:
 *
 *     const panel = getPanel();
 *     panel.beginStream('Explaining this image');   // clears body, shows spinner
 *     panel.appendBody(delta);                      // once per streamed chunk
 *     panel.endStream();                            // announces the result
 *
 * ACCESSIBILITY NOTES, because they drove the design and are easy to undo:
 *
 * 1. The visible body is NOT a live region. Streaming deltas into an
 *    aria-live element makes screen readers announce every fragment, which is
 *    unusable. Instead a visually-hidden role="status" element announces
 *    short status changes, and the finished text exactly once via endStream().
 *
 * 2. The panel is a non-modal dialog. It does not trap focus - a keyboard user
 *    must be able to Tab straight back out to the page. Escape dismisses and
 *    returns focus to wherever it was before the panel opened.
 *
 * 3. Colours come from CSS custom properties with a forced-colors override, so
 *    the panel stays readable in Windows High Contrast where hard-coded
 *    backgrounds would vanish.
 */

import { createLogger } from '../shared/logger.js';
import type { Settings } from '../shared/storage.js';
import { DEFAULT_SETTINGS, getSettings, onSettingsChanged } from '../shared/storage.js';
import { adoptExternalStyles } from '../shared/theme.js';

const log = createLogger('content:panel');

const HOST_ID = 'lucid-panel-host';

export interface PanelAction {
  /** Passed to onAction handlers. */
  id: string;
  label: string;
  /** Optional keyboard hint rendered beside the label, e.g. "Alt+Shift+R". */
  hint?: string;
  /** Renders as the primary button. At most one per action set. */
  primary?: boolean;
}

export interface PanelTable {
  columns: string[];
  rows: Array<Array<string | number>>;
  caption?: string;
}

export interface PanelState {
  /** Heading text. Also the panel's accessible name. */
  title: string;
  /** Short progress line, e.g. "Reading the chart...". Announced politely. */
  status?: string;
  /** Main body text. Replaces whatever is there. */
  body?: string;
  /** Rendered as a real <table> under the body. */
  table?: PanelTable;
  actions?: PanelAction[];
  /** Shows the progress indicator and marks the panel aria-busy. */
  busy?: boolean;
  /** Renders in the error style and is announced assertively. */
  error?: string;
}

export interface ShowOptions {
  /**
   * Move focus to the panel heading. Default true, because the panel is
   * normally opened by an explicit user command and a keyboard user needs to
   * land on it. Pass false for anything opened without a direct user action.
   */
  focus?: boolean;
}

export interface Panel {
  show(state: PanelState, options?: ShowOptions): void;
  /** Merge a partial update into the current state. */
  update(patch: Partial<PanelState>): void;

  /** Clear the body and enter streaming mode. */
  beginStream(title: string, status?: string): void;
  /** Append one streamed chunk. No-op unless beginStream ran first. */
  appendBody(text: string): void;
  /** Leave streaming mode and announce the finished body once. */
  endStream(): void;

  setError(message: string): void;
  hide(): void;
  isOpen(): boolean;

  /** Subscribe to action-button presses. Returns an unsubscribe function. */
  onAction(handler: (id: string) => void): () => void;
  /** Subscribe to dismissal (Escape or the close button). */
  onDismiss(handler: () => void): () => void;

  /**
   * Hide the panel for the duration of `fn`, then restore it.
   * capture.ts uses this so the panel never appears in a screenshot.
   */
  withHidden<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * The element containing body text. Reading Mode walks its text nodes to
   * paint word highlights; treat it as read-mostly.
   */
  readonly bodyElement: HTMLElement;

  destroy(): void;
}

const STYLES = `
:host {
  all: initial;
  --lucid-bg: #ffffff;
  --lucid-fg: #14161a;
  --lucid-muted: #5b6270;
  --lucid-border: #d5d9e0;
  --lucid-accent: #1e5fbf;
  --lucid-accent-fg: #ffffff;
  --lucid-error: #a3121a;
  --lucid-shadow: 0 8px 32px rgba(10, 14, 24, 0.22);
  --lucid-radius: 12px;
  --lucid-font-size: 15px;

  position: fixed;
  inset-block-end: 20px;
  inset-inline-end: 20px;
  z-index: 2147483647;
  display: block;
  contain: layout style;
  color-scheme: light dark;
}

@media (prefers-color-scheme: dark) {
  :host {
    --lucid-bg: #16181d;
    --lucid-fg: #f2f4f8;
    --lucid-muted: #a4acbb;
    --lucid-border: #343a45;
    --lucid-accent: #6aa5ff;
    --lucid-accent-fg: #0b0d11;
    --lucid-error: #ff9b9b;
    --lucid-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
  }
}

/* Windows High Contrast and forced-colors modes: hand every colour back to
   the OS. Hard-coded values are ignored there and the panel would otherwise
   render as an unreadable block. */
@media (forced-colors: active) {
  :host {
    --lucid-bg: Canvas;
    --lucid-fg: CanvasText;
    --lucid-muted: CanvasText;
    --lucid-border: CanvasText;
    --lucid-accent: Highlight;
    --lucid-accent-fg: HighlightText;
    --lucid-error: CanvasText;
    --lucid-shadow: none;
  }
  .panel { border-width: 2px; }
}

:host([hidden]) { display: none; }

.panel {
  box-sizing: border-box;
  width: min(420px, calc(100vw - 40px));
  max-height: min(70vh, 640px);
  display: flex;
  flex-direction: column;
  background: var(--lucid-bg);
  color: var(--lucid-fg);
  border: 1px solid var(--lucid-border);
  border-radius: var(--lucid-radius);
  box-shadow: var(--lucid-shadow);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: var(--lucid-font-size);
  line-height: 1.55;
}

.header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 12px 8px 16px;
  border-bottom: 1px solid var(--lucid-border);
}

.title {
  flex: 1;
  margin: 0;
  font-size: 1em;
  font-weight: 600;
  line-height: 1.3;
}
.title:focus-visible { outline: 2px solid var(--lucid-accent); outline-offset: 3px; }

.close {
  flex: none;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  padding: 0;
  font: inherit;
  font-size: 18px;
  line-height: 1;
  color: var(--lucid-muted);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
}
.close:hover { color: var(--lucid-fg); border-color: var(--lucid-border); }
.close:focus-visible { outline: 2px solid var(--lucid-accent); outline-offset: 2px; }

.content { padding: 12px 16px 4px; overflow-y: auto; overscroll-behavior: contain; }

.status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  color: var(--lucid-muted);
  font-size: 0.9em;
}
.status[hidden] { display: none; }

.spinner {
  width: 12px;
  height: 12px;
  flex: none;
  border: 2px solid var(--lucid-border);
  border-top-color: var(--lucid-accent);
  border-radius: 50%;
  animation: lucid-spin 0.8s linear infinite;
}
@keyframes lucid-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .spinner { animation: none; border-top-color: var(--lucid-border); }
}

.body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.body:empty { display: none; }

.error {
  margin: 8px 0 0;
  padding: 10px 12px;
  color: var(--lucid-error);
  border: 1px solid currentColor;
  border-radius: 8px;
  font-size: 0.95em;
}
.error[hidden] { display: none; }

table {
  width: 100%;
  margin-top: 12px;
  border-collapse: collapse;
  font-size: 0.92em;
}
caption { text-align: left; padding-bottom: 6px; color: var(--lucid-muted); }
th, td {
  padding: 6px 8px;
  border: 1px solid var(--lucid-border);
  text-align: left;
  vertical-align: top;
}
th { font-weight: 600; background: color-mix(in srgb, var(--lucid-fg) 6%, transparent); }

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 16px;
}
.actions:empty { display: none; }

button.action {
  font: inherit;
  font-size: 0.92em;
  padding: 7px 12px;
  color: var(--lucid-fg);
  background: transparent;
  border: 1px solid var(--lucid-border);
  border-radius: 8px;
  cursor: pointer;
}
button.action:hover { border-color: var(--lucid-accent); }
button.action:focus-visible { outline: 2px solid var(--lucid-accent); outline-offset: 2px; }
button.action.primary {
  color: var(--lucid-accent-fg);
  background: var(--lucid-accent);
  border-color: var(--lucid-accent);
}
.hint { margin-left: 6px; color: var(--lucid-muted); font-size: 0.85em; }
button.action.primary .hint { color: inherit; opacity: 0.8; }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
`;

class PanelImpl implements Panel {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;

  private readonly titleEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly spinner: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly tableSlot: HTMLElement;
  private readonly actionsEl: HTMLElement;
  private readonly liveRegion: HTMLElement;
  private readonly alertRegion: HTMLElement;

  private readonly actionHandlers = new Set<(id: string) => void>();
  private readonly dismissHandlers = new Set<() => void>();

  private state: PanelState = { title: '' };
  private streaming = false;
  /** Serialised copy of the rendered table, so we can skip identical rebuilds. */
  private tableSignature = '';
  private previousFocus: Element | null = null;
  private settings: Settings = DEFAULT_SETTINGS;

  constructor() {
    this.host = document.createElement('div');
    this.host.id = HOST_ID;
    this.host.hidden = true;

    this.root = this.host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLES;

    const panel = document.createElement('div');
    panel.className = 'panel';
    // Non-modal dialog: announced as a dialog, but focus is never trapped.
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'lucid-title');

    this.titleEl = document.createElement('h2');
    this.titleEl.className = 'title';
    this.titleEl.id = 'lucid-title';
    // Focusable so we can move focus here on open without adding a tab stop.
    this.titleEl.tabIndex = -1;

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close Lucid panel');
    close.textContent = '✕';
    close.addEventListener('click', () => this.dismiss());

    const header = document.createElement('div');
    header.className = 'header';
    header.append(this.titleEl, close);

    this.spinner = document.createElement('span');
    this.spinner.className = 'spinner';
    this.spinner.setAttribute('aria-hidden', 'true');

    this.statusText = document.createElement('span');

    this.statusEl = document.createElement('p');
    this.statusEl.className = 'status';
    this.statusEl.hidden = true;
    this.statusEl.append(this.spinner, this.statusText);

    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'body';

    this.errorEl = document.createElement('p');
    this.errorEl.className = 'error';
    this.errorEl.hidden = true;

    this.tableSlot = document.createElement('div');

    const content = document.createElement('div');
    content.className = 'content';
    content.append(this.statusEl, this.bodyEl, this.errorEl, this.tableSlot);

    this.actionsEl = document.createElement('div');
    this.actionsEl.className = 'actions';

    // Announcement channels, kept out of the visual tree. See note 1 up top.
    this.liveRegion = document.createElement('div');
    this.liveRegion.className = 'sr-only';
    this.liveRegion.setAttribute('role', 'status');
    this.liveRegion.setAttribute('aria-live', 'polite');

    this.alertRegion = document.createElement('div');
    this.alertRegion.className = 'sr-only';
    this.alertRegion.setAttribute('role', 'alert');

    panel.append(header, content, this.actionsEl);
    this.root.append(style, panel, this.liveRegion, this.alertRegion);

    // Design-owned overrides, if this build shipped any. See shared/theme.ts.
    adoptExternalStyles(this.root, 'panel.css');

    // documentElement, not body: some sites replace body wholesale on navigation.
    document.documentElement.appendChild(this.host);

    this.onKeyDown = this.onKeyDown.bind(this);
    document.addEventListener('keydown', this.onKeyDown, true);

    void getSettings().then((s) => this.applySettings(s));
    onSettingsChanged((s) => this.applySettings(s));
  }

  private applySettings(settings: Settings): void {
    this.settings = settings;
    const base = 15 * settings.panel.fontScale;
    this.host.style.setProperty('--lucid-font-size', `${base}px`);
    if (settings.panel.highContrast) {
      this.host.style.setProperty('--lucid-border', 'currentColor');
      this.host.style.setProperty('--lucid-shadow', 'none');
    } else {
      this.host.style.removeProperty('--lucid-border');
      this.host.style.removeProperty('--lucid-shadow');
    }
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || this.host.hidden) return;
    // Only swallow the key if focus is inside the panel or nothing else wants it.
    event.stopPropagation();
    this.dismiss();
  }

  private dismiss(): void {
    this.hide();
    for (const handler of this.dismissHandlers) {
      try {
        handler();
      } catch (err) {
        log.error('dismiss handler threw', err);
      }
    }
  }

  private announce(message: string, assertive = false): void {
    const region = assertive ? this.alertRegion : this.liveRegion;
    // Clearing first guarantees a repeat of identical text is still announced.
    region.textContent = '';
    window.setTimeout(() => {
      region.textContent = message;
    }, 50);
  }

  private render(): void {
    const { title, status, body, table, actions, busy, error } = this.state;

    this.titleEl.textContent = title;

    const showStatus = Boolean(status) || Boolean(busy);
    this.statusEl.hidden = !showStatus;
    this.statusText.textContent = status ?? '';
    this.spinner.style.display = busy ? '' : 'none';
    this.host.setAttribute('aria-busy', busy ? 'true' : 'false');

    if (!this.streaming) this.bodyEl.textContent = body ?? '';

    this.errorEl.hidden = !error;
    this.errorEl.textContent = error ?? '';

    // Same reasoning as the action buttons below. A table has no focusable
    // children, but rebuilding it throws a screen reader's cursor back to the
    // start of it - so only rebuild when the data genuinely changed.
    const tableSignature = table
      ? JSON.stringify([table.caption ?? '', table.columns, table.rows])
      : '';
    if (tableSignature !== this.tableSignature) {
      this.tableSignature = tableSignature;
      this.tableSlot.replaceChildren();
      if (table) this.tableSlot.appendChild(renderTable(table));
    }

    this.renderActions(actions ?? []);
  }

  /**
   * Reconcile the action buttons against `actions`, keyed by id.
   *
   * This used to blow the whole row away and rebuild it on every render, which
   * meant any feature calling update() at a high rate - a streaming caller
   * doing per-chunk updates, say - destroyed the button a keyboard user was
   * standing on and recreated it underneath them. Focus fell to the document.
   * In a tool built for people who navigate by keyboard and screen reader,
   * silently moving focus is close to the worst failure available, and the
   * feature hitting it had been working around it by keeping its panel static.
   *
   * So: a button whose id is unchanged is never recreated. Its text is updated
   * in place only if it actually differs, and the element - with its focus -
   * survives. Only genuinely new ids create elements, and only removed ids
   * destroy them.
   */
  private renderActions(actions: PanelAction[]): void {
    const existing = new Map<string, HTMLButtonElement>();
    for (const child of Array.from(this.actionsEl.children)) {
      const id = child instanceof HTMLElement ? child.dataset['actionId'] : undefined;
      if (id && child instanceof HTMLButtonElement) existing.set(id, child);
    }

    const desired: HTMLButtonElement[] = [];
    for (const action of actions) {
      const reused = existing.get(action.id);
      if (reused) {
        existing.delete(action.id);
        this.updateActionButton(reused, action);
        desired.push(reused);
      } else {
        desired.push(this.createActionButton(action));
      }
    }

    // Anything left in `existing` is an action that no longer exists.
    for (const stale of existing.values()) stale.remove();

    // Only touch the DOM order if it is actually wrong. Re-inserting a node
    // moves it, and moving a focused element blurs it - which would reintroduce
    // the exact bug this method exists to fix.
    const current = Array.from(this.actionsEl.children);
    const orderMatches =
      current.length === desired.length && desired.every((button, i) => current[i] === button);
    if (orderMatches) return;

    // activeElement inside a shadow root is read from the root, not document -
    // document.activeElement would just report the host.
    const focused = this.root.activeElement;
    this.actionsEl.replaceChildren(...desired);

    if (
      focused instanceof HTMLElement &&
      focused.isConnected &&
      this.root.activeElement !== focused
    ) {
      focused.focus({ preventScroll: true });
    }
  }

  private createActionButton(action: PanelAction): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset['actionId'] = action.id;

    // One listener for the element's lifetime, reading the id at click time.
    // Attaching per render would stack duplicate handlers onto a reused button.
    button.addEventListener('click', () => {
      const id = button.dataset['actionId'];
      if (!id) return;
      for (const handler of this.actionHandlers) {
        try {
          handler(id);
        } catch (err) {
          log.error('action handler threw', err);
        }
      }
    });

    this.updateActionButton(button, action);
    return button;
  }

  /** Update a button in place, writing only what changed. */
  private updateActionButton(button: HTMLButtonElement, action: PanelAction): void {
    button.dataset['actionId'] = action.id;

    const className = action.primary ? 'action primary' : 'action';
    if (button.className !== className) button.className = className;

    let hint = button.querySelector<HTMLElement>('.hint');
    const labelNode = button.firstChild;

    if (labelNode?.nodeType === Node.TEXT_NODE) {
      if (labelNode.textContent !== action.label) labelNode.textContent = action.label;
    } else {
      button.prepend(document.createTextNode(action.label));
    }

    if (action.hint) {
      if (!hint) {
        hint = document.createElement('span');
        hint.className = 'hint';
        button.appendChild(hint);
      }
      if (hint.textContent !== action.hint) hint.textContent = action.hint;
    } else if (hint) {
      hint.remove();
    }
  }

  show(state: PanelState, options: ShowOptions = {}): void {
    this.state = { ...state };
    this.streaming = false;
    const wasHidden = this.host.hidden;
    if (wasHidden) this.previousFocus = document.activeElement;
    this.host.hidden = false;
    this.render();

    if (state.status) this.announce(state.status);
    if (state.error) this.announce(state.error, true);

    if (options.focus !== false && wasHidden) {
      this.titleEl.focus({ preventScroll: true });
    }
  }

  update(patch: Partial<PanelState>): void {
    this.state = { ...this.state, ...patch };
    if (this.host.hidden) this.host.hidden = false;
    this.render();
    if (patch.status) this.announce(patch.status);
    if (patch.error) this.announce(patch.error, true);
  }

  beginStream(title: string, status = 'Working...'): void {
    this.show({ title, status, body: '', busy: true }, { focus: true });
    this.streaming = true;
    this.bodyEl.textContent = '';
  }

  appendBody(text: string): void {
    if (!this.streaming) {
      log.warn('appendBody called outside a stream; call beginStream first');
      return;
    }
    this.bodyEl.append(text);
    this.state.body = (this.state.body ?? '') + text;
  }

  endStream(): void {
    if (!this.streaming) return;
    this.streaming = false;
    this.update({ busy: false, status: undefined });
    const finished = this.state.body ?? '';
    // The one and only announcement of the generated text.
    if (finished.trim()) this.announce(finished);
  }

  setError(message: string): void {
    this.streaming = false;
    this.update({ error: message, busy: false, status: undefined });
  }

  hide(): void {
    if (this.host.hidden) return;
    this.host.hidden = true;
    this.streaming = false;
    const previous = this.previousFocus;
    this.previousFocus = null;
    if (previous instanceof HTMLElement && previous.isConnected) {
      previous.focus({ preventScroll: true });
    }
  }

  isOpen(): boolean {
    return !this.host.hidden;
  }

  onAction(handler: (id: string) => void): () => void {
    this.actionHandlers.add(handler);
    return () => this.actionHandlers.delete(handler);
  }

  onDismiss(handler: () => void): () => void {
    this.dismissHandlers.add(handler);
    return () => this.dismissHandlers.delete(handler);
  }

  async withHidden<T>(fn: () => Promise<T>): Promise<T> {
    const wasVisible = !this.host.hidden;
    if (wasVisible) this.host.style.visibility = 'hidden';
    try {
      return await fn();
    } finally {
      if (wasVisible) this.host.style.visibility = '';
    }
  }

  get bodyElement(): HTMLElement {
    return this.bodyEl;
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKeyDown, true);
    this.host.remove();
    this.actionHandlers.clear();
    this.dismissHandlers.clear();
  }
}

function renderTable(table: PanelTable): HTMLElement {
  const el = document.createElement('table');

  if (table.caption) {
    const caption = document.createElement('caption');
    caption.textContent = table.caption;
    el.appendChild(caption);
  }

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of table.columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = column;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  el.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const row of table.rows) {
    const tr = document.createElement('tr');
    row.forEach((cell, index) => {
      // First column is the row header, which is what makes a data table
      // navigable cell-by-cell in a screen reader.
      const td = document.createElement(index === 0 ? 'th' : 'td');
      if (index === 0) td.setAttribute('scope', 'row');
      td.textContent = String(cell);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  el.appendChild(tbody);

  return el;
}

let instance: Panel | null = null;

/** The page's single panel. Constructed on first call. */
export function getPanel(): Panel {
  if (!instance) instance = new PanelImpl();
  return instance;
}

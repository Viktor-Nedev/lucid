/**
 * Form fields - explain what a confusing form is actually asking for.
 *
 * Trigger is Alt+Shift+F, handled in the page rather than through a manifest
 * command: Chrome allows four suggested shortcuts and all four are spent, and
 * manifest.json has one owner. Everything here is therefore self-contained.
 *
 * THE COST MODEL, which drives the whole design. Tabbing through a form must
 * not reach the network - that is verified on camera with DevTools open. So:
 *
 *   1. Nothing happens until the user presses Alt+Shift+F. That scans the
 *      whole form and makes exactly ONE request for every field at once.
 *   2. That result arms the form. From then on, moving focus between fields
 *      announces each one from the cached result, at zero cost and instantly.
 *
 * Batching is also what makes the answers good: the model sees the whole form,
 * so it can tell that a narrow unlabelled box under an address row is probably
 * an apartment number - which is unknowable from that field alone.
 *
 * PRIVACY, the one non-negotiable. We send field METADATA only: labels, names,
 * types, placeholders, and visible text near the control. The value a user has
 * typed is never read and never leaves the page. That is not just a matter of
 * avoiding `.value` - a <textarea>'s textContent IS what was typed into it,
 * and a contenteditable div is the same thing wearing a different tag, so the
 * text harvester below refuses to descend into either. A form-explaining
 * feature that exfiltrates a half-typed card number is worse than no feature.
 */

import type { DomContext, FormFieldDescriptor, FormFieldPurpose } from '../../shared/messages.js';
import { cacheKeyFor } from '../../shared/storage.js';
import type { FeatureContext } from '../context.js';

/** Taken off ctx so this file never imports tts.js or highlight.js. */
type Speech = ReturnType<FeatureContext['tts']['speak']>;
type Outline = ReturnType<FeatureContext['highlight']['outlineElement']>;

const CONTROL_SELECTOR = 'input, select, textarea';

/** Controls that are not asking the user for anything. */
const IGNORED_INPUT_TYPES = new Set(['hidden', 'submit', 'reset', 'button', 'image']);

/**
 * Elements whose text is either not page copy or is user input. INPUT and
 * SELECT cannot hold text, but TEXTAREA's textContent is the typed value and
 * OPTION's can be a typed value in a datalist, so the whole family is opaque.
 */
const TEXT_OPAQUE = new Set([
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'OPTGROUP',
  'DATALIST',
  'BUTTON',
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'SVG',
  'CANVAS',
]);

/** Enough for any real form; a ceiling so a generated page cannot blow the request up. */
const MAX_FIELDS = 40;

/** Action ids are namespaced: every feature's handler sees every button press. */
const ACTION_ALL = 'form:all';
const ACTION_STOP = 'form:stop';
const ACTION_MUTE = 'form:mute';

/** Where a validation message is likely to live, across the conventions in the wild. */
const ERROR_SELECTOR = [
  '[role="alert"]',
  '[aria-live="assertive"]',
  '.error',
  '.err',
  '.errtext',
  '.invalid',
  '.validation-message',
  '[class*="error"]',
  '[class*="invalid"]',
  '[id*="error"]',
  '[id*="err"]',
].join(', ');

interface ScannedField {
  descriptor: FormFieldDescriptor;
  /** The control to outline. For a radio group, its first member. */
  element: HTMLElement;
  /** Every control this descriptor covers. One, except for radio groups. */
  members: HTMLElement[];
}

// ---------------------------------------------------------------------------
// DOM reading
// ---------------------------------------------------------------------------

function isVisible(element: Element): boolean {
  const withCheck = element as Element & {
    checkVisibility?: (options?: Record<string, boolean>) => boolean;
  };
  if (typeof withCheck.checkVisibility === 'function') {
    return withCheck.checkVisibility({ checkVisibilityCSS: true });
  }
  return (element as HTMLElement).getClientRects().length > 0;
}

function isControl(element: Element): element is HTMLElement {
  return element.matches(CONTROL_SELECTOR);
}

/** Lucid's own panel and overlay are shadow content; never scan ourselves. */
function isLucidHost(element: Element): boolean {
  return element.id.startsWith('lucid-');
}

function shadowOf(element: Element): ShadowRoot | null {
  return (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
}

/**
 * querySelectorAll that descends into OPEN shadow roots.
 *
 * Modern component-framework sites put their inputs inside web components,
 * where a plain querySelectorAll finds nothing - and those are exactly the
 * sites whose labelling is bad enough to need this feature. Closed roots stay
 * unreachable; that is the platform, not a bug.
 */
function queryDeep<T extends Element>(scope: ParentNode, selector: string, out: T[] = []): T[] {
  out.push(...Array.from(scope.querySelectorAll<T>(selector)));
  for (const element of Array.from(scope.querySelectorAll('*'))) {
    if (isLucidHost(element)) continue;
    const nested = shadowOf(element);
    if (nested) queryDeep(nested, selector, out);
  }
  return out;
}

function countDeep(scope: ParentNode, selector: string): number {
  return queryDeep(scope, selector).length;
}

/** ID and label lookups are scoped to the tree a control actually lives in. */
function rootOf(node: Node): Document | ShadowRoot {
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root : document;
}

/** document.activeElement stops at a shadow host; the real focus is inside it. */
function deepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  for (let depth = 0; depth < 10; depth += 1) {
    const inner = active ? shadowOf(active)?.activeElement : null;
    if (!inner) break;
    active = inner;
  }
  return active;
}

/**
 * Visible page text under `node`, walking the COMPOSED tree so text inside web
 * components is not silently missed, with every form control's subtree removed.
 *
 * The exclusions are the privacy boundary, not tidiness: a plain textContent
 * call here would put whatever the user has typed into a textarea or a
 * contenteditable straight into the request body.
 */
function collectText(node: Node, out: string[], budget: { left: number }): void {
  if (budget.left <= 0) return;

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.nodeValue?.replace(/\s+/g, ' ').trim();
    if (text) {
      out.push(text);
      budget.left -= text.length + 1;
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const element = node as Element;
  if (TEXT_OPAQUE.has(element.tagName)) return;
  if (isLucidHost(element)) return;
  if (element.hasAttribute('contenteditable')) return;
  if (element.getAttribute('aria-hidden') === 'true') return;
  if (!isVisible(element)) return;

  // A slot renders its assigned light-DOM nodes, so follow the assignment
  // rather than the child list - otherwise slotted text is counted twice or
  // (when the host is walked shadow-first) not at all.
  if (element instanceof HTMLSlotElement) {
    for (const assigned of element.assignedNodes({ flatten: true })) {
      collectText(assigned, out, budget);
    }
    return;
  }

  const shadow = shadowOf(element);
  const children = shadow ? shadow.childNodes : element.childNodes;
  for (const child of Array.from(children)) collectText(child, out, budget);
}

function visibleTextIn(root: Element, limit: number): string {
  const parts: string[] = [];
  const budget = { left: limit };
  for (const child of Array.from(root.childNodes)) collectText(child, parts, budget);
  const joined = parts.join(' ');
  return joined.length > limit ? `${joined.slice(0, limit).trimEnd()}…` : joined;
}

function labelTextFor(control: HTMLElement): string | null {
  const scope = rootOf(control);

  const labelledBy = control.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => scope.getElementById(id))
      .filter((element): element is HTMLElement => element !== null)
      .map((element) => visibleTextIn(element, 120))
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }

  // Deliberately exact: a label whose for= points at an id that does not exist
  // is a broken association, and reporting it as a working one would hide the
  // very problem this feature exists to explain.
  if (control.id) {
    const explicit = scope.querySelector(`label[for="${CSS.escape(control.id)}"]`);
    if (explicit) {
      const text = visibleTextIn(explicit, 160);
      if (text) return text;
    }
  }

  const wrapping = control.closest('label');
  if (wrapping) {
    const text = visibleTextIn(wrapping, 160);
    if (text) return text;
  }

  return null;
}

function commonAncestor(elements: HTMLElement[]): Element | null {
  let node: Element | null = elements[0] ?? null;
  while (node && !elements.every((element) => node?.contains(element) ?? false)) {
    node = node.parentElement;
  }
  return node;
}

/**
 * Text around a control, climbing until a block has something to say.
 *
 * `budget` is how many controls the block is allowed to contain. Climbing past
 * that means the block has swallowed a neighbouring field, and attributing
 * that field's caption to this one is worse than returning nothing.
 */
function nearbyTextFor(startFrom: Element | null, budget: number, container: Element): string | null {
  let node = startFrom;
  for (let depth = 0; node && node !== container && depth < 4; depth += 1) {
    if (countDeep(node, CONTROL_SELECTOR) > budget) break;
    const text = visibleTextIn(node, 300);
    if (text.length >= 8) return text;
    node = node.parentElement;
  }

  // Nothing of its own. Then the block above is the only signal there is: a
  // narrow box directly under an address row is an apartment number, and
  // nothing on the page says so. Flagged as indirect so the model can weigh it.
  const previous = startFrom?.previousElementSibling;
  if (previous) {
    const text = visibleTextIn(previous, 200);
    if (text) return `no text of its own; the block immediately above it reads: ${text}`;
  }
  return null;
}

/**
 * Option labels for a select. These are author-written markup, never a typed
 * value - and the selected option is deliberately not identified - so this
 * stays on the metadata side of the privacy line while making the difference
 * between "a mystery dropdown" and "Title: Mr, Mrs, Dr".
 */
function optionLabels(control: HTMLElement): string {
  if (!(control instanceof HTMLSelectElement)) return '';
  return Array.from(control.options)
    .slice(0, 8)
    .map((option) => option.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(Boolean)
    .join(', ');
}

function scanFields(container: Element): ScannedField[] {
  const controls = queryDeep<HTMLElement>(container, CONTROL_SELECTOR).filter(
    (control) => {
      if (control instanceof HTMLInputElement && IGNORED_INPUT_TYPES.has(control.type)) return false;
      if (control instanceof HTMLInputElement && control.disabled) return false;
      if (control instanceof HTMLSelectElement && control.disabled) return false;
      if (control instanceof HTMLTextAreaElement && control.disabled) return false;
      return isVisible(control);
    },
  );

  // Radios sharing a name are one question, not N questions. Grouping keeps
  // the request small and stops the model reporting "Personal", "Business" and
  // "Education" as three unrelated fields.
  const groups: HTMLElement[][] = [];
  const byName = new Map<string, HTMLElement[]>();
  for (const control of controls) {
    const name = control.getAttribute('name');
    const isRadio = control instanceof HTMLInputElement && control.type === 'radio';
    if (isRadio && name) {
      const existing = byName.get(name);
      if (existing) {
        existing.push(control);
        continue;
      }
      const created = [control];
      byName.set(name, created);
      groups.push(created);
      continue;
    }
    groups.push([control]);
  }

  const scanned: ScannedField[] = [];
  for (const members of groups.slice(0, MAX_FIELDS)) {
    const control = members[0];
    if (!control) continue;

    const isGroup = members.length > 1;
    // For a group, start the climb above the block holding the choices, so the
    // question ("Account type") is picked up and not just the options.
    const startFrom = isGroup
      ? (commonAncestor(members)?.parentElement ?? control.parentElement)
      : control.parentElement;

    const choices = isGroup
      ? members
          .map((member) => labelTextFor(member) ?? member.getAttribute('value'))
          .filter(Boolean)
          .join(', ')
      : optionLabels(control);

    const nearby = nearbyTextFor(startFrom, members.length, container);
    const nearbyText =
      [nearby, choices ? `choices: ${choices}` : ''].filter(Boolean).join(' — ') || null;

    scanned.push({
      element: control,
      members,
      descriptor: {
        id: `f${scanned.length + 1}`,
        tag: control.tagName.toLowerCase(),
        type: control instanceof HTMLInputElement ? control.type : null,
        name: control.getAttribute('name'),
        placeholder: control.getAttribute('placeholder'),
        // A group's first radio is labelled "Personal", which is not the
        // group's label; the question is in nearbyText instead.
        labelText: isGroup ? null : labelTextFor(control),
        ariaLabel: control.getAttribute('aria-label'),
        autocomplete: control.getAttribute('autocomplete'),
        required:
          control.hasAttribute('required') || control.getAttribute('aria-required') === 'true',
        nearbyText,
      },
    });
  }

  return scanned;
}

/** Constraints the page states in markup. Attributes only - never a value. */
function requirementsOf(control: HTMLElement | null): string {
  if (!control) return '';
  const bits: string[] = [];
  const type = control instanceof HTMLInputElement ? control.type : null;
  if (type && type !== 'text') bits.push(`it is an input of type "${type}"`);

  const pattern = control.getAttribute('pattern');
  if (pattern) bits.push(`its value must match the pattern ${pattern}`);

  const maxLength = control.getAttribute('maxlength');
  if (maxLength) bits.push(`at most ${maxLength} characters`);
  const minLength = control.getAttribute('minlength');
  if (minLength) bits.push(`at least ${minLength} characters`);

  const min = control.getAttribute('min');
  if (min) bits.push(`no lower than ${min}`);
  const max = control.getAttribute('max');
  if (max) bits.push(`no higher than ${max}`);

  const inputMode = control.getAttribute('inputmode');
  if (inputMode) bits.push(`it expects ${inputMode} input`);

  if (control.hasAttribute('required') || control.getAttribute('aria-required') === 'true') {
    bits.push('it is required');
  }
  return bits.join('; ');
}

/** The form-ish container the user is asking about. */
function resolveContainer(): HTMLElement | null {
  const active = deepActiveElement();
  if (active instanceof HTMLElement && isControl(active)) {
    const owner = (active as HTMLInputElement).form;
    if (owner) return owner;
    const group = enclosingGroup(active);
    if (group) return group;
  }

  // Not document.forms: that collection stops at the light DOM.
  const forms = queryDeep<HTMLFormElement>(document, 'form').filter(
    (form) => scanFields(form).length > 0,
  );
  const best = forms.reduce<{ form: HTMLFormElement; count: number } | null>((winner, form) => {
    const count = scanFields(form).length;
    return !winner || count > winner.count ? { form, count } : winner;
  }, null);
  if (best) return best.form;

  // Plenty of real pages never use a <form> element at all.
  const loose = queryDeep<HTMLElement>(document, CONTROL_SELECTOR).find((control) =>
    isVisible(control),
  );
  return loose ? enclosingGroup(loose) : null;
}

/** Nearest ancestor holding more than one control, for form-less markup. */
function enclosingGroup(control: HTMLElement): HTMLElement | null {
  let node = control.parentElement;
  for (let depth = 0; node && depth < 6; depth += 1) {
    if (countDeep(node, CONTROL_SELECTOR) > 1) return node;
    if (node === document.body) return node;
    node = node.parentElement;
  }
  return control.parentElement;
}

// ---------------------------------------------------------------------------
// Feature
// ---------------------------------------------------------------------------

interface Armed {
  container: HTMLElement;
  fields: ScannedField[];
  purposes: Map<string, FormFieldPurpose>;
  /** Control -> descriptor id, so a focus event finds its answer in O(1). */
  owners: WeakMap<Element, string>;
  observer: MutationObserver;
  /** Error texts already explained, so one rejection costs one request. */
  explained: Set<string>;
}

export function register(ctx: FeatureContext): void {
  let armed: Armed | null = null;
  let speech: Speech | null = null;
  let outline: Outline | null = null;
  let busy = false;
  let lastAnnounced: string | null = null;
  let focusTimer = 0;
  let errorTimer = 0;

  function stopSpeech(): void {
    speech?.cancel();
    speech = null;
  }

  function clearOutline(): void {
    outline?.remove();
    outline = null;
  }

  function disarm(): void {
    armed?.observer.disconnect();
    armed = null;
    lastAnnounced = null;
    clearOutline();
    stopSpeech();
  }

  function speak(text: string): void {
    if (!text.trim()) return;
    void ctx.settings().then((settings) => {
      stopSpeech();
      speech = ctx.tts.speak(text, {
        rate: settings.tts.rate,
        voiceURI: settings.tts.voiceURI,
        onEnd: () => {
          speech = null;
        },
        onError: () => {
          speech = null;
        },
      });
    });
  }

  function displayName(field: ScannedField, purpose: FormFieldPurpose | undefined): string {
    if (purpose?.label) return purpose.label;
    const { labelText, ariaLabel, placeholder, name } = field.descriptor;
    return labelText ?? ariaLabel ?? placeholder ?? name ?? 'Unlabelled field';
  }

  // --- the whole-form overview ---------------------------------------------

  function renderOverview(state: Armed, cached: boolean): void {
    const rows: Array<Array<string | number>> = [];
    const spoken: string[] = [];
    let sensitiveCount = 0;

    for (const field of state.fields) {
      const purpose = state.purposes.get(field.descriptor.id);
      const name = displayName(field, purpose);
      const explanation = purpose?.purpose ?? 'Lucid could not work out what this field is for.';
      if (purpose?.sensitive) sensitiveCount += 1;
      rows.push([purpose?.sensitive ? `${name} (sensitive)` : name, explanation]);
      spoken.push(`${purpose?.sensitive ? 'Sensitive. ' : ''}${name}. ${explanation}`);
    }

    const counted = `${state.fields.length} ${state.fields.length === 1 ? 'field' : 'fields'}.`;
    // Sensitive fields are the single most valuable thing this feature says,
    // so they lead rather than sitting in a column the reader has to reach.
    const warning =
      sensitiveCount > 0
        ? ` ${sensitiveCount === 1 ? 'One asks' : `${sensitiveCount} ask`} for sensitive personal information.`
        : '';

    ctx.panel.appendBody(`${counted}${warning}\n\n${rows.map(([n, p]) => `${n} — ${p}`).join('\n')}`);
    ctx.panel.update({
      table: {
        columns: ['Field', 'What it is asking for'],
        rows,
        caption: cached ? 'Reused an earlier reading of this form.' : undefined,
      },
      actions: [
        { id: ACTION_STOP, label: 'Stop reading', primary: true },
        { id: ACTION_MUTE, label: 'Stop announcing fields' },
      ],
    });
    // Not optional: this is the one announcement a screen reader gets.
    ctx.panel.endStream();
    speak(`${counted}${warning} ${spoken.join(' ')}`);
  }

  async function explainForm(container: HTMLElement): Promise<void> {
    if (busy) return;
    const fields = scanFields(container);
    if (fields.length === 0) {
      ctx.panel.show({
        title: 'Form fields',
        body: 'There are no form fields here to explain. Put the cursor in a form and press Alt+Shift+F again.',
      });
      return;
    }

    busy = true;
    stopSpeech();
    ctx.panel.beginStream(
      'What this form is asking for',
      `Reading ${fields.length} ${fields.length === 1 ? 'field' : 'fields'}...`,
    );

    try {
      const domContext: DomContext = {
        url: location.href,
        title: document.title,
        fields: fields.map((field) => field.descriptor),
      };
      // Keyed on the descriptors themselves, so the same form on a different
      // page still hits, and an edited form correctly misses.
      const cacheKey = await cacheKeyFor(
        location.href,
        'form',
        JSON.stringify(domContext.fields),
      );

      const response = await ctx.send('ai.inferFieldPurpose', { domContext, cacheKey });

      // Correlate on id, never on array position: the prompt asks for order to
      // be preserved but a model is not a guarantee, and a shifted-by-one form
      // explanation is confidently wrong rather than obviously broken.
      const purposes = new Map(response.fields.map((purpose) => [purpose.id, purpose]));
      const owners = new WeakMap<Element, string>();
      for (const field of fields) {
        for (const member of field.members) owners.set(member, field.descriptor.id);
      }

      armed?.observer.disconnect();
      const state: Armed = {
        container,
        fields,
        purposes,
        owners,
        observer: new MutationObserver(() => scheduleErrorScan()),
        explained: new Set(),
      };
      armed = state;

      // Watch the block around the form, not just the form: validation
      // summaries are routinely rendered as a sibling of <form>, not inside it.
      // A MutationObserver does not cross a shadow boundary either, so every
      // root holding one of our fields is observed in its own right.
      const watched = new Set<Node>([container.parentElement ?? container]);
      for (const field of fields) {
        const root = rootOf(field.element);
        if (root instanceof ShadowRoot) watched.add(root);
      }
      for (const target of watched) {
        state.observer.observe(target, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'hidden', 'style', 'aria-invalid', 'aria-describedby', 'role'],
        });
      }
      // Whatever is already on screen is the page's starting state, not a
      // rejection that just happened - record it so we do not explain it.
      for (const message of currentErrors(state)) state.explained.add(message.text);

      if (!ctx.panel.isOpen()) {
        // Dismissed while the request was in flight; keep the result armed but
        // do not drag the panel back on screen.
        busy = false;
        return;
      }
      renderOverview(state, response.cached);
    } catch (error) {
      // Covers missing_api_key - the message is already written for a human.
      ctx.panel.setError(error instanceof Error ? error.message : String(error));
    } finally {
      busy = false;
    }
  }

  // --- per-field announcements, once armed ---------------------------------

  function announceField(id: string, control: HTMLElement): void {
    const state = armed;
    if (!state) return;
    const field = state.fields.find((candidate) => candidate.descriptor.id === id);
    if (!field) return;

    const purpose = state.purposes.get(id);
    const name = displayName(field, purpose);
    const explanation = purpose?.purpose ?? 'Lucid could not work out what this field is for.';

    lastAnnounced = id;
    clearOutline();
    outline = ctx.highlight.outlineElement(control);

    speak(`${purpose?.sensitive ? 'Sensitive field. ' : ''}${name}. ${explanation}`);

    // Panel is the visual echo of the speech. It is never opened by a focus
    // move - that would pop a panel over every search box on the web - and the
    // body is not announced, so a screen reader hears this once, from the TTS.
    if (!ctx.panel.isOpen()) return;
    ctx.panel.update({
      title: purpose?.sensitive ? `${name} (sensitive)` : name,
      body: explanation,
      table: undefined,
      actions: [
        { id: ACTION_ALL, label: 'All fields', primary: true },
        { id: ACTION_STOP, label: 'Stop reading' },
        { id: ACTION_MUTE, label: 'Stop announcing fields' },
      ],
    });
  }

  function onFocusIn(event: FocusEvent): void {
    const state = armed;
    if (!state) return;
    // composedPath, not target: a focus event crossing a shadow boundary is
    // retargeted to the host, so event.target would be the web component
    // rather than the input the user actually landed on.
    const target = event.composedPath()[0] ?? event.target;
    if (!(target instanceof HTMLElement)) return;

    const id = state.owners.get(target);
    if (!id) {
      // Focus left the form entirely; drop the ring but stay armed.
      if (!state.container.contains(target)) {
        clearOutline();
        lastAnnounced = null;
      }
      return;
    }
    if (id === lastAnnounced) return;

    // Fast tabbing should not stutter the voice on every field it passes.
    window.clearTimeout(focusTimer);
    focusTimer = window.setTimeout(() => announceField(id, target), 140);
  }

  // --- validation errors ----------------------------------------------------

  interface ErrorMessage {
    text: string;
    control: HTMLElement | null;
  }

  function controlForMessage(element: Element, state: Armed): HTMLElement | null {
    if (element.id) {
      const described = queryDeep<HTMLElement>(
        state.container,
        `[aria-describedby~="${CSS.escape(element.id)}"]`,
      )[0];
      if (described) return described;
    }
    // Otherwise the control sharing this message's block, climbing a little.
    let node: Element | null = element.parentElement;
    for (let depth = 0; node && depth < 3; depth += 1) {
      const control = queryDeep<HTMLElement>(node, CONTROL_SELECTOR).find((candidate) =>
        state.owners.has(candidate),
      );
      if (control) return control;
      node = node.parentElement;
    }
    return queryDeep<HTMLElement>(state.container, '[aria-invalid="true"]')[0] ?? null;
  }

  function currentErrors(state: Armed): ErrorMessage[] {
    const scope = state.container.parentElement ?? state.container;
    const found: ErrorMessage[] = [];
    for (const element of queryDeep<HTMLElement>(scope, ERROR_SELECTOR)) {
      if (isControl(element)) continue;
      if (!isVisible(element)) continue;
      const text = visibleTextIn(element, 400);
      if (text.length < 3) continue;
      found.push({ text, control: controlForMessage(element, state) });
    }
    return found;
  }

  /**
   * Facts only, in the order a reader needs them. Deliberately carries no
   * instruction to the model: this string is handed to the simplifier, which
   * rewrites what it is given, so an instruction here would come back rewritten
   * as part of the answer.
   */
  function briefing(message: ErrorMessage, state: Armed): string {
    const lines = [
      'A form on this page has refused what was entered into it.',
      '',
      `The message the page shows, word for word: "${message.text}"`,
    ];

    const id = message.control ? state.owners.get(message.control) : undefined;
    const field = id ? state.fields.find((candidate) => candidate.descriptor.id === id) : undefined;
    const purpose = id ? state.purposes.get(id) : undefined;
    if (field) {
      lines.push(`The field it applies to: ${displayName(field, purpose)}.`);
      if (purpose?.purpose) lines.push(`What that field is for: ${purpose.purpose}`);
    }

    const requirements = requirementsOf(message.control);
    if (requirements) lines.push(`What the page states about that field in its markup: ${requirements}.`);

    return lines.join('\n');
  }

  function explainError(message: ErrorMessage, state: Armed): void {
    stopSpeech();
    clearOutline();
    if (message.control) outline = ctx.highlight.outlineElement(message.control);

    ctx.panel.beginStream('What went wrong', 'Putting that in plain language...');

    let text = '';
    void cacheKeyFor(location.href, 'form-error', message.text).then((cacheKey) => {
      ctx.stream(
        'ai.simplifyText',
        { text: briefing(message, state), readingLevel: 'simple', cacheKey },
        {
          onDelta: (delta) => {
            text += delta.text;
            ctx.panel.appendBody(delta.text);
          },
          onDone: (data) => {
            if (data.text) text = data.text;
            if (!ctx.panel.isOpen()) return;
            ctx.panel.endStream();
            ctx.panel.update({ actions: [{ id: ACTION_STOP, label: 'Stop reading', primary: true }] });
            speak(text);
          },
          onError: (error) => {
            if (!ctx.panel.isOpen()) return;
            ctx.panel.setError(error.message);
          },
        },
      );
    });
  }

  function scheduleErrorScan(): void {
    window.clearTimeout(errorTimer);
    errorTimer = window.setTimeout(() => {
      const state = armed;
      if (!state || busy) return;
      if (!state.container.isConnected) {
        disarm();
        return;
      }
      for (const message of currentErrors(state)) {
        if (state.explained.has(message.text)) continue;
        state.explained.add(message.text);
        explainError(message, state);
        // One rejection, one request. The rest are recorded as seen so a
        // second submission does not re-explain them.
        for (const other of currentErrors(state)) state.explained.add(other.text);
        return;
      }
    }, 250);
  }

  // --- wiring ---------------------------------------------------------------

  function onHotkey(): void {
    const state = armed;
    const active = deepActiveElement();

    // Already armed and the cursor is in a known field: repeat that field,
    // which costs nothing. Otherwise show the whole form again.
    if (state && active instanceof HTMLElement) {
      const id = state.owners.get(active);
      if (id) {
        lastAnnounced = null;
        announceField(id, active);
        return;
      }
      if (state.container.contains(active) || state.container === active) {
        if (ctx.panel.isOpen()) {
          renderOverviewFromCache(state);
          return;
        }
      }
    }

    const container = resolveContainer();
    if (!container) {
      ctx.panel.show({
        title: 'Form fields',
        body: 'Lucid could not find a form on this page. Put the cursor in a field and press Alt+Shift+F again.',
      });
      return;
    }
    if (state && state.container === container) {
      renderOverviewFromCache(state);
      return;
    }
    void explainForm(container);
  }

  /** Re-show the answer we already have, without going near the network. */
  function renderOverviewFromCache(state: Armed): void {
    stopSpeech();
    ctx.panel.beginStream(
      'What this form is asking for',
      `${state.fields.length} ${state.fields.length === 1 ? 'field' : 'fields'}`,
    );
    renderOverview(state, true);
  }

  window.addEventListener(
    'keydown',
    (event) => {
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
      // code, not key: Alt+Shift produces a dead or remapped key on several
      // layouts, and the physical F is what the user was told to press.
      if (event.code !== 'KeyF' && event.key.toLowerCase() !== 'f') return;
      event.preventDefault();
      event.stopPropagation();
      onHotkey();
    },
    true,
  );

  document.addEventListener('focusin', onFocusIn, true);

  ctx.panel.onAction((id) => {
    if (id === ACTION_STOP) {
      stopSpeech();
      return;
    }
    if (id === ACTION_ALL) {
      if (armed) renderOverviewFromCache(armed);
      return;
    }
    if (id === ACTION_MUTE) {
      disarm();
      if (ctx.panel.isOpen()) {
        ctx.panel.update({
          status: 'Lucid has stopped announcing fields. Press Alt+Shift+F to start again.',
          actions: [],
        });
      }
      return;
    }
    // Any other id belongs to another feature.
  });

  ctx.panel.onDismiss(() => {
    // Dismissing stops the voice and the ring, but stays armed: someone who
    // read the overview and pressed Escape to get back to the form still wants
    // each field announced as they reach it.
    speech = null;
    outline = null;
    lastAnnounced = null;
  });

  window.addEventListener('pagehide', () => disarm());

  ctx.log.debug('form feature registered');
}

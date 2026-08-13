# Lucid — architecture

An AI accessibility layer for the web, as a Chrome MV3 extension. This document
is for people building features on the foundation. It covers how the pieces fit
together, the APIs you will actually call, and the handful of constraints that
will bite you if you do not know about them.

---

## Build and run

```
npm install
npm run build      # bundle into dist/
npm run dev        # esbuild watch, rebuilds on save
npm run typecheck  # tsc --noEmit
npm run check      # smoke-test that the AI layer still bundles
npm run icons      # regenerate PNG icons (rarely needed)
```

Load the extension from **`dist/`**, not the repo root: `chrome://extensions` →
Developer mode → Load unpacked → select `dist/`. `dist/` is generated and
gitignored. After a rebuild, press reload on the extension card; content script
changes also need a page refresh.

Nothing works until an API key is set — open the options page and add one. The
extension opens it for you on first install.

---

## The three contexts

MV3 splits an extension across isolated worlds. Which context code runs in
determines what it is allowed to do, and most of the design follows from that.

| Context | File | Can | Cannot |
|---|---|---|---|
| Service worker | `background.js` | Call model APIs, capture the tab, own storage | Touch the page DOM. Is killed when idle |
| Content script | `content.js` | Read/modify the page, speak, draw overlays | Call model APIs (CORS), capture the tab |
| Options / offscreen | `options.js`, `offscreen.js` | Normal page powers; offscreen can hold a mic grant | — |

They talk over one typed contract, `src/shared/messages.ts`. Nothing else.

```
   content script  ──rpc / stream──▶  service worker  ──https──▶  Claude or Gemini
        │                                   │
   panel, TTS,                         capture, cache,
   highlights                          settings, prompts
```

---

## The message contract

`src/shared/messages.ts` is frozen. Two route tables, one per direction:

- **`BackgroundRoutes`** — content script or options page → service worker.
- **`TabRoutes`** — service worker → content script.

Adding a route is additive and safe: add an entry to the table, and every call
site is type-checked against it for free. Changing an existing route's shape is
a breaking change for whoever else is using it.

**Request/response** for anything that returns at once:

```ts
const { chart } = await ctx.send('ai.extractChartData', { image, contextText });
```

**Streaming** for anything that generates text, because a user should see words
appear rather than watch a spinner:

```ts
ctx.stream('ai.simplifyText', { text }, {
  onDelta: (d) => ctx.panel.appendBody(d.text),
  onDone:  () => ctx.panel.endStream(),
  onError: (e) => ctx.panel.setError(e.message),
});
```

Streaming runs over a `chrome.runtime` Port, not `sendMessage`. This is not
stylistic: MV3 tears down a `sendMessage` round trip that outlives the worker's
idle timer, and a long generation will outlive it. Cancelling the returned
handle disconnects the port, which aborts the underlying HTTP request.

Errors arrive as `LucidError` with a `code` (`missing_api_key`, `rate_limited`,
`refusal`, `not_implemented`, …) and a `retryable` flag. The `message` is
already written for a human — it is safe to put straight in the panel.

---

## The AI layer

```
handlers ──▶ AIClient (client.ts) ──▶ claude.ts   ──▶ Anthropic SDK
                                  └─▶ gemini.ts   ──▶ Gemini REST
                        prompts.ts (all prompt text, both providers)
```

`AIClient` has exactly four methods:

```ts
describeImage(base64, contextText, opts?)     → string     // streams
simplifyText(text, opts?)                     → string     // streams
extractChartData(base64, contextText, opts?)  → ChartData  // structured
inferFieldPurpose(domContext, opts?)          → FormFieldPurpose[]
```

`opts` carries `signal` (abort), `onDelta` (streaming), and `readingLevel`.

Get one with `await getAIClient()`. It reads the user's provider choice and key
from settings, so **no code above this line knows which provider is live**.
Switching provider in the options page takes effect on the next request.

- **All prompt text lives in `src/shared/prompts.ts`** and nowhere else. Both
  adapters read from it, so one tweak changes both providers. If you are
  writing prompt text inside a handler or an adapter, move it.
- The two structured calls are constrained by a JSON schema shared between
  providers — Claude via structured outputs, Gemini via `responseSchema`.
  `gemini.ts` translates the schema (uppercase types, no `additionalProperties`,
  `anyOf`-with-null collapsed to `nullable`).
- Both adapters are imported **statically**. Do not make them dynamic imports:
  an MV3 service worker cannot call `import()` after initial evaluation, so a
  lazy adapter fails at the moment a user first needs it. `npm run check`
  guards this.

---

## The panel

`src/content/panel.ts`. One panel per page, shared by every feature — get it
from `ctx.panel`, never construct one.

```ts
ctx.panel.show({ title, body?, status?, table?, actions?, busy?, error? }, { focus? })
ctx.panel.update(patch)          // merge into current state

ctx.panel.beginStream(title, status?)   // clear body, enter streaming mode
ctx.panel.appendBody(delta)             // once per streamed chunk
ctx.panel.endStream()                   // exit streaming, announce the result

ctx.panel.setError(message)
ctx.panel.hide()
ctx.panel.isOpen()

ctx.panel.onAction((id) => …)    // action button pressed; returns unsubscribe
ctx.panel.onDismiss(() => …)     // Escape or close button; returns unsubscribe
ctx.panel.bodyElement            // for Reading Mode's word highlights
```

The streaming trio is the normal path for Explain and Simplify. Use it and the
two features will look and behave like one product.

**Three accessibility properties you can accidentally destroy:**

1. **The visible body is deliberately not a live region.** Streaming deltas into
   an `aria-live` element makes a screen reader announce every fragment, which
   is unusable. A hidden `role="status"` element announces short status changes,
   and `endStream()` announces the finished text exactly once. This is why
   `endStream()` is not optional — skip it and a screen reader user never hears
   the answer.
2. **Focus is never trapped.** It is a non-modal dialog; a keyboard user must be
   able to Tab back out to the page. Escape dismisses and returns focus to
   wherever it was.
3. **Colours come from custom properties with a `forced-colors` override**, so
   the panel survives Windows High Contrast. Hard-coding a background undoes it.

`table` renders a real `<table>` with `<th scope="col">` headers and a
`<th scope="row">` first column — that is what makes chart data navigable
cell-by-cell in a screen reader. Hand it `columns`/`rows` unchanged rather than
flattening to prose.

### Restyling

Panel and overlay styles live in shadow roots, so ordinary page CSS cannot reach
them. Each root optionally adopts a design-owned stylesheet at runtime:

```
src/styles/panel.css     → the floating panel
src/styles/overlay.css   → highlights and outlines
```

Neither file has to exist. Overrides are adopted *after* the built-in styles.
The easiest surface to override is the custom properties on `:host` —
`--lucid-bg`, `--lucid-fg`, `--lucid-accent`, `--lucid-border`, `--lucid-radius`,
`--lucid-shadow`, `--lucid-font-size`. `src/styles/` belongs to the design owner;
components keep only the structural CSS they need to function.

---

## Highlights

`src/content/highlight.ts`, via `ctx.highlight`.

```ts
outlineElement(el, opts?)                       → handle   // ring around a target
highlightRange(range, opts?)                    → handle   // one box per line rect
highlightTextSlice(textNode, start, end, opts?) → handle | null   // Reading Mode
clearHighlights()
```

Handles expose `update()` and `remove()`; they reposition themselves on scroll
and resize automatically. Everything is drawn in a separate overlay layer and is
`aria-hidden` — nothing is injected into the page's DOM, because wrapping text in
marker elements breaks the page's own scripts and moves the screen reader cursor.

---

## Text to speech

`src/content/tts.ts`, via `ctx.tts`.

```ts
const handle = ctx.tts.speak(text, {
  rate, pitch, voiceURI, lang,
  onStart, onBoundary, onPause, onResume, onEnd, onError,
});
handle.pause(); handle.resume(); handle.cancel();
```

`onBoundary` gives `{ charIndex, charLength, elapsedTime, name }`, and
**`charIndex` indexes the original string you passed** — that is what Reading
Mode syncs its word highlight to.

Internally the text is split into short utterances, because Chrome silently stops
speaking after roughly fifteen seconds of one long utterance. Each chunk records
its offset and boundary events are rewritten back into whole-document
coordinates, so callers see one continuous index stream and never learn that
chunking happened. Do not "simplify" this by speaking the whole string at once.

`speak()` cancels anything already speaking — there is one voice, so one session.

---

## Region capture

`ctx.capture.captureElement(el)` returns a cropped JPEG of that element, ready to
hand to a vision call. The pipeline is split across contexts because only the
service worker may call `captureVisibleTab`.

Four things it handles for you, each of which is a bug if skipped:

1. **Scroll** — the target is scrolled into view first, then the page is put back
   exactly where the user left it, including on failure.
2. **Paint** — it waits two animation frames plus a settle before capturing.
   Capturing immediately after scrolling yields the *previous* frame cropped at
   the *new* coordinates, i.e. a screenshot of the wrong part of the page.
3. **Device pixels** — the rect is measured in CSS pixels and multiplied by
   `devicePixelRatio` worker-side. Skip it and on any HiDPI screen you crop a
   quarter of the target from near its top-left corner.
4. **Lucid's own UI** — every Lucid overlay is hidden for the duration, or the
   model ends up describing our own panel back to the user.

On that last point: capture hides everything matching
`[data-lucid-overlay], [id^="lucid-"]` under `<html>`, which covers the panel,
the highlight layer, and the chart badge layer today. **If you add an overlay,
give its host an `id` starting `lucid-` or a `data-lucid-overlay` attribute and
it is handled for free** — do not hide it yourself at your call sites. Two
features had each written their own copy of that before this was centralised,
and one of them reached into the other's DOM by hardcoded id to do it.

`captureVisibleTab` is rate-limited by Chrome, so calls are serialised and
retried; two features asking at once queue rather than one failing.

Pair it with `ctx.capture.contextTextFor(el)` to give the model surrounding page
text.

---

## Settings and cache

`src/shared/storage.ts`. Everything is in `chrome.storage.local` — never `sync`:
API keys must not leave the machine, and cached responses would blow the sync
quota immediately.

```ts
getSettings() / patchSettings(patch) / onSettingsChanged(cb)
cacheKeyFor(...parts) → sha256 hex
getCached(key) / setCached(key, value) / clearCache()
```

Build cache keys with `cacheKeyFor`, never by hand, or two call sites will
disagree about the same content and never hit:

```ts
const key = await cacheKeyFor(location.href, 'explain', selector);
```

Entries expire after a day and the oldest are evicted past 250. A key is stored
per provider-agnostic content identity, so switching provider reuses the cache —
if that is wrong for your feature, add the provider to the key parts.

---

## Where to add code

Each file below is owned by one person and can be filled in without touching
anything shared. They are all already imported and registered.

| Feature | Content file | Background handler | Trigger |
|---|---|---|---|
| Explain | `content/features/explain.ts` | `background/handlers/explain.ts` | `Alt+Shift+E` |
| Simplify | `content/features/simplify.ts` | `background/handlers/simplify.ts` | `Alt+Shift+S` |
| Reading Mode | `content/features/reading.ts` | — | `Alt+Shift+L` |
| Read selection | (any feature) | — | `Alt+Shift+R` |
| Chart data | `content/features/chart.ts` | `background/handlers/chart.ts` | feature's choice |
| Form fields | `content/features/form.ts` | `background/handlers/form.ts` | feature's choice |
| Voice | `content/features/voice.ts` | — | `voice-wake`, unassigned key |

Every stub carries a header comment with its route, the exact AI call, the
response shape, and a worked example. A background handler is about five lines.

A content feature exports `register(ctx)` and receives everything it needs on
`ctx` — panel, highlight, tts, capture, send, stream, settings, onCommand,
dispatch, log.

`ctx.onCommand(route, handler)` registers to handle a route; `ctx.dispatch(route)`
invokes one. Dispatch exists so a feature can hand work to whichever feature
owns it rather than duplicating it — voice control recognising "read this" and
triggering Reading Mode is the motivating case. A dispatched route is
indistinguishable from the user pressing that feature's shortcut. There is no
cycle detection, so dispatch routes you do not own, and never dispatch a route
from inside its own handler.
**Do not import `panel.js` or `tts.js` directly in a feature**, and do not edit
`content/index.ts`: that is what keeps six people out of one file, and what
guarantees the page has exactly one panel and one speech session. If something
you need is missing from `ctx`, add it to `FeatureContext` in `content/context.ts`.

Command name strings in `manifest.json` are a published contract — features bind
to them. `manifest.json` has one owner; ask rather than editing it.

---

## Constraints worth knowing

- **The service worker has no durable memory.** It is killed when idle and
  restarted on the next event. Anything that must survive goes in storage.
- **MV3 forbids runtime `import()` in the service worker.** Static imports only.
- **Content scripts cannot call the model APIs** — CORS. Everything goes through
  the worker.
- **Chrome allows four suggested shortcuts.** All four are spent; `toggle-panel`
  and `voice-wake` are declared without keys and are reachable from the toolbar
  button or assigned by the user at `chrome://extensions/shortcuts`.
- **Lucid cannot run on `chrome://` pages or the Web Store.** Capture fails there
  with a clear message; that is the platform, not a bug.
- **Never send form values to a model.** Field metadata only. A form-explaining
  feature that exfiltrates a half-typed card number is worse than no feature.
- **DOM scanning must pierce open shadow roots.** A plain `querySelectorAll`
  stops at a shadow boundary, and real pages put content behind one — the
  chartjs.org sample canvas lives in an open shadow root and is invisible to a
  naive scan. Walk into `element.shadowRoot` when it is non-null.
  `content/features/chart.ts` is the reference implementation. Closed roots
  cannot be pierced by anyone, including us; that is the platform.
- **`npm run check` bundles the AI layer separately.** It caught the SDK being
  absent back when every handler was a stub and the whole layer was tree-shaken
  out. The shipped bundle carries the SDK now that handlers are real, but the
  check still guards the thing that actually bites: a runtime `import()`
  sneaking into the service worker.

---

## Current state

| Feature | State |
|---|---|
| Simplify | working (`c25550b`) |
| Chart data | working (`6b0a15c`) |
| Explain | working (`71fe4ad`) |
| Form fields | working (`01d3eb9`) |
| Design system | landed (`5267cb7`) — `src/styles/` |
| Reading Mode | in flight |
| Voice | stub; `src/offscreen/` intentionally empty until Phase 7 |

All four AI capabilities are implemented — every background handler is real and
`not_implemented` no longer appears anywhere in `background/handlers/`.

The foundation underneath — contract, AI layer with both providers, panel, TTS,
highlights, capture, settings and cache — is complete and in use.

### Wiring the design system

`tokens.css` is deliberately duplicated into `panel.css` and `overlay.css`
rather than imported: `new CSSStyleSheet().replace()` discards `@import`, and a
shadow root cannot see `:root`. So the tokens travel with each shadow
stylesheet, and adopting those two files is sufficient — do not try to adopt
`tokens.css` separately.

Three consumers, three different mechanisms:

| Stylesheet | Consumed by | How |
|---|---|---|
| `panel.css` | panel shadow root | adopted automatically (`shared/theme.ts`) |
| `overlay.css` | highlight shadow root | adopted automatically (`shared/theme.ts`) |
| `options.css` | options page | `<link>` in `options.html` — ordinary document, not a shadow root |
| `badge.css` | chart badge shadow root | **needs one line in `content/features/chart.ts`**: `adoptExternalStyles(root, 'badge.css')` after its built-in styles |

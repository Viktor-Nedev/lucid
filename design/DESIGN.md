# Lucid — the design system

Open **`design/preview.html`** in a browser. Every component on that page is
painted by the shipping stylesheets in `src/styles/`, mounted into shadow roots
the same way the extension mounts them, so it is a live spec rather than a
mockup.

> **Viewing it in the AO Browser panel:** the preview server roots itself at the
> directory of whatever file you preview first, and this page links up out of
> `design/` into `src/styles/`. Preview a root-level file once so the server
> roots at the repo:
>
> ```bash
> ao preview README.md          # roots the server at the workspace
> ao preview design/preview.html
> ```
>
> Straight from disk (`file://`) or from any static server rooted at the repo,
> the relative links resolve and it just works.

---

## The idea

Ink and paper carry the interface. Colour is spent only where it means
something, and each colour has exactly one job:

| Colour | Means | Used by |
| --- | --- | --- |
| **Accent** (indigo) | anything you can interact with | buttons, focus rings, links, the block Lucid is working on |
| **Aurora** (violet → cyan → mint) | *the model is working* | the thinking state, and nothing else |
| **Amber** | *this is being read aloud* | the Reading Mode word marker, and nothing else |
| **Clay** | something went wrong | error states — calm, never a siren |

Because the aurora is spent nowhere else, its appearance is information: if it
is moving, Lucid is thinking. Same for amber and reading.

Motion follows one scale, in `tokens.css` and duplicated into each stylesheet:
`120ms` micro, `180ms` default, `240ms` emphasis, `380ms` for the panel
entrance and nothing else. Everything is eased. One thing moves at a time —
restraint is what reads as expensive.

**Every animation has a `prefers-reduced-motion` fallback**, and every surface
has a `forced-colors` block last in the file so Windows High Contrast wins.
Contrast was checked: all text pairs are ≥ 5.7:1, well past WCAG AA.

---

## Files

| File | Goes where | Status |
| --- | --- | --- |
| `src/styles/tokens.css` | canonical tokens; linked directly by the options page | ships |
| `src/styles/panel.css` | adopted into the panel shadow root | **live** — `panel.ts` already adopts it |
| `src/styles/overlay.css` | adopted into the overlay shadow root | **live** — `highlight.ts` already adopts it |
| `src/styles/badge.css` | the chart badge shadow root | needs one line, see below |
| `src/styles/options.css` | the settings page | needs one line, see below |
| `src/design/reading-cursor.ts` | optional Reading Mode component | opt-in |

> **Why the tokens are duplicated into each stylesheet:** shadow stylesheets are
> adopted through `new CSSStyleSheet().replace(css)`, which discards `@import`,
> and a shadow root cannot see `:root`. Each file therefore carries its own copy
> of the token block between `-- LUCID TOKENS --` banners. Change a value in
> `tokens.css`, then mirror it into the banners.

---

## Two one-line hooks, owned by other workers

Neither is mine to edit, and nothing breaks if they are never added — the
built-in styling simply stands on its own.

**1. The chart badge** — `src/content/features/chart.ts`, in `ensureLayer()`,
right after `root.append(style)`:

```ts
adoptExternalStyles(root, 'badge.css');
```

**2. The settings page** — `src/options/options.html`, as the *last* thing in
`<head>` so it lands after the page's own `<style>`:

```html
<link rel="stylesheet" href="styles/options.css" />
```

---

## Optional hooks, all of which degrade to something deliberate

| Hook | Where | Effect if never used |
| --- | --- | --- |
| `.error[data-variant="setup"]` | panel | "needs an API key" reads as accent-toned guidance rather than an error. Without it: a normal error. |
| `.lucid-eq` | panel | speaking indicator — see markup below |
| `.lucid-chunk` | panel | wrap each streamed chunk to reveal it as it lands. Without it: the finished answer settles in one move. |
| `--pct` on the sliders | options | fills the track behind the thumb: `el.style.setProperty('--pct', (v-min)/(max-min)*100 + '%')`. Without it: an unfilled rail, which looks intentional. |
| `#status[data-tone="ok"\|"error"]` | options | draws a checkmark and tints on save. Without it: a neutral status line. |
| `data-state="busy"\|"done"` | chart badge | the badge wears the panel's aperture while its chart is being read. |

**Speaking indicator markup** — drop into the status row or an action button:

```html
<span class="lucid-eq" data-state="speaking" aria-hidden="true">
  <i></i><i></i><i></i><i></i><i></i>
</span>
```

Set `data-state="paused"` and the bars freeze mid-stride and drop to a level
row, so paused is legible at a glance rather than just "stopped moving".

---

## The Reading Mode cursor

`ctx.highlight.highlightTextSlice()` creates a **new element per word**. Two
different elements cannot tween into each other, so at reading speed the marker
strobes rather than tracks.

`src/design/reading-cursor.ts` keeps **one** element alive and moves it, which
is what makes the highlight feel attached to the voice. It is self-contained,
imports nothing from the rest of the codebase, and is a drop-in:

```ts
import { createReadingCursor } from '../../design/reading-cursor.js';

const cursor = createReadingCursor();
ctx.tts.speak(text, {
  onBoundary: ({ charIndex, charLength }) => {
    const hit = map.locate(charIndex);
    if (hit) cursor.moveToSlice(hit.node, hit.offset, hit.offset + charLength);
  },
  onPause:  () => cursor.setPaused(true),
  onResume: () => cursor.setPaused(false),
  onEnd:    () => cursor.hide(),
});
```

Within a line it glides; at a line break it cuts, because easing a box
diagonally across a paragraph looks like a bug. It also scrolls the spoken word
back into view when it drifts out, and it carries `withHidden()` for screenshots.

Reading Mode works without it — `overlay.css` styles the plain per-word path so
it still looks deliberate. This is polish on the demo's centrepiece, offered,
not imposed.

---

## What was deliberately not done

- **No focus trapping and no interference with Escape.** The panel is a
  non-modal dialog on purpose; nothing here fights that.
- **No blend modes on the reading marker.** A blend mode that is right on a
  white page is wrong on a dark one, and `prefers-color-scheme` describes the
  user's OS, not the page. Every overlay mark carries a dual halo — a dark ring
  and a light ring — so one of them always separates it from the backdrop.
- **Nothing solid is painted over page text.** The word marker's solid element
  is a bar *below* the baseline; the lozenge over the word is a translucent
  wash, so the page's own text keeps the contrast the site gave it.
- **No looping attention cues on the chart badge.** A dozen badges pulsing
  turns a dashboard into a slot machine.

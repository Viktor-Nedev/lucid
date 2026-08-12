# Testing Lucid

Manual walkthrough for all seven behaviors. Everything here is done by hand in a real Chrome
window — there is no automated suite.

Read [README.md](README.md) first for build and install steps. The one that catches people out:
**Load unpacked must point at `dist/`**, and `dist/` only exists after `npm run build`.

---

## Before you start

```bash
npm install && npm run build     # produces dist/
npx serve demo                   # or: python -m http.server 8000 --directory demo
```

Load `dist/` at `chrome://extensions` with Developer mode on, then open
`http://localhost:3000/index.html` (adjust the port to whatever your server printed).

Use `http://localhost`, not a `file://` URL. Content scripts do not run on `file://` unless you
tick **Allow access to file URLs** on the extension's details page, and forgetting that produces a
silent no-op that looks exactly like a broken build.

After every rebuild, hit reload on the Lucid card in `chrome://extensions`. A stale content script
is the second most common way to waste ten minutes.

---

## 0. Cost control — run this first

Every AI-backed behavior costs money per invocation. Nothing should reach the network until the
user deliberately asks for it. Verify that before testing anything else, and re-verify it any time
the trigger logic changes.

1. Open `demo/index.html`.
2. Open DevTools → **Network**, filter to **Fetch/XHR**.
3. Clear the log.
4. Now use the page like an ordinary reader for about 30 seconds:
   - scroll from top to bottom,
   - hover over the lead chart and the treatment diagram,
   - click into and tab through all five fields in the signup form,
   - select a paragraph of text and leave it selected.

**Expected: zero outbound AI requests.** The page itself makes no network calls at all, so any
Fetch/XHR entry that appears is coming from Lucid and is a bug.

5. Press `Alt`+`R` on the selection. **Still zero** — speech synthesis is local and this behavior
   is specified to work with no API key.
6. Press `Alt`+`S` on the selection. **Exactly one** request should fire.
7. Press `Alt`+`S` again on the same unchanged selection. Note what happens: a second request
   means there is no caching, which is worth knowing before the demo but is not itself a failure.

If a request fires during step 4, stop and fix that before continuing. Idle-time or
hover-triggered calls will drain the key during the demo.

> Exact provider hostname to filter on: **TODO** — fill in once the provider is settled.

---

## The seven behaviors

Each one lists steps on `demo/index.html`, then public pages that stress it harder. The demo page
is controlled and predictable; the real-world URLs are where things actually break.

### 1. Read selection aloud — `Alt`+`R`

**On the demo page.** Select the opening paragraph under the headline ("Harbor Bay draws its water
from the Calder Reservoir…") and press `Alt`+`R`.

Expect speech to start within about a second and to read only the selected text, stopping at the
end of the selection. Then try: selecting across two paragraphs, selecting a single word,
selecting a table cell, and pressing `Alt`+`R` with nothing selected at all — the last should fail
quietly rather than reading the whole page.

This must work with no API key configured. Test it with the key removed.

**In the wild:**
- <https://en.wikipedia.org/wiki/General_relativity> — long paragraphs, inline math, footnote
  markers. Check whether superscript reference numbers get read out as noise mid-sentence.
- <https://www.law.cornell.edu/uscode/text/26/61> — nested statutory lists, heavy cross-references.

### 2. Describe a visual — `Alt`+`E`

**On the demo page.** There are two targets:

- **Figure 1**, the reservoir illustration. It is an `<img>` with no `alt` attribute, so a screen
  reader passes over it silently today.
- **Figure 2**, the treatment diagram. Inline SVG marked `role="presentation"`, so it is invisible
  to assistive tech even though it carries the whole process flow.

Put each in view and press `Alt`+`E`. Expect a spoken description of what is actually depicted —
for Figure 2 that means the sequence of treatment stages, not "a diagram with boxes and arrows".

**In the wild:**
- <https://www.chartjs.org/docs/latest/samples/bar/vertical.html> — a genuine Chart.js canvas.
- <https://ourworldindata.org/grapher/life-expectancy> — a large interactive SVG chart that
  redraws on interaction. Check whether a description captured before interaction goes stale.

### 3. Read the whole page — `Alt`+`P`

**On the demo page.** Press `Alt`+`P` at the top and let it run.

Expect reading in DOM order with each word highlighted as it is spoken. On this page DOM order and
visual order match deliberately, so the highlight should track down the page without jumping. Watch
the handoff into the sidebar and the footer, and check what it does with the data table — reading
thirty numbers with no column context is correct-but-useless, and worth noting if it happens.

Also confirm you can stop it. A read-aloud you cannot interrupt is worse than none.

**In the wild:**
- <https://en.wikipedia.org/wiki/General_relativity> — infoboxes and navboxes sit early in the DOM
  but late in the visual layout, so the highlight will jump. Watch how badly.

### 4. Simplify dense text — `Alt`+`S`

**On the demo page.** Under "Regulatory compliance" there are two paragraphs written to be
unreadable — a single 120-word sentence about ninetieth-percentile lead compliance, and a second
about primacy-agency determination deadlines. Select either and press `Alt`+`S`.

Expect a floating panel with a plain-language rewrite. Two things to check carefully:

- **The page must be unchanged underneath.** Scroll behind the panel and confirm the original text
  is still there, unedited. This is a hard requirement, not a nicety.
- **The meaning must survive.** The first paragraph's actual point is that exceeding 15 ppb in a
  single sample is not automatically a violation — it only counts if more than 10% of samples
  exceed it. A rewrite that loses that distinction is wrong in a way that matters.

**In the wild:**
- <https://arxiv.org/abs/1706.03762> — dense technical abstract.
- <https://www.law.cornell.edu/uscode/text/26/61> — statutory language with defined terms.

### 5. Chart trend narration — icon overlay

**On the demo page.** The lead concentration chart is a real `<canvas>`. Lucid should mark it with
a small icon; click that icon.

The data is deliberately shaped so a correct answer is recognisable. Monthly values are:

| Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep | Oct | Nov | Dec |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 3.1 | 3.4 | 3.0 | 4.2 | 9.8 | 14.6 | **16.2** | 11.4 | 6.3 | 4.1 | 3.6 | 3.2 |

A good narration says something close to: *flat around 3 ppb through the spring, climbs sharply
from May, peaks at 16.2 in July above the 15 ppb federal action level, then falls back to about 3
by December.* Specifically check that it **names the July peak and notes the action-level crossing**
— that is the entire story of the chart, and a description that just says "values vary over the
year" has failed.

The treatment diagram in Figure 2 should also pick up an overlay, since it is a complex SVG.

**In the wild:**
- <https://www.chartjs.org/docs/latest/samples/bar/vertical.html> — canvas, fixed data.
- <https://ourworldindata.org/grapher/life-expectancy> — SVG, multi-series, updates on interaction.

### 6. Unlabeled form fields

**On the demo page.** The "Get notified about your water" form has **five inputs and not one
`<label>` element, `aria-label`, or `placeholder` between them.** Confirmed via the accessibility
tree: all five expose an empty accessible name. Everything Lucid says here has to be inferred from
surrounding DOM.

Tab through them in order and check what is announced:

| # | Field | Inferable from | Expected |
|---|---|---|---|
| 1 | Full name | adjacent `<div>` caption | "full name" |
| 2 | Email address | caption plus hint text | "email address" |
| 3 | Service address | caption plus hint text | "the address your water is supplied to" |
| 4 | Account number | caption plus "ten digits, printed on your bill" | "account number, ten digits" |
| 5 | *(the narrow box below the grid)* | **nothing** — no caption, no hint, no placeholder | see below |

Field 5 is the honest stretch case. There is no adjacent text at all; the only signals are that it
sits directly under an address block and is styled narrow. "Apartment or unit number" is a good
answer. **"I can't determine what this field is for" is also a good answer** — a confident wrong
guess on a form field is worse than an admission, and that trade-off is worth watching on camera.

Then test the error path. Type something that is not an address into field 3 and submit. The page
shows exactly this and nothing else:

```
E_ADDR_FMT: value failed pattern validation
```

Expect Lucid to turn that into something actionable — that the address was not recognised, and
that it wants a house number followed by a street name. Restating the error code aloud is a fail.

**In the wild:**
- <https://www.w3.org/WAI/demos/bad/before/home.html> — the W3C's own deliberately-inaccessible
  demo site. Purpose-built, public, and genuinely full of unlabeled controls.

### 7. Voice commands

**On the demo page.** Press the wake hotkey, then say "read this", "explain this", "simplify this"
with something selected or in view.

> Wake hotkey: **TODO** — not yet assigned. Fill in once it is.

Worth checking: what happens when the mic permission has not been granted yet, when it is denied,
and when a command is not recognised. Also confirm the mic is not listening before the wake hotkey
is pressed — that is a privacy claim the demo will need to make.

---

## Narrower fixtures

`demo/fixtures/` holds three smaller pages for cases the main demo page does not cover. These are
for manual testing only; they are not in the video.

**`shop.html`** — a product grid. Four product images ranging from no `alt` at all to unhelpful
`alt="image123.jpg"`, an unlabeled search box, "Add to cart" controls built from `<div>`s that
cannot be reached by keyboard, and prices at roughly 1.9:1 contrast. Good for `Alt`+`E` across
several images in a row, and for behavior 6 on a single isolated input.

**`signup-form.html`** — the awkward form cases. Placeholder-only labels, a `<label for>` pointing
at an id that does not exist, a checkbox made from a `<span>` with no keyboard handling, and
positive `tabindex` values that scramble focus order. The scrambled tab order is the interesting
one: behavior 6 fires on tab, so this checks that announcements follow actual focus rather than
DOM position.

**`dashboard.html`** — widgets and data. A canvas chart, a table where every cell is a `<td>` with
no headers at all, tab and modal widgets built from bare `<div>`s, and a ticker that rewrites
itself every three seconds. The ticker is the one to watch: check it does not retrigger
description or narration on every update.

---

## Quick regression pass

Before recording or demoing, run this end to end on `demo/index.html`:

- [ ] Zero AI requests on idle (section 0)
- [ ] `Alt`+`R` reads a selection, with the API key removed
- [ ] `Alt`+`E` describes Figure 1 and Figure 2
- [ ] `Alt`+`P` reads in order, highlight tracks, and can be stopped
- [ ] `Alt`+`S` rewrites a compliance paragraph, page unmodified underneath
- [ ] Chart overlay names the July peak and the action-level crossing
- [ ] All five form fields announce something sensible on tab
- [ ] `E_ADDR_FMT` becomes plain language
- [ ] Voice: wake, "simplify this", correct panel appears
- [ ] Reload the extension, reload the page, confirm it all still works cold

## Feature status

**TODO** — filled in at integration time, once features land.

| Behavior | Status | Notes |
|---|---|---|
| 1. `Alt`+`R` read selection | _TODO_ | |
| 2. `Alt`+`E` describe visual | _TODO_ | |
| 3. `Alt`+`P` read page | _TODO_ | |
| 4. `Alt`+`S` simplify | _TODO_ | |
| 5. Chart trend narration | _TODO_ | |
| 6. Unlabeled field help | _TODO_ | |
| 7. Voice commands | _TODO_ | |

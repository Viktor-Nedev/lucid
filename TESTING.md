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

> ### ⚠️ `http://localhost`, never `file://`
>
> Chrome does not run content scripts on `file://` URLs unless you tick **Allow access to file
> URLs** on the extension's details page. Forget that and every single behavior below fails
> silently — no panel, no speech, no console error. It looks exactly like a broken build, and it
> is the first thing to check if nothing at all appears to work.
>
> If you must use `file://`, tick the box first and reload the extension.

> ### ⚠️ Lucid does not run inside iframes
>
> The content script is registered `all_frames: false`, so only the top-level document is in
> scope. Anything inside an iframe — an embedded CodePen, an iframed dashboard, a third-party
> chart widget — is invisible to Lucid and pressing a hotkey over it does nothing.
>
> This is a known scope boundary, not a bug. Before filing anything as broken, check in DevTools
> whether the element you are pointing at actually lives in an iframe. Some of the public URLs
> below may embed their charts this way; if one does, that is the limitation showing, not a
> failure.

After every rebuild, hit reload on the Lucid card in `chrome://extensions`. A stale content script
is the second most common way to waste ten minutes.

---

## 0. Cost control — run this first

Every AI-backed behavior costs money per invocation. Nothing should reach the network until the
user deliberately asks for it. Verify that before testing anything else, and re-verify it any time
the trigger logic changes.

1. Open `demo/index.html`.
2. Open DevTools → **Network**, filter to **Fetch/XHR**, then narrow to the AI hosts:

   ```
   generativelanguage.googleapis.com     Gemini
   api.anthropic.com                     Claude
   ```

   Watch both. Lucid can be pointed at either provider, and a request to the one you are not
   filtering on is still a request you are paying for.
3. Clear the log.
4. Use the page passively for about 30 seconds, without invoking anything:
   - scroll from top to bottom,
   - hover over the lead chart and the treatment diagram,
   - select a paragraph of text and leave it selected,
   - then stop touching it and let it sit idle.

**Expected: zero outbound AI requests.** The page itself makes no network calls at all, so any
Fetch/XHR entry that appears here is coming from Lucid and is a bug. If one fires, stop and fix
that before continuing — idle-time and hover-triggered calls will drain the key during the demo.

5. Now trigger the form explanation on the signup form and watch the count.

   Field inference **is** AI-backed — it routes through `ai.inferFieldPurpose` to the provider.
   But the contract batches it: one call carries every field on the form and the response comes
   back correlated by id, with an optional cache key. So expect **roughly one request per form on
   a cache miss, and zero on a hit** — not one request per field.

   Confirm that. A build that fires per-field instead of per-form turns a twelve-field checkout
   into twelve calls, and that is the failure mode worth catching before anyone demos it live.

6. Press `Alt`+`Shift`+`R` on the selection. **Still zero** — speech synthesis is local and read
   selection is specified to work with no API key at all.
7. Press `Alt`+`Shift`+`L` for reading mode, then stop it. **Still zero**, for the same reason.
8. Press `Alt`+`Shift`+`S` on the selection. **Exactly one** request should fire.
9. Press `Alt`+`Shift`+`S` again on the same unchanged selection. Note what happens: a second
   request means there is no caching, which is worth knowing before the demo but is not itself a
   failure.

> Anything reaching either host is billable. If you see traffic to a host that is on neither
> list, find out what it is before demoing.

---

## The seven behaviors

Each one lists steps on `demo/index.html`, then public pages that stress it harder. The demo page
is controlled and predictable; the real-world URLs are where things actually break.

### 1. Read selection aloud — `Alt`+`Shift`+`R`

**On the demo page.** Select the opening paragraph under the headline ("Harbor Bay draws its water
from the Calder Reservoir…") and press `Alt`+`Shift`+`R`.

Expect speech to start within about a second and to read only the selected text, stopping at the
end of the selection. Then try: selecting across two paragraphs, selecting a single word,
selecting a table cell, and pressing `Alt`+`Shift`+`R` with nothing selected at all — the last should fail
quietly rather than reading the whole page.

This must work with no API key configured. Test it with the key removed — read selection and
reading mode are both specified to work in full without one.

**In the wild:**
- <https://en.wikipedia.org/wiki/General_relativity> — long paragraphs, inline math, footnote
  markers. Check whether superscript reference numbers get read out as noise mid-sentence.
- <https://www.law.cornell.edu/uscode/text/26/61> — nested statutory lists, heavy cross-references.

### 2. Describe a visual — `Alt`+`Shift`+`E`

**On the demo page.** There are two targets:

- **Figure 1**, the reservoir illustration. It is an `<img>` with no `alt` attribute, so a screen
  reader passes over it silently today.
- **Figure 2**, the treatment diagram. Inline SVG marked `role="presentation"`, so it is invisible
  to assistive tech even though it carries the whole process flow.

Put each in view and press `Alt`+`Shift`+`E`. Expect a spoken description of what is actually depicted —
for Figure 2 that means the sequence of treatment stages, not "a diagram with boxes and arrows".

**In the wild:**
- <https://www.chartjs.org/docs/latest/samples/bar/vertical.html> — a genuine Chart.js canvas.
- <https://ourworldindata.org/grapher/life-expectancy> — a large interactive SVG chart that
  redraws on interaction. Check whether a description captured before interaction goes stale.

### 3. Reading mode — `Alt`+`Shift`+`L`

**On the demo page.** Press `Alt`+`Shift`+`L` at the top and let it run.

Expect reading in DOM order with each word highlighted as it is spoken. On this page DOM order and
visual order match deliberately, so the highlight should track down the page without jumping. Watch
the handoff into the sidebar and the footer, and check what it does with the data table — reading
thirty numbers with no column context is correct-but-useless, and worth noting if it happens.

Also confirm you can stop it. A read-aloud you cannot interrupt is worse than none.

**In the wild:**
- <https://en.wikipedia.org/wiki/General_relativity> — infoboxes and navboxes sit early in the DOM
  but late in the visual layout, so the highlight will jump. Watch how badly.

### 4. Simplify dense text — `Alt`+`Shift`+`S`

**On the demo page.** Under "Regulatory compliance" there are two paragraphs written to be
unreadable — a single 120-word sentence about ninetieth-percentile lead compliance, and a second
about primacy-agency determination deadlines. Select either and press `Alt`+`Shift`+`S`.

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

The trigger is still being wired up, so check how it actually fires in your build — the landed
contract scans a whole form at once and presents the results together, which may or may not end up
driven by tab. Either way, these are the inferences to check:

| # | Field | Inferable from | Expected |
|---|---|---|---|
| 1 | Full name | adjacent `<div>` caption | "full name" |
| 2 | Email address | caption plus hint text | "email address" |
| 3 | Service address | caption plus hint text | "the address your water is supplied to" |
| 4 | Account number | caption plus "ten digits, printed on your bill" | "account number, ten digits" |
| 5 | *(the narrow box below the grid)* | **nothing** — no caption, no hint, no placeholder | see below |

**Check the request payload while you are here.** Open the request in DevTools and confirm it
carries field *metadata* only — labels, names, types, nearby text. If the value a user has typed
into a field appears anywhere in the body, stop and report it: a form-explaining feature that
transmits a half-typed card number is worse than no feature at all.

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

**On the demo page.** Wake Lucid, then say "read this", "explain this", "simplify this" with
something selected or in view.

Voice wake has **no default key**, and neither does the panel toggle. Chrome honours only four
suggested shortcuts per extension and Lucid spends all four on the behaviors above, so both are
reached from the toolbar button or from a key you bind yourself at
`chrome://extensions/shortcuts`. Test both routes.

Worth checking: what happens when the mic permission has not been granted yet, when it is denied,
and when a command is not recognised. Also confirm the mic is not listening before the wake hotkey
is pressed — that is a privacy claim the demo will need to make.

---

## Narrower fixtures

`demo/fixtures/` holds three smaller pages for cases the main demo page does not cover. These are
for manual testing only; they are not in the video.

**`shop.html`** — a product grid. Four product images ranging from no `alt` at all to unhelpful
`alt="image123.jpg"`, an unlabeled search box, "Add to cart" controls built from `<div>`s that
cannot be reached by keyboard, and prices at roughly 1.9:1 contrast. Good for `Alt`+`Shift`+`E` across
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
- [ ] With no API key at all: read selection and reading mode still work in full
- [ ] `Alt`+`Shift`+`E` describes Figure 1 and Figure 2
- [ ] `Alt`+`Shift`+`L` reads in order, highlight tracks, and can be stopped
- [ ] `Alt`+`Shift`+`S` rewrites a compliance paragraph, page unmodified underneath
- [ ] Chart overlay names the July peak and the action-level crossing
- [ ] All five form fields announce something sensible on tab
- [ ] `E_ADDR_FMT` becomes plain language
- [ ] Voice: wake, "simplify this", correct panel appears
- [ ] Reload the extension, reload the page, confirm it all still works cold

## Feature status

Kept in one place only, to stop the two files drifting apart:
see [Feature status in README.md](README.md#feature-status).

At the time of writing, reading mode and voice are still stubs — expect those two sections above
to fail until they land.

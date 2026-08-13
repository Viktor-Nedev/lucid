# Demo video plan

Shot list and narration for the Lucid demo. Presenter-driven and live: a human clicks and presses
hotkeys on camera.

**Runtime: about 3 minutes.** Every beat runs on `demo/index.html` — a fictional water utility's
annual report. Nothing is staged in a devtools console and nothing is faked.

> The narration below is written to be read aloud. Short sentences, no clauses to get lost in.
> Say the numbers; they are what make it credible.

---

## Pre-flight checklist

Do all of this **before** you start recording. Most of it cannot be fixed mid-take.

**Build and load**

- [ ] `npm install && npm run build`
- [ ] `chrome://extensions` → Developer mode on → **Load unpacked** → select **`dist/`**, not the
      repo root. `dist/` is gitignored and only exists after a build.
- [ ] After any rebuild, hit reload on the Lucid card.

**Serve the demo page**

- [ ] `npx serve demo` (or `python -m http.server 8000 --directory demo`)
- [ ] Open it as `http://localhost:…`, **never** as a `file://` URL. Chrome does not run content
      scripts on `file://` unless you tick "Allow access to file URLs", and if you forget, every
      single beat fails silently — no panel, no speech, no console error. It looks exactly like a
      totally broken extension.

**Configure**

- [ ] Set an API key in the extension options.
- [ ] Set the speech rate. Default is slower than you want on camera; nudge it up until it sounds
      brisk but still intelligible, then leave it alone.
- [ ] Check your output device and record a five-second test. Lucid's whole demo is audio — if the
      capture misses system audio you have nothing.

**Pre-warm the cache — this is the one people skip**

- [ ] Run beats 4, 5, 6 and 7 once, exactly as scripted, so every AI response is cached.
- [ ] Then re-run them and confirm the second pass returns instantly.

Pre-warming does two things: it removes the dead air while a model streams, and it makes the demo
survive a bad network or a rate limit on the day. If the venue wifi collapses mid-take, a warmed
cache means the demo still runs.

**Final sweep**

- [ ] Close other tabs. Hide bookmarks. Clear notifications.
- [ ] Reload the page cold once and confirm the hotkey strip is visible at the top.
- [ ] Confirm the browser zoom is 100%.

---

## Timing

| # | Beat | Length | AI? |
|---|---|---|---|
| 1 | The problem | 0:20 | no |
| 2 | Read selection | 0:15 | no |
| 3 | Reading mode | 0:20 | no |
| 4 | Explain a visual | 0:25 | **yes** |
| 5 | Chart narration | 0:25 | **yes** |
| 6 | Simplify | 0:25 | **yes** |
| 7 | Form Guardian | 0:30 | **yes** |
| 8 | Close | 0:20 | no |

---

## 1 — The problem · 0:20 · no AI

**On screen.** `demo/index.html`, scrolled slowly from the top. Let the chart, the diagram and the
signup form each pass through frame.

**Keys.** None.

**Say:**

> This is a water quality report. A real one, near enough — this is the letter that tells you
> whether there is lead in your water.
>
> If you are blind, most of this page does not exist. The chart is a canvas, so a screen reader
> reads nothing. The diagram is decorative markup, so it reads nothing. The form has five inputs
> and not one label. And the part that actually matters — your appeal rights — is a single
> hundred-and-twenty-word sentence.
>
> Lucid is for the person trying to read this page right now.

---

## 2 — Read selection · 0:15 · no AI

**On screen.** Select the opening paragraph, "Harbor Bay draws its water from the Calder
Reservoir…".

**Keys.** `Alt`+`Shift`+`R`

**Say:**

> Select anything. One key. It reads it back.
>
> No API key needed for this — speech synthesis is local to the browser. Install Lucid with
> nothing configured and this already works.

---

## 3 — Reading mode · 0:20 · no AI

**On screen.** Scroll back to the top. Trigger reading mode and let the highlight run through a
couple of paragraphs so the word-level sync is unmistakable. Stop it deliberately on camera.

**Keys.** `Alt`+`Shift`+`L`

**Say:**

> Reading mode takes the whole page in order, and highlights each word as it says it.
>
> That sync is the point. If you are dyslexic, following text you are hearing is the hard part.
> And you can stop it whenever you want — a voice you cannot interrupt is worse than no voice.
>
> Still no API key.

---

## 4 — Explain a visual · 0:25 · **AI**

**On screen.** Scroll to Figure 2, the treatment diagram. Trigger explain. Let the description
stream in and be spoken.

**Keys.** `Alt`+`Shift`+`E`

**Say:**

> This diagram carries the whole treatment process. To a screen reader it is decorative — it is
> skipped in silence.
>
> Lucid captures the region, describes it, and speaks it. Not "a diagram with boxes and arrows" —
> the actual sequence. Intake, screening, coagulation, settling, filtration, disinfection, and
> then corrosion control, which is the stage that matters on this page.

**If it fails:**

> That one is live against the model, so it is the one that can stall. The description is cached
> from earlier — here it is. [Show the cached result, or move to beat 5 and come back.]

---

## 5 — Chart narration · 0:25 · **AI**

**On screen.** Scroll to the lead chart. Lucid marks it with a badge — point at the badge, then
click it.

**Keys.** Click the chart badge.

**Say:**

> Lucid finds charts without knowing what drew them. No Chart.js hook, no library integration —
> it works on a canvas that was drawn by hand, like this one.
>
> And it does not tell you a chart is there. It tells you what the chart says.

*(let it speak, then:)*

> Flat around three parts per billion through the spring. Climbs from May. Peaks at sixteen point
> two in July — over the federal action level of fifteen. Then back down to three by December,
> after they changed the corrosion treatment in August.
>
> That is the entire story of this report, and until now it was locked inside an image.

**If it fails:**

> Cached from the pre-flight run — same result. [Replay the cached narration.]

---

## 6 — Simplify · 0:25 · **AI**

**On screen.** Scroll to "Regulatory compliance". Select the first paragraph — the
ninetieth-percentile one. Trigger simplify. The panel opens over the page.

**Keys.** `Alt`+`Shift`+`S`

**Say:**

> This paragraph is one sentence, a hundred and twenty words, and it decides whether your water
> counts as compliant.

*(after the rewrite appears:)*

> And in plain language: going over fifteen parts per billion in one sample is not automatically a
> violation. It only counts if more than one in ten samples goes over.
>
> That distinction is the whole paragraph, and almost nobody gets it from the original.

**Then scroll the panel aside and show the page underneath, untouched:**

> The page itself is never modified. Lucid puts the plain version beside the original — it does not
> rewrite what the utility actually published.

**If it fails:**

> Cached — here is the rewrite. [Show cached panel.] The important line is the one-in-ten rule.

---

## 7 — Form Guardian · 0:30 · **AI**

**On screen.** Scroll to "Get notified about your water". Tab through the fields. Then trigger the
form explanation and let it walk them.

**Keys.** `Tab` through the inputs, then trigger form explanation.

**Say:**

> Five inputs. Not one label between them — I checked the accessibility tree, every one of them
> has an empty name. A screen reader announces "edit text, edit text, edit text".
>
> Lucid reads the page around each field and works out what it is asking for. Full name. Email.
> Service address. Account number.
>
> And this narrow one, with nothing next to it at all — it works that out from the fact that it
> sits beside an address.

**Then submit with a bad address to fire the error:**

> Now the error the site actually gives you.

*(show `E_ADDR_FMT: value failed pattern validation`)*

> That is what a real form tells a blind user. Lucid turns it into: the address was not
> recognised, it needs a house number and a street name.

**Privacy line — say this one carefully, it is the question judges ask:**

> One thing about this feature. It sends field *metadata* only — labels, names, types, the text
> near the control. It never sends what you typed. We canary-tested that: put a marked value in a
> field, capture the request, and the value is not in it.

**If it fails:**

> Cached from pre-flight. [Show cached field explanations.] The line that matters is that it reads
> the form's structure, never its contents.

---

## 8 — Close · 0:20 · no AI

**On screen.** DevTools Network panel open on a freshly loaded page, showing an empty request list.
Then back to the page.

**Say:**

> Two things we care about.
>
> Cost. Lucid makes zero AI calls until you press a key. Load the page, scroll it, hover the
> chart, tab the form — nothing goes out. It costs you nothing to have it installed.
>
> And it degrades gracefully. Pull the API key entirely and read-aloud and reading mode still work
> in full, because speech synthesis is local. It never becomes a broken extension.

**Then the build story:**

> Lucid was built in two days by parallel agent workers — one per feature, running at the same
> time in separate worktrees, coordinated by an orchestrator.
>
> That only works because the message contract was frozen first. Every worker got a stub with its
> route already defined and one instruction: fill this file in, touch nothing else. Seven features
> landed on main without stepping on each other.

---

## Fallback summary

Beats 2, 3 and 8 are local and will not fail for network reasons. Beats 4, 5, 6 and 7 are live
against a model.

If any AI beat stalls for more than about three seconds:

1. Say the fallback line for that beat.
2. Show the cached result from the pre-flight run.
3. Move on. Do not retry on camera — a second stall is much worse than the first.

If the network is gone entirely, the pre-warmed cache carries beats 4 through 7. If the cache is
also cold, cut to beats 2, 3 and 8 and say plainly that the AI features need connectivity — the
graceful-degradation story is a genuinely good answer to that, not a save.

**If nothing at all responds**, check in this order: is the page on `http://localhost` rather than
`file://`; was the extension reloaded after the last build; is the thing you are pointing at inside
an iframe (Lucid runs `all_frames: false` and does not enter them).

---

## Notes for whoever records this

- Let the speech finish. The instinct is to talk over it; the audio is the product.
- Pause after each hotkey. The gap before the voice starts reads as responsiveness, not lag.
- Say the numbers out loud — 16.2, 15, one in ten. Specifics are what make it land.
- Do not apologise for the fictional utility. Nobody cares, and drawing attention to it costs you
  credibility you do not need to spend.

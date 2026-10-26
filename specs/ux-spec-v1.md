# UI/UX Specification — V1

**Scope:** intake → validated profile → mode decision → diagnosis report, plus the approval and notification patterns that later phases inherit.
**Companion:** `intake-mockup.html` is a working prototype of the signature screen described in §4.

---

## 1. The design problem

This product asks a small-business owner to hand over control of the thing that pays their rent. Everything else follows from that.

The interface is not competing for attention or trying to feel exciting. It is trying to make a stressed, non-technical person believe that something careful is paying attention to their business — and to keep them in control while it does. Delight is not the goal; **legibility of intent** is. At any moment the owner should be able to answer three questions without asking: what does it know, what is it about to do, and what will happen if I say no.

That produces one governing rule the whole system obeys:

> **Colour is reserved for decisions.** Nothing in the interface is coloured unless the owner needs to act on it or reconcile it. Everything the system merely knows or has done is rendered in ink and grey.

This is a real constraint, not a stylistic preference. In a product that will eventually surface dozens of proposals, an interface where colour means "your turn" is scannable in a second. An interface where colour means "we thought this was important" trains people to ignore it.

---

## 2. Design tokens

**The sheet system (adopted 2026-10-17, owner decision).** A diagnostic panel / lab report: content lives on eucalyptus paper sheets laid on a dark forest desk. It supersedes Ember Grid. The tokens live in `app/sheet.css`; this section is their source of truth. **Every screen is on it** (2026-10-17): the landing page, sign-in, the intake, every owner screen, the operator panel and the support widget. The old class names in `app/globals.css` still work, but their tokens now point at the sheet system: the page is the desk, cards/chips/report/fact sheet are paper, and `--ink` is redefined per surface. Screen-specific grammar (the report's number grammar, the queue's decision flow, the intake's progress) lands surface by surface on top of that.

### Surfaces

| Token | Value | Use |
|---|---|---|
| `--desk` | `#132119` | The background: the receding navigation layer |
| `--masthead` | `#0E1A13` | Ink masthead, with a 2px `--live-rule` (`#3D6BFF`) beneath. The rule is static brand structure, not machine state |
| `--paper` | `#F2F7F4` | The sheet. Content lives here |
| `--inset` | `#DFE9E3` | Evidence boxes and stamps. Only 1.15:1 against paper, so every inset also carries a 1px `--rule` |
| `--rule` / `--rule-soft` | `#71897D` / `#B9CBC1` | 1px rules: structural (3.5:1 on paper) and row hairlines |

Square corners everywhere. No shadows on sheets: separation comes from 1px rules, surface colour and whitespace. No icons: meaning is carried by words, typography, rules and position. Typographic characters such as → are allowed.

### Text and meaning

Every text token is measured on each surface it appears on (WCAG 2 ratio, APCA Lc). Smallest mono labels target Lc 75+.

| Token | Value | On paper | On inset | On desk | Use |
|---|---|---|---|---|---|
| `--sheet-ink` | `#0E1A13` | 16.5:1 · Lc 99 | 14.4:1 · Lc 90 | — | Text on sheets |
| `--sheet-ink-2` | `#3A4C42` | 8.5:1 · Lc 86 | 7.4:1 · Lc 77 | — | Secondary text on sheets |
| `--desk-ink` | `#EAF2ED` | — | — | 14.6:1 · Lc 96 | Text on the desk |
| `--desk-ink-2` | `#C3D4CA` | — | — | 10.8:1 · Lc 76 | Secondary text on the desk. Never a muted grey |
| `--live` | `#1A3DAE` | 8.4:1 · Lc 84 | 7.3:1 · Lc 75 | — | Cobalt: the machine is working right now. Nothing else |
| `--live-desk` | `#C2D4FF` | — | — | 11.2:1 · Lc 79 | The same meaning, on the desk |
| `--ok` | `#145530` | 8.2:1 · Lc 84 | 7.1:1 · Lc 75 | — | Tints IN RANGE |
| `--low` | `#36495F` | 8.5:1 · Lc 86 | 7.4:1 · Lc 77 | — | Tints BELOW RANGE and idle |
| `--drift` | `#683D00` | 8.6:1 · Lc 86 | 7.5:1 · Lc 77 | — | Tints ABOVE RANGE (slightly past) |
| `--alarm` | `#8C1713` | 8.6:1 · Lc 84 | 7.5:1 · Lc 76 | — | Tints ACT NOW. Also underlined, so alarm differs from drift in shape, not only hue |
| `--marker` | `#F7E26B` | — | — | — | Ink was just laid down. Only ever a background behind ink (13.7:1), **never text** |

Colour never carries meaning alone: every status is a worded flag, and the screen must read in grayscale.

**Cobalt is machine state only.** Interactive elements are ink on paper: a full 1px border, a verb label with a typographic arrow ("APPROVE →"), underlined links, an ink-fill inversion on hover and press within 100ms, and a 2px focus ring in the ink of the surface underneath, offset 3px. Never cobalt, never a pill, and at least 48px tall.

### Type

| Role | Face | Use |
|---|---|---|
| Display | Zilla Slab 500–600 | One primary figure or heading per sheet. Never chrome |
| Prose | Archivo | All reading text, 45–90 characters per line (`--measure: 68ch`) |
| Figures and labels | IBM Plex Mono 400–600 | Every figure and every label. Tabular numerals on the figure itself, right-aligned in columns |

The mono layer still encodes something true: every fact prints its source, date and basis as visible text, never behind a click. Caps are reserved for mono labels and flags. Scale: display 64/40/26px, prose 19/16/14px, mono 14/12.5/11.5px. Nothing below 11.5px.

### The number grammar

Every number on every surface follows one grammar, the way a lab result does:

- The value in mono, tabular, right-aligned.
- A named comparison in the column header ("vs prior 28 d"). Never a bare number.
- A reference or goal range where one exists. The owner's own targets may serve.
- A worded flag: IN RANGE / BELOW RANGE / ABOVE RANGE / ACT NOW / NOT PROVIDED.
- For findings, a text-width range bar (`components/sheet/RangeBar.tsx`): the ok band as a tint, the value as an ink tick, and a dashed hairline where drift becomes ACT NOW.
- Forecasts are ranges, never single points.
- Basis is a named class defined by what produced the fact: OBSERVED / DERIVED / ESTIMATED / ASSUMED. Never an AI-generated percentage.
- Money is integer minor units formatted by the currency's exponent (`components/sheet/num.ts`). One column, one decimal count. A space separates number and unit; the unit sits in the column header rather than in every cell.

### Space and motion

Space follows a scale (4, 8, 12, 16, 24, 32, 48, 64, 96px), not a constant. Gutters are 16px under 720px and 32px above.

Motion reports state, and is subtler the more often it plays: 100ms press, 220ms move, 280ms record, decelerating (`cubic-bezier(.16,1,.3,1)`).

- **Kept:** answers flying into the record column.
- **Allowed:** a cobalt pulse only while the AI is genuinely working.
- **Cut:** smooth or inertial scroll, scroll-jacking, cursor tilt, magnetic buttons, ambient drift, decorative loops, confetti, and padded "loading" sequences.
- **Text reveals:** at most one marketing headline, masked as a single text node.
- **Reduced motion:** under `prefers-reduced-motion` every duration is zero.

### 2.1 Charts — the business read like a stock (2026-10-25)

The landing's candlestick idea, built on the business's own measured data (`components/charts/`, `lib/charts/`, `app/charts.css`). The landing chart (`components/marketing/StoreChart.tsx`) stays fictional and scoped to `.ll`; nothing here reuses it.

**The market chart** (`MarketChart.tsx`) sits on the fact sheet (`/profile`), the first screen after sign-in, between the page head and the record. Its head names it ("Your salon, read like a stock", the noun from `lib/core/business-noun`) and states the opportunity cost as a range from real data: "About €1,180–€1,950 a month is slipping away — mostly no-shows." It draws:

- **Candles** from one source's daily money series (never a sum across two sources, business-wide rows only, one currency). In a week or month bucket, open is the first measured day, close the last, high and low the best and worst day. A one-day bucket opens at the previous measured day's value, since one figure has no body. A closed day prints no candle, the way a market holiday doesn't: nothing taken and nothing sold or booked, both measured. The readout counts closed days. The 1D / 1W / 1M switch is a group of pressed-state buttons. The period it opens on is the profile row's.
- **A volume pane** for orders, appointments or visits per bucket.
- **The overlay.** What slipped each day is drawn above the close as a two-step band: the low end of the range solid, the rest lighter, both tints of `--drift`. A dotted `--drift` line on top is "what you'd have kept". Its unit is money a day, like the candle's, so a week sits above its close by the week's average slip per trading day. Ad spend that didn't pay back is counted in the month but never drawn on revenue candles. The waiting proposals' monthly range ("on the table", ESTIMATED) is a dashed `--ok-band` band ahead of today, above the recent average day.
- **Event markers**, each shown by shape and keyed by number in words below the chart. A hollow square marks something detected (an anomaly row), a filled square something the owner approved, and a dashed hairline the day the drawn source came in. Same-day events of one kind fold into one marker.
- **A mono crosshair readout** (O H L C, volume, closed days, slipped per component with DERIVED, kept), driven by pointer or keyboard (← / →, Home / End, Esc).
- **A table of every component**, visible rather than behind a hover. Each shows its figure a month (or "tied up now" for stock), its basis word, and its arithmetic with real numbers. An absent component says what would fill it. Stock and forecast rows sit apart under "Not added to the month".

**Rules.** Plain SVG, with no chart library. Sheet tokens only, with no new colour. Up is a **filled** body and down a **hollow** one, so direction reads in grayscale and the `--ok` / `--alarm` tint only repeats it. No cobalt, because nothing here is the machine working. Square corners, no shadows, no icons. The SVG is drawn at its container's pixel width (one unit = one CSS pixel), so text stays at 11.5 px from a phone to a desk. Under 560 px it draws fewer buckets (30 days / 13 weeks / 6 months) and hides the volume pane. There is no horizontal page scroll. The text alternative is the summary sentence as the figure's accessible name, plus a visually-hidden table of every plotted value. There are no animations, so reduced motion holds.

**Opportunity cost** (`lib/charts/opportunity.ts`). Each part is computed deterministically, with its basis word, `derived_from` and formula. Each is an ordered range in integer minor units with one currency. Where nothing estimated enters, low = high and one figure prints. Flows are read over 90 days ending on the latest measured day (ads over the pause rule's 14) and scaled to 30 days.

- *Revenue dips* are DERIVED from the anomaly detector's own baseline, on days in a run of 2+ beyond its range. The high end is expected − actual. The low end also leaves out one usual variation. Whatever that day's no-shows, late cancellations and empty slots already price is taken off.
- *No-shows* and *late cancellations* are DERIVED: the count × the measured average booking price. The price ranges from the lowest to the highest weekly average.
- *Empty slots* are DERIVED, only from a capacity the owner STATED or ESTIMATED; otherwise the line is absent and says it won't assume one. The arithmetic is (capacity × measured days ÷ 7 − appointments still held) × the price range, spread over open days.
- *Ads that lose money* are DERIVED from Meta's own attribution: spend − attributed value on campaigns with a return below 1.0.
- *Cash in slow stock* is OBSERVED, or DERIVED where a stated cost stands in. It is a stock, never added to the month.
- *On the table* is ESTIMATED: the waiting proposals' base case to upside case.

A missing input is never filled with an industry number, and two currencies are never added.

**Personalised as data** (`lib/charts/profiles.ts`). Every bank `business_type` code maps to an archetype: shop, hospitality, appointments, services or default ("other" and unknown codes). Each archetype names its price candidates in order (the first with 14+ measured days is drawn), its volume and the word for it, its components in order, the period it opens on, and what to connect when nothing is measured. `sells_type` refines only the default row. A business with no data sees the empty state: "Import your bookings export or connect Square, and I'll draw this.", a link to Connections, and every component's reason.

**Smaller charts**, each drawn only where it tells a data story:

- *Bookings, week by week*, on `/profile` beneath the market chart. Completed appointments are filled, no-shows hollow and late cancellations tinted, stacked. A separate pane on its own axis shows what the missed slots were worth (never a dual axis).
- *Ads, the last 14 days*, on `/profile`. Each campaign shows spend as a hollow bar against Meta's attributed value as a filled bar on one scale, with LOSING / PAYS BACK flags.
- *Slow stock, count by count*, on `/stock`. Each item's value at cost on each stock count is joined into a line, never summed across days. It is drawn only with two counts or more.

The Goals screen already carries its own weekly candles against the path (`components/care/CandleChart.tsx`), so no second chart is added there. The diagnosis report has no priced money-leak column yet ("Money a month is printed only where a measure's gap is priced; none is"), and it is a dated snapshot, so a live chart beside it would contradict its date. No chart is added there.

---

## 3. Screen inventory

| Screen | Purpose | Phase |
|---|---|---|
| Intake | Build the profile, one question at a time | v1 |
| Reconcile | Resolve a contradiction between two answers | v1 |
| Mode decision | Explain instant vs watching, and why | v1 |
| Watching status | Show what's being observed and when it ends | v1 |
| Diagnosis report | The first real deliverable | v1 |
| Profile | Everything known, editable, with sources | v1 |
| Approval queue | Decide on proposals | v2, patterned here |
| Module pages | Marketing, finance, support detail | v3+ |
| Campaign simulator | Compare 2–4 campaign options' likely ranges before anything is spent | v3 (feature 36) |
| What-if pricing | What a price change can lose and still pay, beside its range of outcomes | v3 (idea 43) |

Navigation follows the owner's menu design (2026-10-17, `components/nav/AppFrame.tsx`). It is a 248px ink rail with:
- the wordmark, the business name and the live state ("WATCHING · DAY 19 / 28") over a cobalt rule;
- five labelled groups (To approve, Insights, Grow, Customers, Your business) that list every screen;
- a mono count beside each item where a real count exists (`/api/nav`);
- "Ask me anything →" at the foot.

There are no icons and no section tabs. Under 900px the rail folds into a top bar with a Menu button.

**Campaign simulator** (`/simulate`, under Grow; feature 36). It lives on its own screen rather than in "Waiting for you" or on Customers: it compares email, ad and content options before any proposal exists, and the queue is a focused view for deciding, not for exploring. The owner picks two to four options in a ruled picker; a `.rt` table puts measures in rows (what it costs, people it reaches, orders, expected revenue, expected profit, worst case) and options in columns, each cell "low – high" in mono with the basis words of what it rests on, or a worded MISSING / NOT READ flag — a gap is never a number. A plain-SVG whisker per option shows expected profit against zero, the worst case as a square. Under it, each option shows its chain: every input with its value, basis and source (missing ones say what would fill them), the projection's own ASSUMED line, the arithmetic per measure, the worst case in words, and what the trust layer can say about similar past proposals. "Propose this" makes the normal proposal for its kind with the simulation attached; nothing executes. Money prints in whole major units, one decimal count throughout.

**What-if pricing** (`/simulate?tab=pricing`; idea 43). The simulator's second half, one of two plain links under the page head ("Campaigns", "What-if pricing"), so each half has its own address. The owner picks one product or service in a ruled picker (a booking business's services come from its own last 28 days of appointments) and up to four price changes: steps of ±5–20 %, or an exact price, held to 1–30 %. The headline states the break-even as a sentence from real data — "A 10% rise pays as long as you lose fewer than 44 of your ~350 sales a month (12.3%)" — because it rests only on the owner's price, cost to deliver and volume. The side-by-side `.rt` table puts the break-even first, then sales after, revenue change, profit change and worst case as "low – high" ranges under a customer-response band for the kind of business, printed as ASSUMED with its source (planning assumptions, `lib/simulate/pricing-bands.ts`). A gap is a MISSING flag whose card links to the question that asks it; with no cost, a rise's break-even is shown as a floor that holds for any cost. Whiskers and per-change chains follow the campaign simulator's pattern. There is no "Propose this": the screen never changes a price.

Two screens are focused views with their own masthead and no rail: the report and "Waiting for you". Every other owner screen opens with the shared page head (`components/sheet/PageHead.tsx`). That head is a mono kicker, one Zilla Slab headline that states the screen's main fact from real data, and a rule.

---

## 4. Intake — the signature screen

One question per screen on a paper sheet; beside it, a second sheet that is the live record. Each answer settles into the record as a fact line, and the next question rises into its place. (Revised 2026-10-17, sheet system: one record column, not two.)

```
┌──────────────────────────────────────────────────────────────┐
│ SYB   6 core facts on record · 6 core questions open  │
├──────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────┐   ┌────────────────────────┐  │
│  │ 1.4 · CORE                │   │ RECORD                 │  │
│  │ What does the business    │   │ 1.1 Business name      │  │
│  │ sell?                     │   │ Bellozo                │  │
│  │ [Physical] [Services] …   │   │ Source: you · stated   │  │
│  │                           │   │ Change                 │  │
│  │ RECORD ANSWER →  I don't  │   │ 1.2 What it does       │  │
│  │                  know     │   │ GAP RECORDED · Not     │  │
│  │ ENTER TO RECORD           │   │ known — I'll come back │  │
│  └───────────────────────────┘   └────────────────────────┘  │
│  NEXT · How many people work in the business?                │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 Why this works, and where I changed your idea

Your instinct is right: one question at a time removes the dread of a 300-field form, and the record filling up gives a sense of progress that a percentage bar can't. Three changes worth defending:

**The record is not history, it is the profile being built.** Each fact line carries its provenance in words (`Source: you · stated`), and the system restates what it just recorded above the next question, as a fact line, never as praise. The owner is literally watching the system's knowledge accumulate, with its sourcing visible. This turns a progress indicator into a trust device at no extra cost.

**A next-question preview sits below the centre, dashed and quiet.** Your description had the next question floating up from the bottom, which implies it exists down there. Showing it — muted, one line — removes the sense of an endless queue, because the owner can always see there is exactly one more thing coming. It also lets them mentally prepare, which measurably speeds up answers to longer questions.

**Answered cards are clickable.** Any card can be reopened; the old value stays in history and the change records a reason. Without this, the interaction is a one-way conveyor belt, and the first time an owner mistypes their revenue they'll feel trapped. This is also what makes the data model's superseded-facts design visible.

### 4.2 Interaction detail

**Answering.** Single-selects submit on click after a 130ms confirm beat, so the owner sees their choice register before the card leaves. Multi-selects and text require an explicit "Record answer →". Enter records; Cmd/Ctrl + Enter records from a textarea. The hints are written in words ("Enter to record"), never as key glyphs.

**Motion sequence:**
1. The question card departs, `--d-record` (280ms). The script waits on the same token, so the two can't drift apart.
2. The fact line settles into the record column, `--d-record`.
3. The next card rises into place, `--d-move` (220ms).

Under `prefers-reduced-motion` all three are instant, and so are the depart wait and the confirm beat. Fact lines append downward, and the newest one carries the `--marker` highlight: ink just laid down.

**"I don't know" is a first-class control**, styled as a visible link rather than hidden in a menu. It writes `status: unknown`, and the record line reads `GAP RECORDED · Not known`, with a follow-up note. A skip reads `NOT PROVIDED`; the two stay distinct. This is the interface honouring the schema rule that a gap is a finding, not a failure. An owner who feels forced to guess will guess, and every downstream conclusion inherits that guess.

**Progress is the record filling up:** `6 core facts on record · 6 core questions open`, never an `N / M` counter and never a percentage. The core count changes as branches open and close, so a counter or a percentage would jump backwards, and that destroys trust. Two plain counts that each only grow or shrink for a visible reason are honest.

**Validation** is inline and specific: "Answer this, or choose I don't know to move on." It appears under the control, in ink, and clears on the next keystroke. Errors never block with a modal and never apologise.

### 4.3 Entity-list questions

The one place a single centred question doesn't work. "List what the business sells" needs a sub-form, not a text field.

The card expands in place into a compact repeating row — name, type, price, cost, monthly volume — with "Add another" beneath. Only `core` sub-fields show initially; a quiet "Add detail" reveals the rest per row. When submitted, the whole list settles into the column as one chip reading `4 products · 3 with costs`, which expands on click.

This keeps the metaphor intact while acknowledging that a catalogue is not a question. It also directly serves the completeness score: an owner can add five products with names and prices in ninety seconds and fill in costs later, rather than abandoning at product two.

### 4.4 Mobile

Columns are structurally impossible below ~900px. Instead: the question fills the screen, and answered items collapse into a single "Recorded (6)" strip pinned below the card, expanding to a list on tap. The settle animation becomes a short downward slide into that strip, so the causation is still visible. Everything else is identical.

### 4.5 Reconcile

When the validator finds a contradiction, both fact lines are flagged `TO RECONCILE` and a reconcile panel appears below the question card.

The copy matters more than the layout, and it is plain (revised 2026-10-17: no persona lines). The heading names what was found (**"Two answers disagree"**), then both statements, then *"I won't pick one for you. Confirm both are right, or change one."* Two actions: "Confirm both →" (records a confirmation and clears the flag) or "Change one →" (returns both questions to the centre in sequence).

This is the tonal high-water mark for the whole product. The system has just caught the owner in an apparent inconsistency, which is exactly the moment a business tool usually makes someone feel stupid. Getting this moment right — curious, not corrective — sets the relationship for everything that follows, including the far more consequential moment when the system disagrees with a decision they've made.

### 4.6 The calibration layout (owner design, 2026-10-17)

The intake now follows the owner's "calibrating the record" design (`components/intake/**`, `app/intake.css`). It supersedes the wireframe at the top of §4 wherever the two differ.

**Masthead:**
- a live state: "Listening" while a question waits, "Saving…" while a request is in flight
- minutes in this sitting, measured on the browser clock
- the number of facts on file
- "Pause — finish later", which opens the resume-link form

**Channel bank:** one tile per bank section.
- Each tile has one bar per applicable question, in bank order. The bar kinds are owner, measured, derived, current, open, unknown and skipped, each with its own fill pattern.
- Each tile shows the percentage answered and a status word: DONE, MEASURING, READ ONLY, NOT STARTED, NEEDS CH nn or IN PROGRESS.

**Question panel:**
- a dark band showing the question, the channel, and how many questions and minutes are left (45 seconds a question)
- a graph-paper body with a watermark of the question number
- "Already measured" and "The missing piece" boxes, shown only when connector data exists for the question
- numbered option tiles, answered with keys 1–9
- the exact-amount input, with a ruler only when a measured value exists
- Back / Skip / Next

**Right column:**
- a live blended-margin dial with a neutral track. It has no bands until a reference range exists.
- report readiness: completeness shown as 25 cells
- the area's record, with "what this answer unlocks" taken from the bank's `unlocks`

**Tape:** a strip along the bottom showing the newest facts with their real timestamps. It scrolls by hand and never moves on its own.

**Not shown until data exists for them:** highlighted words in the question, range tiles, sensitivity figures and the Confirm action.

---

## 5. Mode decision

One screen, no interaction beyond acknowledgement, and it must not feel like a loading state.

```
┌──────────────────────────────────────────────┐
│  Six weeks of watching first.                │
│                                              │
│  Your business is operating with real        │
│  customers. Changing things quickly could    │
│  cost you sales, so I'll spend six weeks     │
│  learning how it actually behaves before     │
│  proposing anything.                         │
│                                              │
│  WHY SIX WEEKS                               │
│  ● 2 people working in the business          │
│  ● Ads running on Meta                       │
│  ● ~120 orders per month                     │
│  ● Revenue figures given as estimates        │
│                                              │
│  During this time I'll still send you the    │
│  first read on the business, and I'll ask    │
│  questions as they come up. I just won't     │
│  change anything.                            │
│                                              │
│  [ Start watching ]   Extend to eight weeks  │
└──────────────────────────────────────────────┘
```

Three deliberate choices. The reasons are listed as the actual `ModeDecisionInputs` that triggered the decision, so the owner can see it is a rule rather than an opinion. Extending is one click while shortening is buried in settings behind an explicit acknowledgement, encoding the asymmetry from the data model spec directly into the UI. And the screen states plainly what still happens during watching, because an owner who thinks they've paid for six weeks of nothing will cancel.

For instant mode the same screen inverts: "Starting now," with the reasons that make it safe.

---

## 6. Watching status

The risk of watching mode is that it feels like nothing is happening. The status screen answers "what is it doing right now" with real activity, never fabricated delay.

A vertical log, newest first, in mono: connected sources, observations recorded, questions queued, days remaining. Entries are genuine — *"Read 34 days of Meta ad performance"*, *"Noticed orders drop on Mondays"*, *"Waiting on: supplier lead times"*.

This is where I'd push back hardest on the original brief. You wrote that processes should look like they take hours because instant work doesn't feel like good work. Don't do this. Real research and real data ingestion genuinely take time, and showing honest progress on real work satisfies the same need. Manufactured delay is a bet that the customer never notices — and when they do, it retroactively poisons every honest thing the product has told them. The credibility this interface spends five screens building is not worth trading for a progress bar.

---

## 7. Diagnosis report

The first thing the owner actually paid for. Long-form, readable, and printable.

Structure, top to bottom:

**A plain-language summary** — three sentences, no jargon, stating the single most important thing found.

**Unit economics block:** the numbers as ruled tables, following the number grammar of §2. Every figure carries its basis, source and date as visible text: OBSERVED, DERIVED, ESTIMATED, STATED or ASSUMED, never a confidence percentage. A margin that came from the owner's estimate looks different from one computed from Stripe data, and it says so. STATED is a fifth basis class beside the four in §2: an exact owner answer is neither an estimate nor observed. Figures the data cannot support are listed under "Not computed" with what is missing; nothing is invented to fill a range column.

**Findings**, ordered by severity. Each is a headline, two sentences of detail, and an evidence box listing the specific answers it rests on, each with its basis. Severity is a worded flag (ACT NOW, HIGH, MEDIUM, LOW); colour only tints the word.

**Recommendations**, each with its scenario block: the assumptions stated, the base and downside cases, and the break-even condition. Where an assumption is marked high-sensitivity, it is called out inline — *"this depends heavily on your 22% repeat rate; if that's closer to 10%, the case doesn't hold."*

**What would sharpen this** — the top data gaps, each a one-click link back into the intake. This turns the report's weakest point into its best engagement loop: the owner sees exactly what their honesty would buy them.

Recommendations carry two actions — "Look into this" and "Not for us". Declining opens a short reason field, because that reason is the training data for everything the system proposes later. The field is optional but pre-filled with three common reasons as chips, since a required field here produces junk.

### 7.1 Landing page

The owner's landing mockup (HTML export, 2026-10-17) is the source for this page. It is built in `components/marketing/Landing.tsx`, `Walkthrough.tsx`, `StoreChart.tsx` and `Demos.tsx`, with styles in `app/landing.css`. The mockup's own colour values are scoped under `.ll` and apply to the landing page only.

The page, top to bottom:
1. Header.
2. Hero: "Its numbers" in coral italic.
3. A six-chapter product walkthrough player: cursor, captions, chapters, play/pause, and reduced-motion opening paused on the report chapter.
4. A 90-day candlestick revenue chart ("Your business, read like a stock.") with leak shading, 1D/1W and a crosshair.
5. Nine test panels (`lib/marketing/areas.ts`).
6. How it works.
7. Price.
8. Questions.
9. Footer.

The walkthrough and the chart show one of two fictional demos: a webshop (the default) and a hair and beauty salon, so a booking business sees itself as clearly as a webshop. The visitor switches with a segmented control ("A webshop" / "A salon") above the player and again above the chart; both show the same choice. It is worded, square, keyboard-reachable buttons in a group, with `aria-pressed` on the demo showing. Each demo carries its own connector, record question, markers, leak range, proposal, outcome and 90-day series (`lib/marketing/sample-diagnosis.ts`, `sample-chart.ts`).

Every sample is labelled as illustrative: "Illustrative store" for the webshop, "Illustrative salon" for the salon. `lib/marketing/sample-diagnosis.test.ts` holds each demo's flags to their range and act-now line, under the same tests for both, and every sample amount is in integer minor units.

The price on every button is `reportPrice()`. The examiner, guarantee count and delivery days come from `lib/marketing/offer.ts`, and print as the mockup's bracketed placeholders until supplied.

Two hero lines are promises the owner has not yet recorded in `offer.ts`: "Refund if we find nothing" and "Signed by a person". Confirm both before launch. `areas.ts` marks which panels have a read-only connector today.

---

## 8. Approval pattern

An approval is always: what will happen, why, what it's based on, and what happens if you decline. Two buttons of equal visual weight — approving and declining are both legitimate answers, and an interface that makes "no" feel like the small grey option is manipulating the owner.

Built (2026-10-17, `components/proposals/QueueScreen.tsx`). Each proposal sheet reads in this order:

1. The change, as before → after where the action carries both.
2. The expected effect as a range, from the downside and upside cases.
3. The evidence, with each assumption's source printed.
4. REVERSIBLE · EASY/MODERATE/HARD TO UNDO, or IRREVERSIBLE when reversibility is null.
5. What happens if you decline.

The decision controls:

- Approve → and Decline → are identical ink buttons, set apart, and neither is pre-selected.
- Decline takes a reason. Four chips fill it in one tap: WRONG DATA / WRONG TIMING / TOO RISKY / NOT MY STRATEGY. The API requires a non-empty reason.
- J / K moves between pending proposals.
- After a decision, the card becomes a thin inline stamp ("APPROVED 14:02 · ref …"), and focus advances to the next pending card. No overlay.
- An unanswered proposal expires as "not approved — nothing ran".

Not built yet, and waiting on owner decisions: a "Request changes" answer, an AI recommendation, pausing similar proposals after a decline, standing pre-approval policies, and snooze.

### 8.1 The change card in the chat (feature 33, 2026-10-22)

When the owner asks the chat to change one thing, the reply carries a change card (`components/chat/ChangeCard.tsx`), built on the same pattern:

1. A mono kicker saying what state it is in ("Drafted, not yet made · Fact sheet", "Drafted for your queue · Support", "Yours to change · Connections").
2. The change in plain words, one Zilla line: "Set your Saturday opening hours to 10:00–16:00."
3. NOW beside NEW, read from the record at the moment the change was drafted.
4. Two `.act` controls of equal weight, set apart: the confirming verb ("Make this change"; "Put it in my queue" where the click only queues a proposal; "Add this rule"; "Stop everything") and "Open the page →", a deep link to the exact section. A link-only card has only the second.
5. After the click, a worded `.flag` and a sentence: CHANGED / IN YOUR QUEUE / NOT CHANGED (the value moved since the draft — nothing is overwritten unseen). Cobalt appears only while the change is being made. NEW turns to "Now set to" on the marker.

A deep link is `route?focus=<element id>`. The landing screen scrolls the element into view and marks it with `--marker` behind ink for 2.4 s (`components/sheet/DeepLinkMark.tsx`); no hash jump, because the screens load their data after the page.

---

## 9. Notifications

Your instinct about notification fatigue is correct and it needs an enforced rule, not good intentions.

Three tiers:

**Needs you** — an approval or a blocking question. Push, badge, and it waits. Hard-capped at one push per day; further items batch into the same thread.

**Worth knowing** — a finding, a report, a completed action. In-app only, no push, collected into the three-day digest.

**Everything else** — routine activity. Visible in the log if you look, silent otherwise.

The cap is a product rule, not a preference. If the system ever needs more than one urgent push per day, that is a signal it is proposing too much, and the correct fix is upstream — batching proposals — not more notifications.

---

## 10. Voice

The interface speaks as the system, in first person, plainly. **"I'll watch for six weeks before changing anything"** — not "the analysis period has been set to 6 weeks."

Four rules held everywhere:

- **Say what will happen, in the owner's terms.** "I'll post three videos a day and check what works", not "content cadence optimisation enabled."
- **Never claim certainty the schema doesn't support.** "Based on the estimate you gave" is a sentence this product says often, and it is the reason its confident sentences land.
- **Failures explain and direct.** "I couldn't read your Meta account — the connection expired. Reconnect and I'll pick up where I left off." No apology, no vagueness.
- **Empty states invite.** The profile page before intake reads "Nothing here yet. Twelve questions and I'll have enough to start."

Buttons use the same verb from click to confirmation: "Record answer" produces a card that says recorded; "Start watching" leads to a screen that says watching.

---

## 11. Quality floor

Keyboard operable end to end, with a visible 2px focus ring in the ink of the surface underneath. `aria-live` on the centre stage so screen readers announce each new question. Colour never the sole carrier of meaning: every status is a worded flag, and every surface must read in grayscale. Contrast: every text token reaches WCAG 4.5:1 on each surface it appears on; the measured values are in §2. Reduced motion respected globally. Responsive to 360px with no horizontal page scroll; checked at 1440, 1024 and 390px.

---

## 12. Open questions

1. **Product name.** The mockup uses "SYB" as a placeholder so the topbar isn't empty. Your call entirely.
2. **Intake length before the first report.** The mockup shows 12 core questions; the bank defines 25 always-asked. Twelve is a better first session and the rest can come after the mode decision — but that means the first report is thinner. Worth deciding deliberately.
3. **Does the owner see the confidence score?** I've exposed provenance per fact but kept the overall score internal. Showing it is more honest; it also invites arguing with the number.
4. **Report delivery.** In-app only, or emailed as a PDF? Emailed reports get forwarded to business partners, which is free distribution — but they leave the product, where the actions are.

---

## 13. Next step

The natural next artifact is the diagnosis report as a designed screen rather than a described one, since it's the deliverable the whole v1 is built to produce and the one that has to justify the subscription. After that, the interviewer agent spec — which is the last piece before v1 is fully designed and buildable.

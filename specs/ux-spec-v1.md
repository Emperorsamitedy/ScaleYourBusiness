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
- *Your year, week by week* (`SeasonChart.tsx`, idea 46), on `/patterns`. Each bar is one complete week of the business's own series against its normal week (1.0×, the median of the last 52). Busy weeks (≥ 1.25×) are filled ink and quiet ones (≤ 0.8×) hollow `--drift`, so it reads in grayscale. The middle half of weeks is a tinted band round 1.0×, the busy and quiet lines are dashed, and a bracket marks last year's weeks that line up with the next eight. With under a year it draws the weeks there are against their own median, with no lines, no band, and a title that says it isn't a season.

- *The next 13 weeks of cash* (`CashChart.tsx`, P5-10), on `/cash`. Today's cash, then the balance at the end of each of the next 13 weeks as a tinted range band from the cautious end (slow sales, slow payouts) to the hopeful end, the cautious end a solid ink line along its lower edge and the hopeful end a hairline. The owner's buffer is a dashed `--drift` line with a mono BUFFER label (ZERO when none is stated). The first week whose cautious end dips under it carries a hollow square and "TIGHT". The readout gives both ends of the hovered week; the visually-hidden table lists every point.

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
| Creative studio | The niche's longest-running ads, and a cited creative brief to film from | v3 (P3-50, P3-51) |
| Team cover | Where the week runs short of cover or sits quiet, by role and hour; off by default | v5 (P5-18–P5-20) |
| Compared with similar businesses | A few of the owner's own numbers beside one named, dated Eurostat cell each | v5 (idea 44) |

Navigation follows the owner's menu design (2026-10-17, `components/nav/AppFrame.tsx`). It is a 248px ink rail with:
- the wordmark, the business name and the live state ("WATCHING · DAY 19 / 28") over a cobalt rule;
- five labelled groups (To approve, Insights, Grow, Customers, Your business) that list every screen;
- a mono count beside each item where a real count exists (`/api/nav`);
- "Ask me anything →" at the foot.

There are no icons and no section tabs. Under 900px the rail folds into a top bar with a Menu button.

**Campaign simulator** (`/simulate`, under Grow; feature 36). It lives on its own screen rather than in "Waiting for you" or on Customers: it compares email, ad and content options before any proposal exists, and the queue is a focused view for deciding, not for exploring. The owner picks two to four options in a ruled picker; a `.rt` table puts measures in rows (what it costs, people it reaches, orders, expected revenue, expected profit, worst case) and options in columns, each cell "low – high" in mono with the basis words of what it rests on, or a worded MISSING / NOT READ flag — a gap is never a number. A plain-SVG whisker per option shows expected profit against zero, the worst case as a square. Under it, each option shows its chain: every input with its value, basis and source (missing ones say what would fill them), the projection's own ASSUMED line, the arithmetic per measure, the worst case in words, and what the trust layer can say about similar past proposals. "Propose this" makes the normal proposal for its kind with the simulation attached; nothing executes. Money prints in whole major units, one decimal count throughout.

**Creative studio** (`/studio`, under Grow after Content; P3-50, P3-51). It has its own screen rather than a section of `/content`. Content is the queue of things made; the studio is where they are planned from research. The head states the longest-running concept found ("Saltmarsh Pottery's video has run 143 days — the longest-running concept I found"), or in words that research isn't set up or the Library can't show the niche. The aside reads "Meta Ad Library · read-only · OBSERVED".

- **The niche's ads.** The first sheet opens with an inset that is always printed and never behind a click. It says there are no results figures, that running time and versions are a proxy and not a measurement, that only the EU and UK are covered, and how far format can be told. A `.rt rt-stack` table lists the business (with a boxed YOU LISTED THEM for a listed competitor, and a link to the public Library page), the format as a mono word, running days with LIVE or STOPPED, versions, the opening line quoted, and the offer and call to action quoted or "no offer found". The staying-power arithmetic is the running cell's title.
- **Reading again.** The foot holds the owner's search terms and "Read again →", disabled until the once-a-day refresh with its time stated. With no token, or outside the coverage, the foot says why in place of the form, and the last read still shows.
- **The brief.** A sheet writes a brief from the owner's campaign words or a goal. It states the calls left this month and the copy rule. The brief sheet shows who it's for and the offer, each followed by its citation chips (mono, inset, `F3 · YOUR FACT`, `A1 · NICHE AD`, the source text on hover). Each hook is a Zilla line with its chips, the script with "about N s", and the numbered shots, each with its why. A collapsed list at the foot gives every source the brief was written from. The disclosure "Brief prepared with AI assistance." sits in the header.
- **Make this.** "Make this →" under each hook proposes that shot list; the notice links to "Waiting for you". While the watch runs it is disabled with the date in words.

Nothing on the screen publishes, generates, films or spends.

**Footage and the AI fallback on /content** (P3-52, P3-53, 2026-10-26). They sit under the open item in the detail sheet, only for an item that can take media: a shot list, or a post that needs a picture. Top to bottom:
- **Footage:** the clips uploaded so far (mono name, size, Remove), and a file control stating its limits (MP4 or MOV, the per-clip MB, 8 clips).
- **The cut:** once a clip is in, a caption (shot lists only), an optional on-screen line, the date and **Cut it**. The last cut's state is a boxed word (queued, cutting, rendered, failed) with its sentence, including "FFmpeg isn't here", and "Open the video" once rendered. The fine print says what the cutting room does and the label it applies.
- **The fallback:** shown only when there is no footage, headed "No footage? The AI fallback". It gives the estimate for an image and a clip in money words ("about €0.04") and says it is labelled as AI-generated and needs two yeses. It has an optional "what it should show" line and two buttons that put a PROPOSAL in the queue. Once approved, the one button is **Generate it**. When it is off, refused or watching, it gives one sentence ("Not offered: …") and no button.

The media line in the item's dark strip says "Media · AI-generated image" (or video) for generated media, never "your footage". A drafted post or video that now qualifies but has no publish proposal gets **Propose for publishing**. An approved generated item whose footage arrived says it won't be published.

**Seasons & bundles** (`/patterns`, under Insights beside Trading hours; ideas 46 and 48). Trading hours says when in the day and week; this says when in the year and what goes together. Both are deterministic readings of the business's own measured history. The head states the main fact: "Your busy stretch starts in 4 weeks: last year it ran 2.0× your normal week." The season chart comes first. Beside it, the next eight weeks each sit by the same week 52 weeks before ("Week of 23 Nov · last year €2,140 · 2.0× (1.8–2.2×) · BUSY") with the stretch in a sentence, then the months scaled to a week. Every index prints as a range: the week against the two ends of the normal middle half, widened by a second year where there is one. "How I read it" says that one year is one example, what normal is, and which weeks were left out. Under 50 complete weeks of the last 52, the screen does not name a season. It says how many days there are, from when it can, and two lists, *I can* and *I can't yet*; the second includes "borrow a season from other businesses like yours". Below, **What goes together** is a `.rt` table per source (a store's orders, or a bookings source's visits: one client's completed appointments on one day). Each row shows the pair, "together in N", "X% of orders with A" (A is the rarer item), the lift against chance with the chance count, and the pair's margin from the owner's own prices and costs, or "Margin unknown: …". The foot says the thresholds (5 together, 1.2× chance, 50 baskets) and counts what fell under each. "Propose this pair →" drafts one proposal, both items at full price with no discount. The line under the table says that nothing in the shop or the checkout changes, and that the owner sets the pair up. Before care and while watching, the button is off and says why.

**Stock** (`/stock`, under Insights, shown only to a business that holds stock; feature 34 and Phase 5 Session A, P5-05). The kicker is "Insights · Stock" and the menu item "Stock". The head states the soonest stock-out from real data ("Speckled Everyday Mug runs out in about 4–6 days."), or the slow-stock line when nothing runs short. The first sheet, **What runs out, and when**, is a `.rt rt-stack` table of every item read, warned items first (ACT NOW, then the soonest out), then the rest by cover. Its columns follow the number grammar: on hand, sold 28 d, "vs prior 28 d" (window A against window B, the change and "chance ±N" beneath; the sentence on hover), days of cover as "low–high" (never one number; "busy stretch counted" beneath when the season raised it), the delivery time as "10 d · Midland Clay Supplies" or "14 d · ASSUMED", and a worded flag: ACT NOW (even the slow end runs out before a delivery ordered today), RUNNING LOW (the fast end does), IN RANGE, SOLD OUT, NO SALES or TOO EARLY (under 28 measured days, with when it will be ready on hover). A sold-out item is a state, never a warning: the shop already shows it, and SYB can't see what is on order. The meta line says how cover is read; the line under the table is the season's: the busy stretch counted, or why none was. The foot holds "Put the reorder notes in my queue →", off with the reason while the business is watched or not yet in care. Under it, a **reorder note** sheet per warned item (up to four): the warning sentence with its proposal's status word, the quantity's arithmetic ("14.9 a day (up to 15.6) over 10 days = 149, + 7 safety margin … = 156; over Midland Clay Supplies' minimum order of 50"), the cost at the item's own unit cost, the sources line, every ASSUMED line in mono, and "Approving it records that you mean to reorder, and nothing else. I never contact your supplier, and I never place, change or cancel an order." Slow stock follows below, unchanged. Nothing on the screen orders, edits or cancels anything.

**Cash flow** (`/cash`, under Insights after Seasons & bundles; Phase 5 Session B, P5-10). When money gets tight over the next 13 weeks, read from the business's own numbers. The head states the main fact: "Money could get tight in the week of 29 Dec: the cautious end falls to −€600.", or that no week dips under the buffer. Under the headline, on every state of the screen including refusals and errors, two mono lines: the planning note ("A planning aid from your own numbers, not financial advice. SYB never moves, pays or collects money.") and the sources line (cash today with its basis, the measured series, the payout timing ASSUMED). The aside reads "Planning aid · read-only". Then:

- **The cash chart** (§2.1).
- **When money gets tight**: the warning sentence, its reasons as a list (a quarterly cost by name, the monthly costs on the 1st, debt repayments, a quiet stretch last year, or the weekly drain), and a line saying it is written to the Watching log and weekly summary and that nothing is proposed or done about it. With no buffer stated it links to 5.3f.
- **What this is built on**: a `.rt rt-stack` table of every input (value, basis flag, where it came from), then "Assumed, by name" (each line prefixed ASSUMED), "Left out" (other currencies, a cost with no amount or frequency, debt with no repayment), and "Would sharpen it" with links to the questions. It closes on "Nothing here is an industry average".
- **Scenarios · side by side**: a ruled form (slow month %, from week; big order amount, week; hire a month, from week; a price change's item and step from what-if pricing) and "Work it out", then a `.rt` table with measures in rows (what changes, lowest balance at the cautious end with its week, balance after 13 weeks, against as things are, first tight week) and columns As things are + the four scenarios. A scenario without its figure is one MISSING cell saying what fills it.
- **Week by week**: money in, going out and the balance as "low – high" per week, what is due that week, and a boxed UNDER THE LINE on weeks whose cautious end is under it.

With under 8 complete weeks of the last 13, no cash figure, nothing measured, or cash and sales in two currencies, the screen shows no chart: it says how much there is, when it will be ready, and two lists, *I can* and *I can't yet* (the second includes borrowing a sales pattern from other businesses). Nothing on the screen pays, moves, transfers or collects money, and nothing on it makes a proposal.

**Compared with similar businesses** (`/benchmarks`, under Insights after Competitors; idea 44). The kicker is "Insights · Compared with similar businesses"; the menu item is "Similar businesses", because the full name wraps to two lines in the 248 px rail. The head is the group in words, from the map and the headcount: "Compared with online and mail-order shops with up to 9 people in Ireland." Under it, a mono line says what the NACE code covers, and a line says when the size is unknown and the group is every size, with a link to 1.6. The aside reads "Eurostat · read-only" and "N of 3 compared". Then one sheet per line (operating margin, turnover a year per person, staff cost a year per employee):
- **A compared line.** The sheet's title is the sentence "Yours is 33.4%, theirs 1.2%: 32.2 points above." Beside it is a boxed neutral word: ABOVE, BELOW or ABOUT THE SAME (within ±15 %). It is never coloured, because a figure above or below a group isn't good or bad. Then:
  - Yours and Theirs, as two large mono figures.
  - "Theirs: all online and mail-order shops with up to 9 people in Ireland, 2024, Eurostat", with Eurostat's flag in words when there is one, the fallback sentence when the first group had no figure ("Eurostat doesn't publish this for … so this is … of every size …"), and the conversion rate and year for a non-euro business.
  - The line's one definition gap, in an inset.
  - The owner's arithmetic, in mono with the numbers.
  - A `.rt rt-stack` table, "What yours rests on": each input's value, basis (OBSERVED, STATED, ESTIMATED, DERIVED) and where it came from.
  - "Not counted", listing each cost left out and why. A missing figure is a link to its question.
- **A line it can't compute** says "Not compared yet" (boxed NOT YET), what it needs, a link per question ("Add your monthly revenue →"), and its definition gap.
- **A line with no Eurostat figure, no employees or no rate** says "No comparison" and why.

With no business type, a type with no honest match (agriculture, events, nonprofit, other), no readable country, or a country outside the EU27, the head says so in a sentence and one sheet says why, with a link where a question would fix it. Every state with lines ends with the foot: "Source: Eurostat, sbs_sc_ovw (doi.org/10.2908/SBS_SC_OVW), updated 30 Sep 2026, retrieved 29 Oct 2026, reused with the source acknowledged. I keep each group's latest year and convert euros to your currency; Eurostat isn't responsible for that. These are totals across every business in the group, not a typical business." No model and no network: the screen reads the committed snapshot through `/api/benchmarks`. Nothing on it is a finding or a proposal.

**Team cover** (`/team`, under Insights after Trading hours; P5-18–P5-20, rule 28). Off by default. The switch is the last row of the Modules card on `/watch`, set apart from the "for when I start acting" switches with its own line: by role and hour, never about a person, off unless switched on. While it is off the menu has no item, `/api/team` answers only `{ enabled: false }`, and `/team` says how to switch it on and nothing else. Switched on, the head states the main fact from the business's own bookings as a sentence: "Saturdays 10:00–14:00 ran 127% booked; one stylist covers about 1.1 appointments an hour at your stated 120 a week." The aside reads "Roles and hours · never people".
- **The grid.** One weekday at a time, picked from mono buttons (the screen opens on the top finding's day), as a role × hour table in the Trading hours grid's pattern. The first row is "Booked, of stated capacity": each hour's typical day as a percentage, its middle-half range on hover. Then one row per role, with its title as the owner wrote it and "on, average hour": its stated hours a week over the open hours. Cells are tinted runs short (the middle half's low end at or over 100%), covered, or quiet (its high end at or under 40%). Closed hours are hatched. Without bookings, takings stand in ("of the busiest hour"), and nothing can run short.
- **Beside it.** "Reading" lists each run of hours in words, with its range, the number of days read and its reason ("one stylist covers…"), then the busy season in a sentence, or why it can't be read yet. "Notes for you" holds the suggestions: role-level, the owner's to weigh, never an instruction. "Built on" gives the source, window and history, and every ASSUMED line by name (capacity spread evenly over the open hours, the rota unknown, opening hours read from when appointments start). Then the roles card, and an inset: "Roles, never people".
- **Refusing.** Under 28 days of history, without a stated weekly capacity, or with no times on the bookings, the head says so with the count of days there are and when it will be ready, and *I can* / *I can't yet* lists replace the grid. The second list includes "borrow a pattern from other businesses like yours".

Nothing on the screen names, scores or ranks a person, and nothing changes a rota.

**What-if pricing** (`/simulate?tab=pricing`; idea 43). The simulator's second half, one of two plain links under the page head ("Campaigns", "What-if pricing"), so each half has its own address. The owner picks one product or service in a ruled picker (a booking business's services come from its own last 28 days of appointments) and up to four price changes: steps of ±5–20 %, or an exact price, held to 1–30 %. The headline states the break-even as a sentence from real data — "A 10% rise pays as long as you lose fewer than 44 of your ~350 sales a month (12.3%)" — because it rests only on the owner's price, cost to deliver and volume. The side-by-side `.rt` table puts the break-even first, then sales after, revenue change, profit change and worst case as "low – high" ranges under a customer-response band for the kind of business, printed as ASSUMED with its source (planning assumptions, `lib/simulate/pricing-bands.ts`). A gap is a MISSING flag whose card links to the question that asks it; with no cost, a rise's break-even is shown as a floor that holds for any cost. Whiskers and per-change chains follow the campaign simulator's pattern. There is no "Propose this": the screen never changes a price.

**The measured site audit on /site** (P5-11..13, Phase 5 Session C, 2026-10-27). A tab beside the before/after wording changes and the "what customers look for" check: "Measured · 7 findings", or "Measure the site" before the first run; it is the default tab when no change is proposed. The page head's line adds "measured 25 Oct: 7 findings". The sheet's label states the run ("ran 25 Oct · 8 pages read · 8 PageSpeed calls"), its meta a boxed "no action" and **Run the audit again** (signed in; refused in words inside the hour, and when the week's PageSpeed calls are spent with the date they return). Top to bottom:
- **Notes, always printed when they apply:** "Measured on Google's shared PageSpeed quota — no API key is set", why fewer pages were measured, and "N of 20 PageSpeed calls this week".
- **The findings**, a `.rt` table: the severity as a worded flag (ACT NOW, HIGH, MEDIUM, LOW), what was measured with its detail, the measured value with its basis in words ("real visitors" for Google's field data, "real visitors, whole site", "one test load" for lab, "page read") and phone or computer, the stated threshold in words with whose it is (Google, Lighthouse, SYB), and the € at stake as a whole-unit range, its formula, window and every ASSUMED line, or "not computed — …" with what is missing.
- **The path to buying** in clicks: a mono numbered list from Home to the checkout or booking entry, each step a page read, a control seen but never pressed, or the entry seen but never opened, then its notes (the ASSUMED step after Add to cart).
- **The pages Google loaded**: phone and computer as "LCP 4.3 s · CLS 0.03 · INP 190 ms" (TBT marked lab where no real-visitor INP exists), weight, and "field + lab" or "lab only — too few visitors".
- **Seen and left alone**: login pages, cart actions, checkout and hosted booking pages, each with why, then the three never lines (reads like a visitor; never logs in, sends a form, adds to a cart or opens checkout; SYB runs no browser).
The foot says the judged layer (screenshots, a vision model) isn't built, and that checkout is never changed automatically.

In the report (§7), a measured site finding sits in the findings list by severity like any other, with "· measured" beside its area and presence.site_audit as its evidence.

**Abandoned carts** (`/carts`, under Customers after Customers; idea 47). It is shown only when a store connection reads carts (Shopify today), read from the provider registry (`lib/carts/load.ts` `cartsApply`); the menu reads it from `/api/nav` (`carts`), and the API answers `applies: false` to anyone else. The kicker is "Customers · Abandoned carts". The head states the measured fact: "€1,240 was left in carts in the last 30 days; 9 of the 41 shoppers can be emailed." Currencies sit side by side ("€1,240 and £80"), never added. A mono line under it gives the window in short days ("29 Sep to 28 Oct: 47 checkouts started, 41 left, 6 finished later; 25% of all checkouts left unfinished."), then the 30 days before, or why there is no comparison yet. **What was left behind** is a `.rt rt-stack` table of up to five products: the owner's offer name where matched, else the cart line's title, in how many carts, units and value left. **Likely to win back** is a range ("€37–€124 likely back") with a boxed ASSUMED, the base it is taken from ("3–10% of €1,240 … the value of the 9 carts whose shopper said yes to email"), the rule of thumb's own sentence, and the sources line ("Carts and orders: Shopify, read 29 Oct. Who can be emailed: each contact's own recorded consent, checked again when an email goes."). With nobody emailable it shows no figure. Its foot holds **Propose win-back emails →**: off while watching ("I'm watching until 6 Nov, and I propose nothing before then."), when the owner said no consent, when nobody who said yes left a cart 1–7 days ago, or when they were all proposed a reminder in the last 30 days, each with its sentence; with today's proposal made it shows that proposal's status word instead. **Who can be emailed** lists the consent notes, each a count in words ("12 carts are from contacts with no recorded yes to email, so they aren't emailed."), never an address, and says that Shopify's own tick isn't counted as a yes. Under 14 days of carts or 10 carts left, the screen shows one sheet, **Not enough carts to measure**, with the refusal's own sentence, how many there are, and from when it will be ready where that can be known. Every state ends with the foot: "SYB never emails a shopper who hasn't said yes. Shopify's own abandoned-checkout email, if you use it, is separate." Nothing on the screen sends anything.

**Pipeline** (`/pipeline`, under Customers after Abandoned carts; P5-17). It is shown only to a business that sells to businesses: 6.1a is b2b or both, by the condition `customers.type neq b2c` in `lib/pipeline/stages.ts`. The menu reads it from `/api/nav` (`pipeline`), and the API answers `applies: false` to anyone else.

- **The head** states the weighted range from the business's own win rate: "€5,885–€20,715 of your €26,600 open is likely to close." Without a win rate it reads "5 open deals worth €26,600. I can't weigh them yet." The aside reads "Your pipeline · N deals · win rate MEASURED / STATED / NOT KNOWN".
- **The board** has stages as columns (Lead, Qualified, Proposal sent, Won, Lost; won and lost show for 90 days). Each column gives its count, value per currency and the median and oldest days in stage. Deals within a column run longest in stage first. Each deal shows who (the company, else the contact's name, never an address), what it is for, its value (marked "your estimate" when it isn't a quote), its days in stage, and a STALE flag with a drift rule on its left.
  - A "Change" disclosure under each deal moves its stage, sets the next step and its date, and records "I spoke to them today".
- **Gone quiet** lists the stale deals, longest quiet first, in the follow-up's own words: "Nobody has spoken to Café Nua in 23 days", or "Nothing recorded with … since you added it". Under each is why it is stale ("No next step", or "Next step was due 21 Oct, 6 days ago") and its follow-up's worded flag: WAITING FOR YOU, APPROVED, DRAFTED, BLOCKED BY YOUR RULE or DECLINED.
  - An approved follow-up offers "Draft the email". A drafted one is shown inset with the name filled in, "I don't send this. Copy it into your own email to them", and "Copy the text".
  - The foot's "Propose follow-ups" is off while watching or under a "no consent" 6.4b, and says why in place of the default line.
- **What's likely to close** is an `.rt` table per currency: deals, open, and likely to close as "low – high". The win rate in words is in the meta. It then lists the ASSUMED lines, the window and the sources, the stated rate beside a measured one, and how many more closed deals until a stated rate is replaced by a measured one.
  - Without a rate it shows *I can* and *I can't yet* lists, when it will be ready, and a link to 6.1f.
- **Add a deal and Import** sit side by side. The import carries the same attestation as Customers (what the people consented to, and how, in the owner's words), a currency, and whether the values are quotes or estimates.

Nothing on the screen sends anything.

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
- The bank starts folded to one ruled line so the question owns the screen. The line shows the channel being asked with its percentage, one cell per area filled to its share answered, and how many areas are done. "All channels" unfolds the tiles unchanged; choosing a tile folds it again.

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

**Findings**, ordered by severity. Each is a headline, two sentences of detail, and an evidence box listing the specific answers it rests on, each with its basis. Severity is a worded flag (ACT NOW, HIGH, MEDIUM, LOW); colour only tints the word. A finding SYB measured itself (the site audit, P5-13) carries "· measured" beside its area: it is a measurement against a stated threshold, not the diagnosis's judgement (site-audit §2).

**Recommendations**, each with its scenario block: the assumptions stated, the base and downside cases, and the break-even condition. Where an assumption is marked high-sensitivity, it is called out inline — *"this depends heavily on your 22% repeat rate; if that's closer to 10%, the case doesn't hold."*

**What would sharpen this** — the top data gaps, each a one-click link back into the intake. This turns the report's weakest point into its best engagement loop: the owner sees exactly what their honesty would buy them.

Recommendations carry two actions — "Look into this" and "Not for us". Declining opens a short reason field, because that reason is the training data for everything the system proposes later. The field is optional but pre-filled with three common reasons as chips, since a required field here produces junk.

**Share this report (idea 51, 2026-10-26).** A card above the report's footer, in the sheet style with no icons. It has a choice of 7 or 30 days, one "Make a link →" action, and the new link shown once in a read-only field with "Copy" (it can't be shown again, since only its hash is kept). Below that is the list of links made: open, expired or revoked, when each was made, when it expires, when it was last opened and how often, and "Revoke" on each open one. Signed out, the card says sign-in is needed. It is left out of print.

The shared view at `/shared/<token>` is the same report body, read only. Its masthead has the business, platform and currency, plus "Shared report · read only". There is no rail, no sub-nav and no link on the wordmark. The recommendations show without the owner's answers or the answer buttons. "Answer now" and "See every weekday" are left out. The footer says it is a shared snapshot, when it was made, and from which report. A dead link of any kind gets one plain sheet: "This link is no longer active."

**Accountant export (idea 49, 2026-10-26).** On `/profile`, the page head's aside says "For your accountant" over two plain links: "Money facts, CSV" and "Earlier figures, CSV". They are file downloads, not screens.

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

### 8.2 "Run this as an ad" (P3-54, Session K, 2026-10-26)

On `/content`, a drafted or queued post or video that carries its image or clip shows one more line in its record's footer and one `.prop-btn`: "Run this as an ad". The line says what the button does before it is pressed: one proposal with its budget, audience and expected range, then the fixed sentence **"Creates paused; going live is a separate approval; created objects can't be deleted, only paused."** The button makes a proposal and nothing else; the notice says it is in the queue. After that the same line tracks the ad with a boxed state word in the existing tones: `ad proposed` (live, "Decide the ad in the queue →"), `ad held back` (low, a hard limit), `ad approved` (ok, waiting for the next run or for Meta ad changes to be switched on), `ad in progress` (live, a build carrying on from its journal), `ad paused` (created on Meta, paused; "Propose going live" when no go-live is waiting), `ad live` (ok), `ad unconfirmed` (drift: a create Meta never confirmed — "I may have created the ad set — check Ads Manager") and `ad failed` (alarm). An item that can't be an ad and has no ad history shows nothing.

In the queue (§8), an ad proposal's section 1 keeps the before → after table (`no ad → on Meta, paused · spends nothing`; the go-live reads `paused · spends nothing → live · up to €5 a day for 7 days`) and adds a `.q-cases` list under a rule: BUDGET (a day, and at most in all), DURATION (days from going live, then it stops by itself), AUDIENCE (place and age band, in words), INTERESTS ("left broad"), PLACEMENTS, OPTIMISED FOR, any SPECIAL CATEGORY with "Meta's restricted targeting applies", and a NOTE per adjustment (a radius held to Meta's minimum, an age band removed). The fixed sentence sits under it in the `.q-manual` box. Section 2's range is labelled "over 7 days", not "a month". Section 4 reads IRREVERSIBLE for the create (the proposal declares `irreversible`), REVERSIBLE · EASY TO UNDO for the go-live. The primary button states the consequence: "Create the ad, paused" / "Put the ad live".

---

## 9. Notifications

Your instinct about notification fatigue is correct and it needs an enforced rule, not good intentions.

Three tiers:

**Needs you** — an approval or a blocking question. Push, badge, and it waits. Hard-capped at one push per day; further items batch into the same thread.

**Worth knowing** — a finding, a report, a completed action. In-app only, no push, collected into the three-day digest.

**Everything else** — routine activity. Visible in the log if you look, silent otherwise.

The cap is a product rule, not a preference. If the system ever needs more than one urgent push per day, that is a signal it is proposing too much, and the correct fix is upstream — batching proposals — not more notifications.

**The weekly summary email (idea 42, 2026-10-26).** One email a week to the owner, sent on the Monday beat, so the "worth knowing" tier reaches an owner who doesn't log in. It is the Watching screen's week, sent: what waits for you (proposals, and open support questions as a count, never their words), what I did, what I noticed, your goals, and how approved changes are doing. Every line is a row on record. A quiet week says "A quiet week" and nothing else. The email is plain HTML in the sheet tokens (ink on paper, 1px rules, mono labels, no images, no colour carrying meaning) with the same words in a text part. It has no tracking pixel. Every email carries a one-click "stop these emails" link, which opens a page with one button, like the unsubscribe page. The switch is a "Weekly email" card beside Modules on /watch, on by default once How I work is decided. The card says plainly when the server can't send email.

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

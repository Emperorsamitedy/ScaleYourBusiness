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

### The brand (2026-11-15)

The product is **ScaleX** (it was SYB). The logo is concept A, "Ascent": an X made of two short rounded Ink bars on one diagonal, crossed by an Accent arrow rising to the upper right, beside the wordmark "Scale" in the ground's ink with the "X" in Accent (Archivo 800, −0.03em). On a dark ground the bars are white. One geometry on a 100-unit grid (`components/brand/Mark.tsx`) draws the rail and mastheads (`<Logo onDark />`), the app icons (dark tile `#1B2030`, white bars) and the 32 px favicon (light tile, ink bars) through `components/sheet/AppIcon.tsx`. The name is never translated. Brand colours: Ink `#0D1321`, Accent `#00A86B`, Paper `#FFFFFF`. Accent is 3.1:1 on paper, so it is used only for the mark, large type and rules; small green text on paper uses `--ok`.

### Surfaces

| Token | Value | Use |
|---|---|---|
| `--desk` | `#0D1321` | The background: the receding navigation layer (ScaleX Ink) |
| `--masthead` | `#080C16` | Ink masthead, with a 2px `--live-rule` (`#00A86B`, ScaleX Accent) beneath. The rule is static brand structure, not machine state |
| `--paper` | `#FFFFFF` | The sheet. Content lives here (ScaleX Paper) |
| `--inset` | `#EEF1F5` | Evidence boxes and stamps. Close to paper, so every inset also carries a 1px `--rule` |
| `--rule` / `--rule-soft` | `#7A8494` / `#D5DAE2` | 1px rules: structural (3.8:1 on paper) and row hairlines |
| `--accent` / `--accent-desk` | `#00A86B` / `#2BD594` | The brand green: the mark, large type, rules; as text on the desk, the lighter one (9.8:1) |

Square corners everywhere. No shadows on sheets: separation comes from 1px rules, surface colour and whitespace. No icons: meaning is carried by words, typography, rules and position. Typographic characters such as → are allowed.

### Text and meaning

Every text token is measured on each surface it appears on (WCAG 2 ratio; re-measured for the ScaleX palette on 2026-11-15). Every pair passes AA.

| Token | Value | On paper | On inset | On desk | Use |
|---|---|---|---|---|---|
| `--sheet-ink` | `#0D1321` | 18.6:1 | 16.4:1 | — | Text on sheets |
| `--sheet-ink-2` | `#4A5263` | 7.8:1 | 6.9:1 | — | Secondary text on sheets |
| `--desk-ink` | `#F4F6FA` | — | — | 17.1:1 | Text on the desk |
| `--desk-ink-2` | `#AEB6C4` | — | — | 9.1:1 | Secondary text on the desk. Never a muted grey |
| `--live` | `#1A3DAE` | 9.0:1 | 8.0:1 | — | Cobalt: the machine is working right now. Nothing else |
| `--live-desk` | `#C2D4FF` | — | — | 12.5:1 | The same meaning, on the desk |
| `--ok` | `#00754A` | 5.8:1 | 5.1:1 | — | Tints IN RANGE; the brand green deepened for text on paper |
| `--low` | `#36495F` | 9.2:1 | 8.2:1 | — | Tints BELOW RANGE and idle |
| `--drift` | `#683D00` | 9.3:1 | 8.2:1 | — | Tints ABOVE RANGE (slightly past) |
| `--alarm` | `#8C1713` | 9.4:1 | 8.3:1 | — | Tints ACT NOW. Also underlined, so alarm differs from drift in shape, not only hue |
| `--marker` | `#F7E26B` | — | — | — | Ink was just laid down. Only ever a background behind ink (13.7:1), **never text** |

Colour never carries meaning alone: every status is a worded flag, and the screen must read in grayscale.

**Cobalt is machine state only.** Interactive elements are ink on paper: a full 1px border, a verb label with a typographic arrow ("APPROVE →"), underlined links, an ink-fill inversion on hover and press within 100ms, and a 2px focus ring in the ink of the surface underneath, offset 3px. Never cobalt, never a pill, and at least 48px tall.

### Type

| Role | Face | Use |
|---|---|---|
| Display | Zilla Slab 500–600 | One primary figure or heading per sheet. Never chrome |
| Prose | Archivo | All reading text, 45–90 characters per line (`--measure: 68ch`) |
| Figures and labels | IBM Plex Mono 400–600 | Every figure and every label. Tabular numerals on the figure itself, right-aligned in columns |

The mono layer still encodes something true: every fact carries its source, date and basis as text. **Reorganised 2026-11-15 (the owner: "retention matters the most"; walls of text lose owners):** a screen says the answer first and keeps the working-out one press away instead of printed beside every figure. Each screen follows one order: the headline (the answer, one sentence from real data), at most one sentence under it, the readings (up to four figures, each with a named comparison and a worded flag), what needs the owner (a decision or one warning), then the detail in tables and lists. A figure's basis, source, date and arithmetic sit in the **Why sheet** (`components/sheet/WhySheet.tsx`): a paper sheet sliding in from the right with a cobalt rule on its edge, opened by an underlined mono "WHY" beside the figure, closed by Close, Escape or the scrim, focus returning to the button. Longer working-out stays on the page under a closed "How this works" fold. Nothing is deleted: the fact sheet and its exports still print every source. No machine text on the page: no proposal codes, specimen numbers or keyboard hints (the keys still work). The page head's headline is set large (`.ph-title`, 24–38px). Caps are reserved for mono labels and flags. Scale: display 64/40/26px, prose 19/16/14px, mono 14/12.5/11.5px. Nothing below 11.5px.

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

**The market chart** (`MarketChart.tsx`) sits on the fact sheet (`/profile`) between the page head and the record, and on Home (`/home`, the first screen after sign-in since 2026-11-15) in its compact form, where the event key and the components table fold closed under "How this works". Its head names it ("Your salon, read like a stock", the noun from `lib/core/business-noun`) and states the opportunity cost as a range from real data: "About €1,180–€1,950 a month is slipping away — mostly no-shows." It draws:

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
| Which business? | After sign-in, when one email belongs to several businesses | idea 52 |
| Team access | Who can sign in to this business, with which role; invites | idea 52 |
| Invite | Where a team invite lands; joining needs a sign-in as exactly the invited address | idea 52 |

Navigation follows the owner's menu design (2026-10-17, `components/nav/AppFrame.tsx`), reorganised 2026-11-15. It is an ink rail with:
- the wordmark (a link to Home), the business name and the live state ("WATCHING · DAY 19 / 28") over a cobalt rule;
- six labelled groups (Today, To approve, Insights, Grow, Customers, Your business). The rail lists each group's main screens (an item's `rail: true`): Home; Waiting for you and What I may do; Report, Watching, Goals and Cash flow; Customers; Fact sheet, Connections, Monthly statement and History. Grow marks none, so its four screens are all listed. The screen open now is listed too when it is not a main one;
- a **strip across the top of the page** (`.app-strip`): every screen of the open group as square mono tabs (the open one a paper tab, counts beside them), wrapping on a desk and one swipeable row on a phone, with the emergency stop at its right (except on Content and Website, which carry their own);
- a mono count beside each item where a real count exists (`/api/nav`);
- "Ask me anything →" at the foot.

There are no icons. Under 760px the rail folds into a top bar with a Menu button.

**Home** (`/home`, Today; 2026-11-15) is the first screen after sign-in (the redeem, OAuth, switch and "Which business?" routes all land there). It answers what needs the owner today, from screens that already exist (`/api/nav`, `/api/proposals`, `/api/cash`, `/api/charts`), adding no figure of its own. Top to bottom: the headline "3 decisions are waiting for you." with "The biggest could add +€134 – +€1,238 a month." and **See them →**; the one warning when the cash forecast has a tight week ("UNDER YOUR BUFFER · Money could get tight in the week of 15 Nov." — it reports, it never pushes, P5-08); the readings strip (waiting, cash today against the buffer, the lowest point ahead and its week, the watch day), each with its flag and, where there is one, WHY; the waiting decisions, the largest money range first (`components/home/home-model.ts`), each with **Open →**; then the compact market chart beside the watch's day squares. A part whose read fails is left out in silence.

**Alerts and modules** (`/settings/alerts`, under Your business; 2026-11-15): the Modules card, the Weekly email card and the Phone alerts card, moved from the foot of Watching so that screen says only what is being watched. Watching keeps one line pointing here.

**The entrance screens** (`/login`, `/signup`, `/login/confirm`, `/resume`, the language and currency first step). Decluttered 2026-11-09 on the owner's instruction: the desk carries only the headline (no kicker, no promise list on sign-in, no "what happens after this screen" steps on sign-up, which the landing page's "How it works" already gives); the sheet carries its title, the inputs and the button. Explanations sit under one closed "How this works" per sheet (the no-password note; why a confirm page asks; the currency's no-conversion rule and the "being checked" note), and a dead link's reason under "Why?". The sign-up terms line stays visible, word for word, under the form.

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

**Seasons & bundles** (`/patterns`, under Insights beside Trading hours; ideas 46 and 48). Trading hours says when in the day and week; this says when in the year and what goes together. Both are deterministic readings of the business's own measured history. The head states the main fact: "Your busy stretch starts in 4 weeks: last year it ran 2.0× your normal week." The season chart comes first. Beside it, the next eight weeks each sit by the same week 52 weeks before ("Week of 23 Nov · last year €2,140 · 2.0× (1.8–2.2×) · BUSY") with the stretch in a sentence, then the months scaled to a week. Every index prints as a range: the week against the two ends of the normal middle half, widened by a second year where there is one. "How I read it", a closed fold under the two sheets, says that one year is one example, what normal is, how last year's week lines up and which months count, and which weeks were left out. Under 50 complete weeks of the last 52, the screen does not name a season. It says how many days there are and from when it can; a closed "What I can and can't say yet" fold holds the reason and two lists, *I can* and *I can't yet*; the second includes "borrow a season from other businesses like yours". Below, **What goes together** is a `.rt` table per source (a store's orders, or a bookings source's visits: one client's completed appointments on one day). Each row shows the pair, "together in N", "X% of orders with A" (A is the rarer item), the lift against chance with the chance count, and the pair's margin from the owner's own prices and costs, or "Margin unknown: …". The foot's "How this works" fold gives the window and says the thresholds (5 together, 1.2× chance, 50 baskets) and counts what fell under each. "Propose this pair →" drafts one proposal, both items at full price with no discount. A "How this works" fold under the table says that nothing in the shop or the checkout changes, and that the owner sets the pair up. Before care and while watching, the button is off and the reason shows under the table. (Decluttered 2026-11-09 on the owner's instruction.)

**Stock** (`/stock`, under Insights, shown only to a business that holds stock; feature 34 and Phase 5 Session A, P5-05). The kicker is "Insights · Stock" and the menu item "Stock". The head states the soonest stock-out from real data ("Speckled Everyday Mug runs out in about 4–6 days."), or the slow-stock line when nothing runs short. The first sheet, **What runs out, and when**, is a `.rt rt-stack` table of every item read, warned items first (ACT NOW, then the soonest out), then the rest by cover. Its columns follow the number grammar: on hand, sold 28 d, "vs prior 28 d" (window A against window B, the change and "chance ±N" beneath; the sentence on hover), days of cover as "low–high" (never one number; "busy stretch counted" beneath when the season raised it), the delivery time as "10 d · Midland Clay Supplies" or "14 d · ASSUMED", and a worded flag: ACT NOW (even the slow end runs out before a delivery ordered today), RUNNING LOW (the fast end does), IN RANGE, SOLD OUT, NO SALES or TOO EARLY (under 28 measured days, with when it will be ready on hover). A sold-out item is a state, never a warning: the shop already shows it, and ScaleX can't see what is on order. The meta line says how cover is read; the line under the table is the season's: the busy stretch counted, or why none was. The foot holds "Put the reorder notes in my queue →", off with the reason while the business is watched or not yet in care. Under it, a **reorder note** sheet per warned item (up to four): the warning sentence with its proposal's status word, the quantity's arithmetic ("14.9 a day (up to 15.6) over 10 days = 149, + 7 safety margin … = 156; over Midland Clay Supplies' minimum order of 50"), the cost at the item's own unit cost, the sources line, every ASSUMED line in mono, and "Approving it records that you mean to reorder, and nothing else. I never contact your supplier, and I never place, change or cancel an order." Slow stock follows below, unchanged. Nothing on the screen orders, edits or cancels anything.

**Cash flow** (`/cash`, under Insights after Seasons & bundles; Phase 5 Session B, P5-10). When money gets tight over the next 13 weeks, read from the business's own numbers. The head states the main fact: "Money could get tight in the week of 29 Dec: the cautious end falls to −€600.", or that no week dips under the buffer. Under the headline, on every state of the screen including refusals and errors, a closed "How this works" fold holds two mono lines: the planning note ("A planning aid from your own numbers, not financial advice. ScaleX never moves, pays or collects money.") and the sources line (cash today with its basis, the measured series, the payout timing ASSUMED). The aside reads "Planning aid · read-only". Then (decluttered 2026-11-09 on the owner's instruction: no card repeats its title as a mono label, and what a forecast rests on is one click away instead of read out):

- **The cash chart** (§2.1).
- **The first tight week** (or "No tight week in the next 13"): the warning sentence and its reasons as a list (a quarterly cost by name, the monthly costs on the 1st, debt repayments, a quiet stretch last year, or the weekly drain). With no buffer stated it links to 5.3f. Its "How this works" fold says that it is written to the Watching log and weekly summary and that nothing is proposed or done about it, and, with no tight week, that the cautious end stays above the line.
- **Sources, and what I assumed**, with the history window as its meta: under a closed "Details" fold, a `.rt rt-stack` table of every input (value, basis flag, where it came from), then "Assumed, by name" (each line prefixed ASSUMED), "Left out" (other currencies, a cost with no amount or frequency, debt with no repayment), and "Would sharpen it" with links to the questions. It closes on "Nothing here is an industry average".
- **What if…**: a ruled form (slow month %, from week; big order amount, week; hire a month, from week; a price change's item and step from what-if pricing) and "Work it out", then a `.rt` table with measures in rows (what changes, lowest balance at the cautious end with its week, balance after 13 weeks, against as things are, first tight week) and columns As things are + the four scenarios. A scenario without its figure is one MISSING cell saying what fills it. Each scenario's ASSUMED lines sit in its "How this works" fold.
- **Week by week**: money in, going out and the balance as "low – high" per week, what is due that week, and a boxed UNDER THE LINE on weeks whose cautious end is under it.

With under 8 complete weeks of the last 13, no cash figure, nothing measured, or cash and sales in two currencies, the screen shows no chart: it says how much there is and when it will be ready, and a closed "What I can and can't say yet" fold holds two lists, *I can* and *I can't yet* (the second includes borrowing a sales pattern from other businesses). Nothing on the screen pays, moves, transfers or collects money, and nothing on it makes a proposal.

**Compared with similar businesses** (`/benchmarks`, under Insights after Competitors; idea 44). The kicker is "Insights · Compared with similar businesses"; the menu item is "Similar businesses", because the full name wraps to two lines in the 248 px rail. The head is the group in words, from the map and the headcount: "Compared with online and mail-order shops with up to 9 people in Ireland." Under it, a line says when the size is unknown and the group is every size, with a link to 1.6. (Decluttered 2026-11-09 on the owner's instruction: what the NACE code covers, each sheet's cell, definition gap, arithmetic, inputs and "Not counted", the large gap's rule, and the source foot sit in closed "How this works" folds.) The aside reads "Eurostat · read-only" and "N of 3 compared". Then one sheet per line (operating margin, turnover a year per person, staff cost a year per employee):
- **A compared line.** The sheet's title is the sentence "Yours is 33.4%, theirs 1.2%: 32.2 points above." Beside it is a boxed neutral word: ABOVE, BELOW or ABOUT THE SAME (within ±15 %). It is never coloured, because a figure above or below a group isn't good or bad. Then:
  - Yours and Theirs, as two large mono figures, and a link per missing question.
  - Folded under "How this works": "Theirs: all online and mail-order shops with up to 9 people in Ireland, 2024, Eurostat", with Eurostat's flag in words when there is one, the fallback sentence when the first group had no figure ("Eurostat doesn't publish this for … so this is … of every size …"), and the conversion rate and year for a non-euro business.
  - The line's one definition gap, in an inset.
  - The owner's arithmetic, in mono with the numbers.
  - A `.rt rt-stack` table, "What yours rests on": each input's value, basis (OBSERVED, STATED, ESTIMATED, DERIVED) and where it came from.
  - "Not counted", listing each cost left out and why. A missing figure is a link to its question.
- **A line it can't compute** says "Not compared yet" (boxed NOT YET), what it needs, a link per question ("Add your monthly revenue →"), and its definition gap.
- **A line with no Eurostat figure, no employees or no rate** says "No comparison" and why.

With no business type, a type with no honest match (agriculture, events, nonprofit, other), no readable country, or a country outside the EU27, the head says so in a sentence and one sheet says why, with a link where a question would fix it. Every state with lines ends with a closed "How this works" fold holding what the NACE code covers and the foot: "Source: Eurostat, sbs_sc_ovw (doi.org/10.2908/SBS_SC_OVW), updated 30 Sep 2026, retrieved 29 Oct 2026, reused with the source acknowledged. I keep each group's latest year and convert euros to your currency; Eurostat isn't responsible for that. These are totals across every business in the group, not a typical business." No model and no network: the screen reads the committed snapshot through `/api/benchmarks`. **I-44a:** when the operating margin is 10 points or more under the group's figure, like for like (`lib/benchmarks/gap`), one more sheet follows the lines. It is labelled "A large gap", with the title "Your operating margin is N points under that of similar businesses." Its "How this works" fold says how the rule is drawn, and that the gap now appears in the report as a finding. Above the fold comes one `.act` button, "Propose going through prices and costs →", or the proposal's state as a boxed word with "Open it in your queue →", or the hold sentence before care or while watching. On the report, that finding's head carries "· compared with similar businesses" beside its area, as a measured finding carries "· measured".

**Team cover** (`/team`, under Insights after Trading hours; P5-18–P5-20, rule 28). Off by default. The switch is the last row of the Modules card on `/settings/alerts` (on `/watch` until 2026-11-15), set apart from the "for when I start acting" switches with its own line: by role and hour, never about a person, off unless switched on. While it is off the menu has no item, `/api/team` answers only `{ enabled: false }`, and `/team` says how to switch it on and nothing else. Switched on, the head states the main fact from the business's own bookings as a sentence: "Saturdays 10:00–14:00 ran 127% booked; one stylist covers about 1.1 appointments an hour at your stated 120 a week." The aside reads "Roles and hours · never people". (Decluttered 2026-11-09 on the owner's instruction: the basis line left the head, and the grid's method, the sources and assumptions, the limits and the refusal's lists sit in closed folds; "Roles, never people" stays in sight as the limits fold's summary.)
- **The grid.** One weekday at a time, picked from mono buttons (the screen opens on the top finding's day), as a role × hour table in the Trading hours grid's pattern. The first row is "Booked, of stated capacity": each hour's typical day as a percentage, its middle-half range on hover. Then one row per role, with its title as the owner wrote it and "on, average hour": its stated hours a week over the open hours. Cells are tinted runs short (the middle half's low end at or over 100%), covered, or quiet (its high end at or under 40%). Closed hours are hatched. Without bookings, takings stand in ("of the busiest hour"), and nothing can run short. Its "How this works" fold says how each row is counted, and links to the Fact sheet for wrong roles or hours.
- **Beside it.** The reading's title ("Where cover runs short or sits quiet", or "Nothing stands out") over each run of hours in words, with its range, the number of days read and its reason ("one stylist covers…"), then the busy season in a sentence, or why it can't be read yet. "Notes for you" holds the suggestions: role-level, the owner's to weigh, never an instruction. A closed "Sources and assumptions" fold gives the source, window and history, and every ASSUMED line by name (capacity spread evenly over the open hours, the rota unknown, opening hours read from when appointments start). Then the roles card, and an inset whose closed fold is headed "Roles, never people".
- **Refusing.** Under 28 days of history, without a stated weekly capacity, or with no times on the bookings, the head says so; a sheet gives the count of days there are against the least it reads, and its "Why?" fold holds the reason, when it will be ready and the *I can* / *I can't yet* lists, in place of the grid. The second list includes "borrow a pattern from other businesses like yours".

Nothing on the screen names, scores or ranks a person, and nothing changes a rota.

**People** (a separate section of `/team` under the cover, P6-06, rule 28 amended in TASKS-PHASE6.md). The owner role only: for a manager or viewer `/api/team/people` answers the role refusal and the section renders nothing; with the team module off it renders nothing either (the cover above already says how to switch it on). It is ruled off from the cover by a desk rule and its own head: the label "People · Only you see this, as the owner", the title "Each person's own figures", and one short line: "Facts about the work. Nothing here ever becomes a proposal about a person." (Decluttered 2026-11-09 on the owner's instruction.) A closed "How this works" fold holds the longer sentence, the mono basis line with the source, the window and the count ("From your bookings export from Fresha · 2026-10-11 to 2026-11-07 · 470 appointments with a person on them"), and the foot below.
- **One card per person**, alphabetical by name, every card the same shape and the same ink: no tint, flag, badge or order by a figure. Each figure is a mono label, the value, and under it what it was counted from: completed appointments ("of 168 booked with them"), booking revenue ("list prices of 140 of 140 completed appointments"), the no-show and late-cancellation rates ("9 of 152 due appointments"), utilisation ("140 completed of 160 slots: 40 a week, your figure, stated 8 Nov") and the rebooking rate ("31 of 52 clients seen … booked again, with anyone, within 42 days"). Under a bookings minimum the value reads "Too few to say" with the count and the minimum; a figure that can't exist reads "Not measured" with why (no capacity stated, no prices, Square doesn't separate late cancellations). Neither is ever coloured as an alarm.
- **What the owner may do.** State the person's appointments a week (a whole number, 1–1,000, said only when the figure is out of range; "Clear" removes it), the only thing utilisation is measured against. "Remove this person" asks once in words (their name and figures are erased, a later import won't bring the name back, their appointments stay in the business's figures without a name), then says how many appointments stay.
- **The foot**, inside the head's fold, counts the appointments in the window that name nobody (or someone removed), and says that no sales source records who made a sale, so there are no sales figures per person.

**What-if pricing** (`/simulate?tab=pricing`; idea 43). The simulator's second half, one of two plain links under the page head ("Campaigns", "What-if pricing"), so each half has its own address. The owner picks one product or service in a ruled picker (a booking business's services come from its own last 28 days of appointments) and up to four price changes: steps of ±5–20 %, or an exact price, held to 1–30 %. The headline states the break-even as a sentence from real data — "A 10% rise pays as long as you lose fewer than 44 of your ~350 sales a month (12.3%)" — because it rests only on the owner's price, cost to deliver and volume. The side-by-side `.rt` table puts the break-even first, then sales after, revenue change, profit change and worst case as "low – high" ranges under a customer-response band for the kind of business, printed as ASSUMED with its source (planning assumptions, `lib/simulate/pricing-bands.ts`). A gap is a MISSING flag whose card links to the question that asks it; with no cost, a rise's break-even is shown as a floor that holds for any cost. Whiskers and per-change chains follow the campaign simulator's pattern. There is no "Propose this": the screen never changes a price.

**The measured site audit on /site** (P5-11..13, Phase 5 Session C, 2026-10-27). A tab beside the before/after wording changes and the "what customers look for" check: "Measured · 7 findings", or "Measure the site" before the first run; it is the default tab when no change is proposed. The page head's line adds "measured 25 Oct: 7 findings". The sheet's label states the run ("ran 25 Oct · 8 pages read · 8 PageSpeed calls"), its meta a boxed "no action" and **Run the audit again** (signed in; refused in words inside the hour, and when the week's PageSpeed calls are spent with the date they return). Top to bottom:
- **Notes, always printed when they apply:** "Measured on Google's shared PageSpeed quota — no API key is set", why fewer pages were measured, and "N of 20 PageSpeed calls this week".
- **The findings**, a `.rt` table: the severity as a worded flag (ACT NOW, HIGH, MEDIUM, LOW), what was measured with its detail, the measured value with its basis in words ("real visitors" for Google's field data, "real visitors, whole site", "one test load" for lab, "page read") and phone or computer, the stated threshold in words with whose it is (Google, Lighthouse, ScaleX), and the € at stake as a whole-unit range, its formula, window and every ASSUMED line, or "not computed — …" with what is missing.
- **The path to buying** in clicks: a mono numbered list from Home to the checkout or booking entry, each step a page read, a control seen but never pressed, or the entry seen but never opened, then its notes (the ASSUMED step after Add to cart).
- **The pages Google loaded**: phone and computer as "LCP 4.3 s · CLS 0.03 · INP 190 ms" (TBT marked lab where no real-visitor INP exists), weight, and "field + lab" or "lab only — too few visitors".
- **Seen and left alone**: login pages, cart actions, checkout and hosted booking pages, each with why. The three never lines (reads like a visitor; never logs in, sends a form, adds to a cart or opens checkout; ScaleX runs no browser) sit in the foot's closed "How this works" (decluttered 2026-11-09 on the owner's instruction).
The foot is one closed "How this works" (decluttered 2026-11-09 on the owner's instruction): checkout is never changed automatically, the three never lines, and that the judged layer (screenshots, a vision model) isn't built.

In the report (§7), a measured site finding sits in the findings list by severity like any other, with "· measured" beside its area and presence.site_audit as its evidence.

**Reviews** (`/reviews`, under Customers right after Customers, for every business; idea 45). The kicker is "Customers · Reviews". The head states the month's main fact by each review's own date: "2 reviews of 3 stars or fewer this month, of 14." With none poor it reads "None of this month's 6 reviews is 3 stars or fewer." (one review: "This month's one review isn't 3 stars or fewer."), and with none this month "No new reviews this month."; with nothing on file, "No reviews here yet." The aside reads "14 reviews on file · kept 365 days". **What people said** lists every review, newest first: a mono line with the platform in caps, the stars in words ("2 of 5", or "No rating"; stars are never drawn), the short date and, for one worth knowing, the word WORTH KNOWING with a drift rule on its left; then the reviewer's name as the site showed it, the words, and a fine line when it was read by the fallback ("check it against the original"), pasted, read from Google Business Profile ("Read from your Google Business Profile."), or couldn't be read ("I kept only where and when. Open it where it lives."). **Suggest a reply →** (and, once there is one, **Suggest another →**) asks for a draft; it is off once the review's three suggestions are used, and the line under it counts what is left. A suggestion opens in a textarea labelled "Suggested reply · yours to edit" with **Copy the reply**; the line under it ("I drafted this…") was removed (decluttered 2026-11-09 on the owner's instruction): the label says it is a suggestion, and the foot says ScaleX never posts. A refused draft shows its own sentence. **Open on Google ↗** links to where the review lives. **Remove this review** asks once ("Remove this review, the name on it and any suggested reply? Yes, remove it · Keep it"). **Google Business Profile** (I-45a), a card of its own between the list and the forwarding card, says in plain words that Google's permission can also post replies and edit the listing, that ScaleX only reads reviews with it, and that it can be revoked any time. Connected, its title names the location ("Reading your Google reviews for Lumen Hair Studio") and it says ScaleX reads once a day, the same review arriving both ways is listed once, and when it last read and how that went; Google no longer accepting the access reads "Google stopped accepting ScaleX's access". Not connected, it lists what is needed before it can work, and without the Google setup it says "Reading from Google isn't set up yet". Its foot links to Connections, where the permission is granted and revoked. **Forwarding** shows the address in mono with **Copy the address**, then one closed "How this works" holding what forwarding does and the plain steps for Google and Trustpilot (decluttered 2026-11-09 on the owner's instruction); its foot holds **Get a new address**, which warns first that the old one stops. Without `SUPPORT_INBOUND_DOMAIN` it says "Forwarding isn't set up yet" and points to the paste form. **Paste a review** asks where it was left, the stars (1 to 5, required), what they wrote, their name as the site shows it, the link and the date (each optional) and files it with **File this review**; a repeat says "That review is already here." The foot, closed under "How this works" (decluttered 2026-11-09 on the owner's instruction): "ScaleX never posts a reply and never signs in to your review sites. It reads your Google reviews only if you connect Google Business Profile, and only reads them. A reviewer's name is kept for a year, and you can remove any review at once." At 375 px the cards stack and the address wraps.

**Abandoned carts** (`/carts`, under Customers after Reviews; idea 47). It is shown only when a store connection reads carts (Shopify today), read from the provider registry (`lib/carts/load.ts` `cartsApply`); the menu reads it from `/api/nav` (`carts`), and the API answers `applies: false` to anyone else. The kicker is "Customers · Abandoned carts". The head states the measured fact: "€1,240 was left in carts in the last 30 days; 9 of the 41 shoppers can be emailed." Currencies sit side by side ("€1,240 and £80"), never added. A mono line under it gives the window in short days ("29 Sep to 28 Oct: 47 checkouts started, 41 left, 6 finished later; 25% of all checkouts left unfinished."), then the 30 days before, or why there is no comparison yet. **What was left behind** is a `.rt rt-stack` table of up to five products: the owner's offer name where matched, else the cart line's title, in how many carts, units and value left. **Likely to win back** is a range ("€37–€124 likely back") with a boxed ASSUMED, the base it is taken from ("3–10% of €1,240 … the value of the 9 carts whose shopper said yes to email"), and, in a closed "How this works" fold, the rule of thumb's own sentence and the sources line ("Carts and orders: Shopify, read 29 Oct. Who can be emailed: each contact's own recorded consent, checked again when an email goes."). With nobody emailable it shows no figure. Its foot holds **Propose win-back emails →**: off while watching ("I'm watching until 6 Nov, and I propose nothing before then."), when the owner said no consent, when nobody who said yes left a cart 1–7 days ago, or when they were all proposed a reminder in the last 30 days, each with its sentence; with today's proposal made it shows that proposal's status word instead. **Who can be emailed** lists the consent notes, each a count in words ("12 carts are from contacts with no recorded yes to email, so they aren't emailed."), never an address, and its "How this works" fold says how Shopify's checkout tick becomes a recorded yes. Under 14 days of carts or 10 carts left, the screen shows one sheet, **Not enough carts to measure**, with the refusal's own sentence, how many there are, and from when it will be ready where that can be known; its "Why?" fold holds the measuring rule and the sources line. Every state ends with a closed "How this works" fold holding the foot: "ScaleX never emails a shopper who hasn't said yes. Shopify's own abandoned-checkout email, if you use it, is separate." (Decluttered 2026-11-09 on the owner's instruction: the products sheet lost its title and meta, and no sheet repeats its title as a label.) Nothing on the screen sends anything.

**Pipeline** (`/pipeline`, under Customers after Abandoned carts; P5-17). It is shown only to a business that sells to businesses: 6.1a is b2b or both, by the condition `customers.type neq b2c` in `lib/pipeline/stages.ts`. The menu reads it from `/api/nav` (`pipeline`), and the API answers `applies: false` to anyone else.

- **The head** states the weighted range from the business's own win rate: "€5,885–€20,715 of your €26,600 open is likely to close." Without a win rate it reads "5 open deals worth €26,600. I can't weigh them yet." The aside reads "Your pipeline · N deals · win rate MEASURED / STATED / NOT KNOWN".
- **The board** has stages as columns (Lead, Qualified, Proposal sent, Won, Lost; won and lost show for 90 days). Each column gives its count, value per currency and the median and oldest days in stage. Deals within a column run longest in stage first. Each deal shows who (the company, else the contact's name, never an address), what it is for, its value (marked "your estimate" when it isn't a quote), its days in stage, and a STALE flag with a drift rule on its left.
  - A "Change" disclosure under each deal moves its stage, sets the next step and its date, and records "I spoke to them today".
- **Gone quiet** lists the stale deals, longest quiet first, in the follow-up's own words: "Nobody has spoken to Café Nua in 23 days", or "Nothing recorded with … since you added it". Under each is why it is stale ("No next step", or "Next step was due 21 Oct, 6 days ago") and its follow-up's worded flag: WAITING FOR YOU, APPROVED, DRAFTED, BLOCKED BY YOUR RULE or DECLINED.
  - An approved follow-up offers "Draft the email". A drafted one is shown inset with the name filled in, "I don't send this. Copy it into your own email to them", and "Copy the text".
  - The foot's "Propose follow-ups" is off while watching or under a "no consent" 6.4b, and says why in place of the default line, which otherwise sits in a closed "How this works" fold.
- **What's likely to close** is an `.rt` table per currency: deals, open, and likely to close as "low – high". The win rate in words is in the meta. Its closed "How this works" fold lists the ASSUMED lines, the window and the sources, the stated rate beside a measured one, and how many more closed deals until a stated rate is replaced by a measured one.
  - Without a rate it shows the reason, when it will be ready, and a link to 6.1f; the *I can* and *I can't yet* lists sit in a "Why?" fold.
  - **Likely won by** (I-54b) folds its track-record line, ASSUMED lines and sources the same way.
- **Add a deal and Import** sit side by side. The import carries the same attestation as Customers (what the people consented to, and how, in the owner's words), a currency, and whether the values are quotes or estimates. Each sheet's "How this works" fold holds its consent note: a new contact's UNSURE consent, and the import's attestation sentence with the columns it reads.
- The fine print (erasing a contact erases their deals; dates in whole days) is the screen's last fold. (Decluttered 2026-11-09 on the owner's instruction: the board, quiet, likely-to-close, add and import sheets lost their restating titles.)

Nothing on the screen sends anything.

**My track record** (on `/history`, above the ledger; idea 54). ScaleX grading its own forecasts beside the scorecard that grades its proposals. It is a `.cs` sheet labelled "My track record". Its title is the headline, a sentence counted from the record: "5 of my last 7 forecasts landed inside the range I gave; 2 missed." "Can't tell" is named after it and kept apart: "I couldn't tell on 1: the measured figures weren't there, or something I didn't forecast got in the way. It isn't counted either way." Under three graded forecasts it reads "Too soon to judge my forecasts: 2 graded so far, 3 forecasts waiting for their time to pass." With none at all, it says what will appear there. The head's figures gain "Forecasts inside 5 / 7" once three are graded.

- **By kind**, one mono line each: "Stock run-out dates: 1 of 2 inside, 1 couldn't tell." and "Weeks against last year: 4 of 5 inside, 1 waiting."
- **Each forecast**, newest first, is a row with a boxed word: `inside`, `above`, `below`, `can't tell` or `waiting`. `inside`, `above` and `below` share one ink: a miss is as plain as a hit, and the word carries it, not a colour. Then come what I said (the sentence as it was shown), a mono line with the kind, "Said on 26 Oct 2026" and the range in its own units, "On what basis:" with the basis sentence, and "What happened:" with how far off a miss was in its own units ("It came to €5,010, measured by Shopify: €510 over the top of the range."; "It lasted longer: 3 still on hand on 5 Nov 2026 … 2 days after the latest day I gave"). A waiting one says when its window closes. A row written to the record days after the day it is dated (only the demo seed's) says so in a line of its own.
- **The foot** says that each forecast is recorded the moment it is shown, graded once from measured figures only, and never changed, and that "can't tell" never counts as right. It sits behind a closed "How this works" disclosure (decluttered 2026-11-09 on the owner's instruction), as does the ledger's own foot (the approval-rate arithmetic, append-only, how a verdict is graded); the too-early and unmeasured counts stay in view.

At 360 px each row stacks the word above the text, with no horizontal scroll. The weekly summary email adds one section, "How my forecasts did", only in a week when something was graded: "I graded 4 of my forecasts this week: 2 landed inside the range I gave, 1 missed (1 came in above it), and I couldn't tell on 1." It links to `/history`.

**Several businesses and your team** (idea 52, 2026-10-29). One email can belong to several businesses, and each business can have a team with three roles (owner, manager, viewer; lib/auth/roles.ts).

- **Which business?** (`/login/choose`). A sign-in for an email on two or more businesses lands here instead of the profile. It uses the entrance screens' sheet (§2): the kicker "Signed in as name@example.com", the headline "Which business?", then one door per business, "Fernhill Ceramics · Owner", with the arrow at the far right. Only the name and the role are shown, never anything inside a business. The business already open continues straight in; any other is a plain form post that switches. **Add another business** makes a new one under the same email and starts its interview. "Each business keeps its own facts, team and bill. Nothing from one is ever shown in another." sits under a closed "How this works" below the doors; the sheet has no label or instruction line (decluttered 2026-11-09 on the owner's instruction).
- **The switcher.** In the rail head, under the business name, and only with two or more businesses: a mono "SWITCH BUSINESS" disclosure listing the others by name as ruled buttons, each a form post. One business, no switcher.
- **The role, quietly.** A mono line above "Sign out": "You're an owner here", "You're a manager here", or "You're a viewer here: you can read, and press stop". Under 760px it shows with the open menu, beside Sign out.
- **What a role can't do** is disabled, not hidden, with the server's own sentence beside it ("Only an owner can connect or disconnect accounts.", "Only an owner or a manager can approve or decline proposals."). In "Waiting for you" the three answers grey out and the sentence sits under the approval note. On Connections a note heads the panel and the patch panel and consent sections are disabled as a whole. On the stop, "Start things up again" becomes "Only an owner can start things up again after a stop." Pressing stop is never disabled.
- **Team access** (`/settings/team`, under Your business after History, shown once someone has signed up). The kicker is "Your business · Team access" and the head states the fact: "Only you can sign in here." or "3 people can sign in here." The aside reads "You're an owner". Four sheets follow:
  - **Who can sign in**: a `.rt rt-stack` table of each person (their email, "(you)"), their role (a select for an owner), since when, and "Take off the team" with a confirm ("Yes, take them off" / "Keep"). The last owner has no select and no remove, and says "A business always keeps one owner."
  - **Waiting to join**: each open invite, its role and "works until 5 Nov" (or "ran out …"), with Withdraw. Under it, for an owner, the invite form: email, role and **Invite →** (what each role can do lives in the roles sheet below, not repeated under the form — decluttered 2026-11-09 on the owner's instruction). Email goes through Resend when it is set up. Otherwise the notice says "Email isn't set up here, so I can't send it. Copy the link below and send it yourself." and the link sits in a read-only field with **Copy**. The line above it says the link works once, for seven days, and only for the invited address.
  - **What each role can do**: the three roles in a definition list, the same words as the table.
  - **Run more than one business?**: **Add another business →**, its one line folded under "How this works".
  
  A manager or viewer sees the same list with no controls and the note "Only an owner can invite, change or remove people on the team." (the second sentence, "You can see who's here.", was removed 2026-11-09 on the owner's instruction) The screen shows no activity, no counts and nothing about how anyone works (rule 28).
- **The invite** (`/invite?token=…`) uses the entrance sheet. "Join Fernhill Ceramics." names the role and the invited address ("As a manager, for sam@example.com"). Opening it changes nothing. Signed in as that address, the one button is **Join**. Signed out, it is "Email a sign-in link to sam@example.com", and opening that link joins. Signed in as anyone else, the sheet says "This invite is for … and you're signed in as … I won't add the wrong person: sign out, then open this link again." and offers only **Sign out**. A used, withdrawn or expired invite says "That invite doesn't work.", with which and the ask for a new one under a closed "Why?". Decluttered 2026-11-09 on the owner's instruction: no kicker or sheet label, no line repeating the headline before **Join**, and how joining works ("You'll sign in as …", "Nothing happens until you press the button.") sits under a closed "How this works".

Two screens are focused views with their own masthead and no rail: the report and "Waiting for you". Every other owner screen opens with the shared page head (`components/sheet/PageHead.tsx`). That head is a mono kicker, one Zilla Slab headline that states the screen's main fact from real data, and a rule.

**The Trust Ladder screen** (`/ladder`, "What I may do"; redesigned 2026-11-16 on the owner's instruction, from the mockup they approved). It was a bulleted list that repeated the same three lines under every kind of action. It is now one sheet that is the ladder itself (`components/ladder/LadderScreen.tsx`, `ladder-view.ts`, `app/ladder.css`):
- The four stations are columns across the top of the sheet. Each says its step number, what ScaleX does there, and how many lines stand on it. A station no line may reach here is hatched and says "not open here".
- Every kind of action is a row, grouped by kind (Posts, Ads, Customers, Suppliers; a capability no group names lands under Other, never dropped). The row carries its name and station in words, a four-cell track with its marker in the column it has reached (cells above its ceiling are hatched and dashed), and its record: "No record yet", or the count measured with gains and losses beneath.
- The ceiling is said once, in the sheet's foot, when every row shares one below the top ("Step 2 is the highest step for this business right now."), not under every row.
- A row is a button. Opened, it shows what the next step needs as a list of the server's rules, each with a worded flag (Met / Not yet), then its controls: Raise one step, Ask to act within limits, Confirm (with its note), Lower one step. A row at its ceiling says so in words. One row is open at a time.
- A demotion notice or a refused change sits above the sheet, once, with "Got it".

The screen still decides nothing. It chooses which control to show from what `/api/ladder` returned (`nextMove`), and the server checks every change again. Colour never carries a state alone: the marker cell holds its step number, closed cells are hatched, and every rule has a worded flag. Under 760 px the columns stack two by two and each row stacks its track and record under its name.

---

## 4. Intake — the signature screen

One question per screen on a paper sheet; beside it, a second sheet that is the live record. Each answer settles into the record as a fact line, and the next question rises into its place. (Revised 2026-10-17, sheet system: one record column, not two.)

```
┌──────────────────────────────────────────────────────────────┐
│ ScaleX   6 core facts on record · 6 core questions open  │
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

**Answering.** Single-selects submit on click after a 130ms confirm beat, so the owner sees their choice register before the card leaves. Multi-selects and text require an explicit "Record answer →". Enter records; Cmd/Ctrl + Enter records from a textarea. No key hints are printed (decluttered 2026-11-09 on the owner's instruction); the keys still work.

**Motion sequence:**
1. The question card departs, `--d-record` (280ms). The script waits on the same token, so the two can't drift apart.
2. The fact line settles into the record column, `--d-record`.
3. The next card rises into place, `--d-move` (220ms).

Under `prefers-reduced-motion` all three are instant, and so are the depart wait and the confirm beat. Fact lines append downward, and the newest one carries the `--marker` highlight: ink just laid down.

**"I don't know" is a first-class control**, styled as a visible link rather than hidden in a menu. It writes `status: unknown`, and the record line reads `GAP RECORDED · Not known`, with a follow-up note. A skip reads `NOT PROVIDED`; the two stay distinct. This is the interface honouring the schema rule that a gap is a finding, not a failure. An owner who feels forced to guess will guess, and every downstream conclusion inherits that guess.

**Progress is the record filling up:** `6 core facts on record · 6 core questions open`, never an `N / M` counter and never a percentage. The core count changes as branches open and close, so a counter or a percentage would jump backwards, and that destroys trust. Two plain counts that each only grow or shrink for a visible reason are honest.

**Validation** is inline and specific: "Answer this, or choose I don't know to move on." It appears under the control, in ink, and clears on the next keystroke. Errors never block with a modal and never apologise.

**Speaking an answer (idea 50, 2026-10-29).** A "Speak" button sits under free-text boxes only: the intake's text and long-text answers, the `/chat` composer and the support reply draft. Never on number, money, date, choice or entity-list answers, where a misheard word is a wrong fact. Speech fills the box as a draft, appended after what is typed; the owner reads it, fixes it and presses the box's own button, so nothing is recorded by speaking. It is the sheet's `.act` button: a fixed name ("Speak your answer") with `aria-pressed`, filled with ink while listening, and one `aria-live` line beside it saying "Listening… Press Speak again to stop.", the notice, or what happened. Listening stops on a second press, after 8 seconds of silence, at one minute, or as soon as the owner types. It uses the browser's own recognition, on the device where the browser has it; otherwise the first press in a browser shows "Your browser turns your speech into text. In Chrome, Google does this; ScaleX never receives the audio." and listening starts on the next press. Failures say what happened and what to do ("The microphone is blocked for this site. Allow it in your browser's site settings…"). Where the browser has no recognition (Firefox), the button isn't drawn.

### 4.3 Entity-list questions

The one place a single centred question doesn't work. "List what the business sells" needs a sub-form, not a text field.

The card expands in place into a compact repeating row — name, type, price, cost, monthly volume — with "Add another" beneath. Only `core` sub-fields show initially; a quiet "Add detail" reveals the rest per row. When submitted, the whole list settles into the column as one chip reading `4 products · 3 with costs`, which expands on click.

This keeps the metaphor intact while acknowledging that a catalogue is not a question. It also directly serves the completeness score: an owner can add five products with names and prices in ninety seconds and fill in costs later, rather than abandoning at product two.

### 4.4 Mobile

Columns are structurally impossible below ~900px. Instead: the question fills the screen, and answered items collapse into a single "Recorded (6)" strip pinned below the card, expanding to a list on tap. The settle animation becomes a short downward slide into that strip, so the causation is still visible. Everything else is identical.

### 4.5 Reconcile

When the validator finds a contradiction, both fact lines are flagged `TO RECONCILE` and a reconcile panel appears below the question card.

The copy matters more than the layout, and it is plain (revised 2026-10-17: no persona lines). The heading names what was found (**"Two answers disagree"**), then both statements; the line restating the two buttons and the kind word repeating the heading are gone (decluttered 2026-11-09 on the owner's instruction). Two actions: "Confirm both →" (records a confirmation and clears the flag) or "Change one →" (returns both questions to the centre in sequence).

This is the tonal high-water mark for the whole product. The system has just caught the owner in an apparent inconsistency, which is exactly the moment a business tool usually makes someone feel stupid. Getting this moment right — curious, not corrective — sets the relationship for everything that follows, including the far more consequential moment when the system disagrees with a decision they've made.

### 4.6 The calibration layout (owner design, 2026-10-17)

The intake now follows the owner's "calibrating the record" design (`components/intake/**`, `app/intake.css`). It supersedes the wireframe at the top of §4 wherever the two differ.

**Decluttered 2026-11-09 on the owner's instruction** ("no extra wordings/texts"): captions that restate a heading are gone (the "Calibrating the record" line, "Channel bank", "Live reading · moves as you answer", "The record · newest first", "The interview · complete", the tape's "Tape" label), and so are the key hints, the readiness note and the money field's "Basis: estimated" (the toggle already says it). Explanations sit behind one closed "How this works" / "Why?" per card: the question's purpose (the bank's help text, unchanged), how the live figure was worked out and that no range exists yet, the pause and done ledes, and the boot error's reason.

**Masthead:**
- "Saving…" while a request is in flight (no other state is claimed)
- the number of facts on file
- "Finish later", which opens the resume-link form

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
- Back / Skip / Next, with the question's purpose under a closed "Why?" beside them

**Right column:**
- a live blended-margin dial with a neutral track. It has no bands until a reference range exists. Its provenance (derived, the formula, how many facts) is under a closed "How this works".
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

Decluttered 2026-11-09 on the owner's instruction: the panel's legend, the stated-against-measured foot, the footer's basis key and the share card's explanation of what a link shows each sit behind one closed "How this works" disclosure (`components/report/WhyFold.tsx`, a native `<details>`); the derivation sheet (WHY →) and every finding's evidence are unchanged. Section titles state the count only ("3 findings.", "2 recommendations."), and "What would sharpen this" and "Share this report" carry no sub-title.

Structure, top to bottom:

**A plain-language summary** — three sentences, no jargon, stating the single most important thing found.

**Unit economics block:** the numbers as ruled tables, following the number grammar of §2. Every figure carries its basis, source and date as visible text: OBSERVED, DERIVED, ESTIMATED, STATED or ASSUMED, never a confidence percentage. A margin that came from the owner's estimate looks different from one computed from Stripe data, and it says so. STATED is a fifth basis class beside the four in §2: an exact owner answer is neither an estimate nor observed. Figures the data cannot support are listed under "Not computed" with what is missing; nothing is invented to fill a range column.

**Findings**, ordered by severity. Each is a headline, two sentences of detail, and an evidence box listing the specific answers it rests on, each with its basis. Severity is a worded flag (ACT NOW, HIGH, MEDIUM, LOW); colour only tints the word. A finding ScaleX measured itself (the site audit, P5-13) carries "· measured" beside its area: it is a measurement against a stated threshold, not the diagnosis's judgement (site-audit §2).

**Recommendations**, each with its scenario block: the assumptions stated, the base and downside cases, and the break-even condition. Where an assumption is marked high-sensitivity, it is called out inline — *"this depends heavily on your 22% repeat rate; if that's closer to 10%, the case doesn't hold."*

**What would sharpen this** — the top data gaps, each a one-click link back into the intake. This turns the report's weakest point into its best engagement loop: the owner sees exactly what their honesty would buy them.

Recommendations carry two actions — "Look into this" and "Not for us". Declining opens a short reason field, because that reason is the training data for everything the system proposes later. The field is optional but pre-filled with three common reasons as chips, since a required field here produces junk.

**Share this report (idea 51, 2026-10-26).** A card above the report's footer, in the sheet style with no icons. It has a choice of 7 or 30 days, one "Make a link →" action, and the new link shown once in a read-only field with "Copy" (it can't be shown again, since only its hash is kept). Below that is the list of links made: open, expired or revoked, when each was made, when it expires, when it was last opened and how often, and "Revoke" on each open one. Signed out, the card says sign-in is needed. It is left out of print.

The shared view at `/shared/<token>` is the same report body, read only. Its masthead has the business, platform and currency, plus "Shared report · read only". There is no rail, no sub-nav and no link on the wordmark. The recommendations show without the owner's answers or the answer buttons. "Answer now" and "See every weekday" are left out. The footer says it is a shared snapshot, when it was made, and from which report. A dead link of any kind gets one plain sheet: "This link is no longer active."

**Accountant export (idea 49, 2026-10-26).** On `/profile`, the page head's aside holds two plain links: "Money facts, CSV" and "Earlier figures, CSV". They are file downloads, not screens. (The "For your accountant" caption over them was decluttered 2026-11-09 on the owner's instruction.)

### 7.1 Landing page v1 (kept at /landing-v1)

This was the front page until 2026-11-16, when the v2 landing (§7.1b) replaced it on the owner's instruction. It is kept, unchanged, at `/landing-v1` and out of search (`app/landing-v1/page.tsx`).

The owner's landing mockup (HTML export, 2026-10-17) is the source for this page. It is built in `components/marketing/Landing.tsx`, `Walkthrough.tsx`, `StoreChart.tsx` and `Demos.tsx`, with styles in `app/landing.css`. The mockup's own colour values are scoped under `.ll` and apply to the landing page only.

Decluttered 2026-11-09 on the owner's instruction: no hero pill ("A blood test for your business" stays the page title), no section kickers above the headings (the nav names the sections), and no aside beside the chart's heading.

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

### 7.1b Landing page v2 (the front page)

The owner approved a second landing design on 2026-11-15 ("Good, keep going"). It was previewed at `/landing-v2` and became the front page on 2026-11-16 ("Yes, make it the front"); `/landing-v2` now redirects to `/`. Files: `app/page.tsx`, `lib/marketing/landing-v2-prices.ts`, `components/marketing/LandingV2.tsx`, `components/marketing/landing-v2-motion.ts`, `lib/marketing/landing-v2.ts`, `app/landing-v2.css`, and the footage in `public/landing-v2/`.

**The idea.** One filmed scene per section sits fixed behind the page; in front of it, the copy and one ScaleX screen per section, drawn the way the app draws it: the masthead with the mark and the accent rule, then a white paper sheet with square corners, 1px rules, worded flags and the marker behind fresh ink. Unlike a sheet on the desk (§2), a screen here floats over film, so it carries one shadow for depth. This page keeps a kicker above each heading; the 2026-11-09 declutter (§7.1) applies to the first landing page only.

The page, top to bottom:
1. Header: the logo and name in the top-left corner, three anchors, sign in, and the free check.
2. Hero ("Read"): the headline and one line on the left; on the right a product tour of five screens on a loop (Connect, Facts, Diagnosis, Finding, Your yes), with a pointer that approves the last one. The tabs are buttons and jump to a screen.
3. The interview, then the fact sheet ("Learn"): a pointer picks an answer; the fact lands on the sheet with the marker, and a newer answer replaces the older row for the same fact.
4. The diagnosis ("Scan"): five leaks appear as the reader scrolls; the total counts only what has been found so far, and unpriced leaks are counted, never priced.
5. Where the money goes ("Leaks"): one finding with its working shown; approving the pause closes the split bar.
6. Your decision ("Decide"): a decision sheet; approving stamps it and writes a line in the ledger.
7. Measured ("Chart"): sixty daily candles with the slipped-away band; a reading line follows the scroll.
8. The Trust Ladder and the plans ("Trust"): choosing a plan lights the ladder to that step.
9. For accounting firms ("Firms"): the client book arrives A–Z, then sorts itself by money leaking.
10. The free check ("Check"), then questions and the closing call ("Start").

**The first screen** (refined 2026-11-16 on the owner's brief, keeping its direction: the shop film, the editorial headline, the green turn, the floating diagnosis).
- **The headline** runs as two lines, one sentence each; the whole second sentence ("Its numbers might not.") is the green turn. The kicker, "A blood test for your business", sits above it behind a short green rule.
- **One way in.** "Run the free check", carrying its promise in the button ("3 minutes · no account"), and a quieter "See how it works". The reassurance is three short facts: read-only access, no passwords, nothing changes without your yes.
- **The tour opens on the diagnosis**, the money shot. It shows the money at stake first (the priced total, with how many leaks are priced and how many not yet), then one line per finding: its area and severity, a severity bar, and the monthly figure, coloured by kind (a loss, an opportunity, money tied up). The tour's tabs are a quiet step rail, the panel carries "Demo data", and a soft shadow on the scene holds it above the counter. Under reduced motion the tour stands on the diagnosis.
- **On a phone** the copy comes first and the panel follows full-width; the button's promise drops to its own line under the label.

**Footage.** Nine scenes of one fictional ceramics shop: six are 7-second seamless loops (WebM with an MP4 fallback, 1280–1600 px wide, about 120–550 KB each) and three are stills. All of it is AI-generated. The page carries no label for it: the owner had it taken off the screen and then out of the footer (2026-11-16). The fictional store's figures still say "Demo data", and the "Labelled" card speaks of what the AI makes for an owner's business ("Everything the AI makes for your business is labelled as AI-made"), which the product keeps. No person appears, and no text or figure is baked into a frame: every word and number on the page is HTML. A scene's video is fetched only once its section pulls on the scene; before that, and always under reduced motion, the scene is its still frame.

**Motion rules.**
- Scenes are mixed by scroll: each section's pull on the scene falls off with its distance from the middle of the viewport, and layers are painted by their share of the pull, so two scenes cross-fade and never cut. The chart scene pans sideways with the scroll; still scenes drift slowly.
- A screen is revealed top to bottom behind a line of light, then its rows land one after another. While it is away from the middle of the viewport it leans back and fades; at the middle it stands flat. On screens narrower than 900 px nothing leans.
- Besides the footage itself, only the hero tour and the interview demo loop. Everything else moves because the reader scrolled or clicked.
- Reduced motion: no video, no loops, no leaning, no reveal. The tour stands on its last screen, approved; every screen shows its finished state.
- There is no loader, no pop-up over the hero, and no more than two calls to action in any section.

**Words and figures.** The words are the `landingV2` catalogue in all seven languages (a few lines are the first landing's `landing` messages, reused word for word). No figure is typed into a message: the illustrative store's amounts are integer minor units in `lib/marketing/landing-v2.ts`, each derived figure is worked out there from the figures it rests on (the campaign's monthly loss, the price after the rise, the scan's running total, the free-check range), `landing-v2.test.ts` holds the sums, and the component formats them in the reader's language. Plan prices are the price book's (`planPrices`), and the one-off diagnosis is `reportPrice()`; if the book cannot be read the page shows a dash for a plan's price rather than failing.

**Scoping.** Every rule in `app/landing-v2.css` sits under `.lx`, and class names that the app's global styles already use (`act`, `opt`, `stage`, `done`) have their own names here, so the page neither takes nor gives styles.

**Still open, for the owner.** The footer prints `[Company details]` until supplied (as §7.1). 

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
- J / K moves between pending proposals, and A / R / D answer. The keys are not printed on the page (2026-11-15); a screen reader hears them.
- After a decision, the card becomes a thin inline stamp ("APPROVED 14:02"), and focus advances to the next pending card. No overlay. The proposal's id stays in the record, never on the page.
- An unanswered proposal expires as "not approved — nothing ran". The sheet's head says only "Decide by <day>."; the expiry is printed on the item once it happens (decluttered 2026-11-09 on the owner's instruction, which also dropped the list's footnote, the bulk view's two lines restating that each proposal keeps its own record, the phone's "Nothing runs until you approve it." foot, and "You can read everything here." after a role's refusal; the section heads read "What changes" and "Evidence", and the empty queue's explanation of where proposals come from sits under a closed "How this works").

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

### 8.3 One proposal on a phone (idea 53, 2026-10-29)

`/proposals/<id>` is the page a phone alert opens (`components/proposals/ProposalCard.tsx`), a focused view like the queue: the ink masthead ("<business> · Decision", the emergency stop), then one sheet built at 360 px, read top to bottom: the title; WHAT CHANGES (before → after where the action states both, else the title stands); EXPECTED, as the downside-to-upside range in mono ("−€1,200 – +€4,800"), never a point, with "Worst case:" and the downside's money and words under it; REVERSIBLE or IRREVERSIBLE with what to do if you change your mind; CHECKED AGAINST YOUR LIMITS, in the owner's own 13.5 words ("Checked against “never discount”: it doesn't go against it." and "I can't check “…” for you: weigh this against it yourself."), or a sentence saying there was nothing to check it against. Then the queue's answers: the consequence verb ("Approve", "Publish to Instagram") and Decline, equal `.q-btn`s side by side, Decline opening the four reason chips and a sentence box. Both go through `PUT /api/proposals`, the queue's own path. After the answer the card reloads into its closed state, announced politely. A proposal already answered, expired or held back shows a boxed word (APPROVED, DONE, DECLINED, CHANGES REQUESTED, EXPIRED, HELD BACK) and its sentence ("This ran out of time on 12 Nov without a decision: not approved, and nothing ran."), with no buttons, only "Back to the queue →". Signed out, it asks "Sign in to decide." and the sign-in comes back to this card. The alert itself never approves: it has no action button, and this card is the only place a phone says yes.


### Charts on the Decisions screen

Added 2026-11-16 on the owner's instruction. The screen keeps its structure and every word, and gains charts beside what it already says (`components/proposals/QueueCharts.tsx`, `chart-model.ts`). Every chart is worked out from the same data as the words next to it; none shows a figure the words don't.

- **Masthead:** a small ring beside "approved {n} of {m}". The approved share is lit and the rest is coral.
- **The queue ring**, at the top of the side list. It is an arc-reactor ring with one lit cell per item, coloured by list (needs a decision, decided today, held back, earlier), and the total in the core. A legend lists the counts.
- **A value bar on each waiting item.** Every item sits on one shared scale, so the longest bar is the biggest decision. An item without a money range gets a hatched bar that says "no money forecast". The bars are drawn only when all ranges are in one currency.
- **Size of the change**, under the change table, for each wording line with three or more words (a word-level diff: kept, added, removed). Figures such as prices get no chart.
- **When it rolls back by itself**, under the expected effect, for a site change that carries its load at proposal time. It is a bar graph of today's load against the limit from `lib/site/health-rule.ts`: three times the baseline or the baseline plus two seconds, whichever is larger. The engine uses the same rule.
- **What it rests on**, in the evidence. An arc-reactor ring with one cell per evidence line, coloured by basis, with a legend.
- **How this decision is built**, beside it. A tree: the question at the top; under it the facts (with their bases), your rules and any disagreements; under the facts, one box per fact.
- **The way back**, in reversibility, for anything that can be undone: as it is now, then stored, then changed, then one click back. For a site change it adds the automatic rollback past its limit.

The rings turn slowly and their cores pulse; under reduced motion nothing moves. Colour never carries meaning alone: every ring has a legend with counts, and every bar has its value written beside it. On a phone the same charts sit in the one-at-a-time view (the evidence charts inside "Evidence"), and a chart wider than the screen scrolls inside its own box.

---

## 9. Notifications

Your instinct about notification fatigue is correct and it needs an enforced rule, not good intentions.

Three tiers:

**Needs you** — an approval or a blocking question. Push, badge, and it waits. Hard-capped at one push per day; further items batch into the same thread.

**Worth knowing** — a finding, a report, a completed action. In-app only, no push, collected into the three-day digest.

**Everything else** — routine activity. Visible in the log if you look, silent otherwise.

The cap is a product rule, not a preference. If the system ever needs more than one urgent push per day, that is a signal it is proposing too much, and the correct fix is upstream — batching proposals — not more notifications.

**The weekly summary email (idea 42, 2026-10-26).** One email a week to the owner, sent on the Monday beat, so the "worth knowing" tier reaches an owner who doesn't log in. It is the Watching screen's week, sent: what waits for you (proposals, and open support questions as a count, never their words), what I did, what I noticed, your goals, and how approved changes are doing. Every line is a row on record. A quiet week says "A quiet week" and nothing else. The email is plain HTML in the sheet tokens (ink on paper, 1px rules, mono labels, no images, no colour carrying meaning) with the same words in a text part. It has no tracking pixel. Every email carries a one-click "stop these emails" link, which opens a page with one button, like the unsubscribe page. The switch is a "Weekly email" card beside Modules on /settings/alerts (moved from /watch on 2026-11-15), on by default once How I work is decided. The card says plainly when the server can't send email.

**Phone alerts (idea 53, 2026-10-29)** are the "Needs you" tier's push, built from web parts (an installable web app with a manifest, a service worker that only shows pushes and opens cards, and Web Push). The rules are code (`lib/push/plan.ts`): an alert only for a proposal pending and inside its window, never for one held back; nothing while the emergency stop is on; nothing 21:00–08:00 in the business's timezone, held until 08:00; **at most one alert a day per account, as above**, and everything waiting goes in that one ("3 things wait for your yes" opens the queue; "1 thing waits for your yes: a price change" opens its card). The lock screen is public, so the words are a fixed phrase per proposal kind, never the proposal's title: no figure, no name, no contact detail. The switch is a "Phone alerts" card after "Weekly email" on /settings/alerts (moved from /watch on 2026-11-15): what an alert says and doesn't, "Switch on for this device →" (the permission prompt comes from that tap), the devices with their label and dates, each with Remove, and "Send a test →". What an alert says and doesn't sits behind a closed "How this works" disclosure (decluttered 2026-11-09 on the owner's instruction). It says plainly when the server can't send ("its keys aren't set"), when the browser can't, when permission is blocked, and on an iPhone outside the Home Screen app: "Add ScaleX to your Home Screen first, then switch this on there."

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

1. **Product name.** The mockup uses "ScaleX" as a placeholder so the topbar isn't empty. Your call entirely.
2. **Intake length before the first report.** The mockup shows 12 core questions; the bank defines 25 always-asked. Twelve is a better first session and the rest can come after the mode decision — but that means the first report is thinner. Worth deciding deliberately.
3. **Does the owner see the confidence score?** I've exposed provenance per fact but kept the overall score internal. Showing it is more honest; it also invites arguing with the number.
4. **Report delivery.** In-app only, or emailed as a PDF? Emailed reports get forwarded to business partners, which is free distribution — but they leave the product, where the actions are.

---

## 13. Next step

The natural next artifact is the diagnosis report as a designed screen rather than a described one, since it's the deliverable the whole v1 is built to produce and the one that has to justify the subscription. After that, the interviewer agent spec — which is the last piece before v1 is fully designed and buildable.

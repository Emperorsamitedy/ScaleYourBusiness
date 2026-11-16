# Visualisation placement map (visual enhancement, step 2)

**Date:** 2026-11-16
**Reads with:** [`screen-inventory.md`](screen-inventory.md)

## Ground rules for every visual

1. **The look does not change.** Each visual uses the sheet tokens in `app/sheet.css` and the chart grammar already in `app/charts.css`:
   - Marks are ink on the paper sheet. The app's colours are the forest desk and eucalyptus paper, restored on 2026-11-16 at the owner's instruction.
   - Green (`--ok`, `--ok-band`) means good or gained.
   - `--drift` means watch this; `--alarm` means money lost.
   - Filled means measured or up; hollow means stated or down; a dashed outline on the green band means an estimate.
   - No new colour, no cobalt, no gradients, no glow, no rounded cards, no icons.
2. **Same fonts and sizes.** Zilla Slab titles, Archivo prose, IBM Plex Mono labels and figures, at the sizes the screens already use.
3. **Plain SVG and CSS**, as the existing charts are. No chart library is added.
4. **A visual draws what the screen already knows**, from the same API data. It never invents a figure. Where data is missing, the visual is not drawn and the screen's existing words stay.
5. **Words stay available.** A chart replaces the reading, not the record: detail moves behind the existing folds, it is not deleted.
6. **Every chart has** a summary sentence as its accessible name, a visually hidden table of its values, exact values on hover and keyboard focus, and no horizontal page scroll at 375 px.
7. **Motion:** only the existing `--d-press` and `--d-move` transitions, off under reduced motion. Nothing loops.
8. **Nothing bypasses approval.** A visual may link to the Decisions screen. It never approves, sends or executes anything itself.
9. **Spec in the same change.** `specs/ux-spec-v1.md` §2.1 says no chart is added to the report or to Goals. That section is updated alongside the code, since the owner has now asked for these.

## Shared pieces (built once, reused)

| Piece               | What it is                                                                          | Used by                                        |
| ------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------- |
| `Spark`             | A small ink line of a daily series with the last point marked; optional tinted span | Home, Watching                                 |
| `SegBar`            | One stacked bar; segments are buttons when they filter something                    | Customers, History, Shadow, Report, Fact sheet |
| `HBars`             | Sorted horizontal bars with a figure at the end and an optional reference tick      | Report, Reviews, Support, Carts, Statement     |
| `Funnel`            | Stages as shrinking bars with the step-to-step share                                | Carts, Pipeline, Customers segments            |
| `Dumbbell`          | Two marks on one scale joined by a line (hollow = stated, filled = measured)        | Report, Benchmarks                             |
| `Bullet`            | Start → target band, a path tick, and a "now" mark                                  | Goals, Billing, Content goals                  |
| `RangeBar` (exists) | Low–high band with a value tick                                                     | Report, Proposal card                          |
| `Steps`             | Connected nodes for a process, with a state per node                                | Proposal card, Payments, Content               |

## Priority 1: built (2026-11-16)

All eleven screens below are in the code and were checked in the running app against the Fernhill demo, except where noted:

- `/reviews`: Fernhill has no reviews, so the star spread was only checked by its unit test.
- `/shadow` and the statement's worth bars: checked by unit test only; Fernhill has no closed shadow outcomes or verified money yet.
- The report's break-even bullet (item c) is not built: the report does not carry a measured monthly order count beside the break-even figure.

### `/home` — Today

|                      |                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing information | Readings strip (waiting, cash today, lowest point, watch day), decision rows, candle chart                                                                                                                                                                                                                                          |
| Proposed visuals     | (a) A **30-day spark** under each reading that has a daily series: revenue a day and orders a day. (b) A **"Where the money is" bar**: the leak components the chart model already prices (ads that lose money, on the table, slow stock, revenue dips), each in its basis mark, stock shown apart because it is not a monthly flow |
| Why here             | Home answers "what needs me today". The components exist in `/api/charts` but sit folded under the candle chart                                                                                                                                                                                                                     |
| Data required        | `/api/charts` → `market.days`, `market.components` (already fetched by Home)                                                                                                                                                                                                                                                        |
| Interactions         | Hover or focus a spark for the day's figure; each money block links to the screen that owns it (Decisions, Stock, Fact sheet)                                                                                                                                                                                                       |
| Expected benefit     | The owner sees direction and the size of each leak without opening a fold                                                                                                                                                                                                                                                           |

### `/report` — Diagnosis

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing information | Model-written summary, measures table, findings as paragraphs, recommendations with three cases in words, stated vs measured table                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Proposed visuals     | (a) **Severity bar** in the head: findings by severity, each segment jumping to its first finding. (b) **Margin by product bars**: each offer's margin, sorted, with price and cost on hover. (c) **Break-even bullet**: break-even volume against measured monthly orders, where both exist. (d) **Recommendation range bar**: downside, base and upside per month on one scale, replacing the three-row case table as the first thing read (the table stays in the fold). (e) **Stated vs measured dumbbell**: hollow mark = what you said, filled = what was measured |
| Why here             | This is the most text-heavy owner screen, and all five visuals draw the report's own dated snapshot, so they cannot contradict its date                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Data required        | `/api/report` → `economics.offers`, `break_even`, `stated_vs_measured`, `findings[].severity`, `recommendations[].scenario`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Interactions         | Segment click scrolls to the finding; bar hover shows price, cost, margin; the existing Why panel still opens from every row                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Expected benefit     | Which product earns least, how far past break-even, and what each recommendation is worth are read from one glance each                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Risk                 | The body is shared with the public shared report: money visuals follow the existing grade gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### `/watch` — Watching

|                      |                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing information | Signals table: "€1,817 → €2,235" as text                                                                                                       |
| Proposed visuals     | A **spark per signal** in the table row, the open anomaly's days tinted                                                                        |
| Why here             | The row already states first week and now; the daily shape is the missing part                                                                 |
| Data required        | The daily values the loader already holds (`lib/watch/signals.ts`), passed through `/api/watch` as a short series. Read-only, no schema change |
| Interactions         | Hover or focus for a day's value                                                                                                               |
| Expected benefit     | "Steady" and "drifting" become visible, not just worded                                                                                        |

### `/customers` — Customers

|                      |                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------- |
| Existing information | Lifecycle filter chips with counts                                                                   |
| Proposed visuals     | A **lifecycle bar** above the list: active, new, lapsing, gone quiet, no history, in proportion      |
| Why here             | The counts are already on screen as chips; the bar shows the proportions and does the same filtering |
| Data required        | The lifecycle counts already loaded                                                                  |
| Interactions         | Clicking a segment sets the existing filter (the chips stay)                                         |
| Expected benefit     | The share that has gone quiet is seen, not calculated                                                |

### `/carts` — Abandoned carts

|                      |                                                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing information | Sentence-built paragraphs; products table                                                                                                           |
| Proposed visuals     | (a) **Checkout funnel**: started → left → recovered, this period beside the prior one. (b) **Products by value left** as bars in the existing table |
| Why here             | The screen's whole subject is a funnel, currently written as prose                                                                                  |
| Data required        | `/api/carts` → window stats (current, prior), products                                                                                              |
| Interactions         | Hover for counts and shares                                                                                                                         |
| Expected benefit     | Where shoppers drop, and which product they leave, at a glance                                                                                      |

### `/progress` — Goals

|                      |                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Existing information | Now / path says / target as three figures; weekly candles                                                                 |
| Proposed visuals     | A **goal bullet** above each goal's figures: baseline to target, a tick where the path says you should be, a mark for now |
| Why here             | Three figures side by side have to be compared in the head; one bar does it                                               |
| Data required        | Already in the goal chart model (`baseline`, `path_now_per_30d`, `target_per_30d`, `now.per_30d`)                         |
| Interactions         | Hover for the three figures. The "too early to judge" wording stays                                                       |
| Expected benefit     | Ahead or behind is read from position                                                                                     |

### `/history`, `/shadow`, `/statement`

|                      |                                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing information | Counts and money as lists and bullet sentences                                                                                                                                                                                                                             |
| Proposed visuals     | **History:** a track-record bar (forecasts inside, above, below, can't tell, waiting). **Shadow:** an outcome bar (gained, nothing, lost, unproven, open). **Statement:** a verified-gains → losses → fee → net waterfall, per currency, only where the grade allows money |
| Why here             | Each screen is a tally; a tally is a stacked bar                                                                                                                                                                                                                           |
| Data required        | Already loaded by each screen                                                                                                                                                                                                                                              |
| Interactions         | Hover for counts; History segments set the existing filter where one matches                                                                                                                                                                                               |
| Expected benefit     | The record's shape is seen in one line                                                                                                                                                                                                                                     |

### `/reviews`

|                      |                                                                             |
| -------------------- | --------------------------------------------------------------------------- |
| Existing information | Stars written as words per review                                           |
| Proposed visuals     | A **star spread**: five bars, one per star, counted from the reviews listed |
| Why here             | An owner's first question is "how many bad ones"                            |
| Data required        | The review list already loaded (`stars`)                                    |
| Interactions         | Clicking a bar filters the list to that rating                              |
| Expected benefit     | The balance of ratings without reading the list                             |

## Priority 2: built (2026-11-16)

| Screen                 | What was built                                                                                    | Checked in the app                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `/content`             | Gallery of items that hold media, with real thumbnails; calendar strip; per-post performance bars | Tests only: the demo holds no media or dated items                               |
| `/simulate`            | The ads chart (spend against attributed value per campaign) above the simulator                   | Tests only                                                                       |
| `/support`             | Tickets by standing; waiting tickets as bars against the reply time; answer clusters by size      | Yes                                                                              |
| `/pipeline`            | Stage funnel; open against likely-to-close where the screen does not refuse                       | Built, not shipped yet: waits for the pipeline follow-up work on the same screen |
| `/stock`               | Days of cover against delivery time; cash tied up as bars                                         | Yes                                                                              |
| `/patterns`            | Month bars against the normal week; pairs by how often they sold together                         | Yes                                                                              |
| `/ladder`              | Gains and losses as a small bar per row                                                           | Tests only                                                                       |
| `/billing`             | Guarantee bullet: verified money against three times the fee                                      | Tests only                                                                       |
| `/profile`             | Facts by basis as one bar                                                                         | Yes                                                                              |
| `/benchmarks`          | Eurostat lines as benchmark-against-yours marks; the peers panel's middle-half strip              | Yes (the peer strip needs enough peers)                                          |
| `/check`, `/e/[token]` | Leak range band and peer strip                                                                    | Tests only                                                                       |

Left out on purpose:

- **Goal bullets on `/content`:** the goals there carry a target and a start, but no current figure.
- **Completeness on `/profile`:** the figure is not printed on that screen.
- **Pricing what-if bars:** the screen already draws each price step's range.

## Priority 3: not built yet

| Screen            | Visual                                                                       | Note                               |
| ----------------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| `/proposals/[id]` | Range bar for the gain; a steps line (drafted → approved → runs → read back) |                                    |
| `/site`           | Purchase path as steps; PageSpeed mobile against desktop bars                | The "never" lines stay visible     |
| `/connections`    | A status grid: one tile per source with freshness and history days           | Write consent stays its own screen |
| `/payments`       | Stage steps with counts                                                      | Safety warnings stay as text       |
| `/chat`           | A small chart inside an answer that cites a series                           | Larger change; scoped separately   |
| `/statement`      | The worth figures as a stepped waterfall, as in the reference design         | Bars today                         |

## Asked for, with no data behind it yet

The owner's instruction (2026-11-16) is that every visual in the brief has a place in the system. Each of these is to be built in the screen named, drawing itself when its data exists and otherwise showing a short empty state that says what is missing. None shows an invented figure.

| Requested                                    | Where it goes                  | What is missing today                                                                                                                       |
| -------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Profit and expense trend lines               | `/report`, beside the measures | Profit and expenses are derived once per report. A line needs two or more reports, which the `prior` report already gives a first point for |
| Revenue-leak waterfall                       | `/home` and `/statement`       | No "potential revenue" figure exists. The priced leaks are drawn as "Where it slips" on Home now                                            |
| Reach → visitors → leads → customers funnel  | `/customers`                   | Website visits, checkouts and orders exist; people reached and leads are not recorded                                                       |
| Cohort retention heatmap; lifetime value     | `/customers`                   | No cohort table. The order history per contact could build one                                                                              |
| Campaign impressions, clicks, CTR, CPC       | `/simulate` campaign cards     | Not collected (clicks exist for Google only). The connectors would need to read these fields: read-only, no new permission                  |
| Marketing attribution                        | `/content`                     | No path data linking a customer to channels                                                                                                 |
| Likes, shares, saves; video retention curves | `/content` gallery             | One "interactions" total per post; no retention data                                                                                        |
| Confidence on insights                       | `/report` findings             | Shown as the basis word today. A gauge needs a confidence figure the analysis stands behind                                                 |
| Before-and-after charts for executed actions | `/history`                     | Drawn from readbacks; Fernhill's demo has none closed yet                                                                                   |

## Higgsfield

The owner allows up to 15 credits and set its use on 2026-11-16: Higgsfield designs what a realistic visual looks like, and the code rebuilds that look on live data. A generated picture is never placed in the app as a chart.

- **Spent so far: 0.25 credits**, one reference design (`gpt_image_2_6`, 16:9): readings with trend charts, margin by product, and a waterfall.
- **Taken from it into the kit:** labelled scales with round-number ticks, dotted gridlines, the pale green fill under an ink line, the marked last reading, thick bars on a ruled scale, and the named reference line.
- **Not taken:** the waterfall's figures, which the image model invented.

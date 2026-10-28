# TASKS-PHASE5.md — Sales, finance, inventory

Commit-sized tasks in strict order within each session. Reference the task ID in each commit message.

**Scope: Phase 5 only.** SYB starts running the parts of the business behind the storefront:

- stock (what runs out, and when);
- cash (when money gets tight);
- the website as a customer meets it (speed, mobile, the path to buying);
- a sales pipeline for businesses that sell to other businesses;
- staff planning at the level of roles.

Build-sequence Part 7 (steps 88–93) is the skeleton.

**Gate status, recorded honestly:** build-sequence Part 7 is marked **"Directional"**, and Gate 2 has not run. **The owner opened Phase 5 on 2026-10-27 ("lets go ahead")**, in reply to "say open Phase 5 and I'll start with stock-out warnings and cash flow". This is the same deliberate override as P0-86 and the openings of Phases 2, 3 and 4; nobody should later mistake it for the gates having been met. Phase 3's Session D real writes and Gate 2 continue on their own track.

**What Phase 5 is NOT:**

- **Phone AI** (step 87 says skip it: a separate engineering project).
- **Purchasing.** SYB never places a supplier order.
- **Moving money.** SYB never pays, transfers or collects anything.
- **Write access** to an accounting or banking system.
- **Judging individual people.** No performance scoring, ranking or decision about a named person.
- **Subscription billing** beyond the existing report gate.

If a task seems to need one of these, stop and ask.

---

## Non-negotiables inherited, plus six new ones

Rules 1–24 apply unchanged. In particular:

- rule 12 (nothing executes without a recorded approval) covers every suggestion this phase makes;
- rule 22 (erasable PII) covers pipeline contacts;
- rule 18 (money surfaces untouchable) covers cash flow absolutely.

New for Phase 5:

**25. A forecast says what it is built on, and refuses when it has too little.** Every forecast in this phase states:

- its history window and its sources;
- a low–high range, never a single point;
- what is ASSUMED, by name.

Below a stated minimum of history it says how much there is, what it can and can't say, and when it will be ready. It never borrows industry averages and presents them as the owner's own.

**26. Finance is read and modelled, never moved.** Cash flow reads what the connectors already read (rule 9's read scopes) and what the owner states.

- No payment, transfer, payout or invoice action exists anywhere in this phase's code paths.
- No accounting or bank connection with a write scope.
- A build-failing test asserts it, beside rule 18's.
- Cash figures are planning aids for the owner, never investment or lending advice, and the screen says so.

**27. Stock suggestions stop at the owner.** A reorder or a stock note is a proposal or a warning. SYB never places, edits or cancels a supplier order. Reorder quantities come from the owner's own sales, lead times and minimum order quantities, shown with their arithmetic (rule 6).

**28. Staff planning is about roles, never people.** The team module is **off by default**, and switched on per business by the owner.

- It works only at the level of roles and hours: "Saturday 10:00–14:00 needs a second teacher".
- It never scores, ranks, compares or recommends anything about a named individual (GDPR Article 22).
- Names, if present, are never inputs to any calculation, and a test asserts it.

**29. Pipeline contacts are contacts.** B2B leads and deals live under Phase 4's rules: erasable PII (22), consent-gated outbound (23), and content-never-instructions (24). A follow-up email is a drafted proposal, never an automatic send. Deal values are `Money` (rule 1) and estimated values carry provenance (rule 2).

**30. The site audit reads like a visitor and never acts like a buyer.** It fetches public pages and asks a public page-speed service about them. It never:

- logs in;
- submits a form;
- adds to a cart past what a page's own links do;
- places an order.

Checkout is measured from the outside and reported with instructions (site-audit spec §4: checkout is never changed automatically).

---

## Session A — Stock: what runs out, and when _(~2 wks)_

Steps 88 and 91 (the stock half).

- [x] **P5-01** Two-window sell-through. From the inventory reads and the order baskets that already exist (`lib/stock`, `order_baskets`), compare the last N days with the N before, per product: units sold, the change between windows, and its noise band. The window A / window B comparison of step 88 is pure, deterministic and tested.
  - **Built** (`lib/stock/cover.ts` `sellThrough`): N = 28 days ending yesterday, against the 28 before. The noise band is 2√(A + B), since the difference of two Poisson counts has variance A + B; a change inside it is "about the same — within chance (±N)", outside it "up" or "down" with the percent. Under 56 measured days it refuses with the days there are and the day it will be ready; a stock file has one window and says so.
- [x] **P5-02** Days of cover and stock-out warnings.
  - **Days of cover** is stock on hand ÷ the recent daily sales rate, as a range.
  - **The warning** fires when cover falls below the supplier's lead time (1.4.1.3 "delivery time in days", else a stated default marked ASSUMED). It reads "the blue mug runs out in about 6–9 days; your clay supplier takes 7".
  - **Where it goes:** the warnings land in the watch log and the weekly summary.
  - **Built** (`lib/stock/cover.ts`, `cover-load.ts`, `warnings.ts`). The rate is the last 28 days' units ± one standard deviation (√count); cover is on hand over it, counted from the day the stock was read, so it is always a low–high range and never collapses to one day. The delivery time is the longest stated "Delivery time in days" among the suppliers the owner named for the matched offer (an item can't be restocked before its slowest input), with that supplier's minimum order and the fact it came from; else 14 days, ASSUMED, saying why (unmatched item, no supplier, no time on file). The warning fires when cover's low end is under the delivery time: ACT NOW when even the high end is, RUNNING LOW otherwise. Under 28 measured days: TOO EARLY, with the ready date. Every result states its window and sources and lists what is ASSUMED (rule 25). **Conservative call:** a sold-out item shows as SOLD OUT and is never warned or reordered, since the shop already shows it, a planned sell-out (Fernhill's monthly Seconds Box) looks identical, and SYB can't see what is on order. Warnings land in `watch_activity` as `stock_warning`, one row per item, level and ISO week, for every business in care, watched or not (watching forbids proposing, not noticing), with the figures in `meta`. The weekly cron logs them before the summary, and the summary lists each item's latest under **Running low** with a link to `/stock`.
- [x] **P5-03** Reorder suggestions as proposals (rule 27).
  - **Quantity:** sales over lead time + a safety margin, rounded up to the supplier's minimum order quantity, with its arithmetic shown.
  - **It's a note, not an order:** the action is `stock_reorder_note`, which the engine leaves unrouted. Approving it records the owner's intent and nothing else.
  - **Guards:** hard limits and suppression apply.
  - **Built** (`lib/stock/reorder.ts`). Quantity = units over the delivery time at the fast end of the rate, so the safety margin is the gap to the middle (from the owner's own sales, never a pinned share), with any busy stretch counted for its days; then rounded up to the supplier's minimum order, with the arithmetic in words and the cost at the item's own unit cost (integer minor units, its currency). `stock_reorder_note` sits in a new `NOTE_KINDS` beside `ACTION_KINDS`, not in it, so the diagnosis classifier and alert review can never emit one. It passes `checkHardLimits` (manual limits ride along; no 13.5 code forbids it today) and suppression (three declines), and is held before care and while watching (rule 15). One per item per month (the 0053 stock index), 14-day expiry, reversibility easy. Approved and due, the runner leaves it unroutable with no execution row (tested). `rule27.test.ts` fails the build if anything in `lib/stock` gains a fetch, an executor or provider import, a URL or an order operation, or if any execution provider declares one. No migration.
- [x] **P5-04** The busy season feeds stock (closes I-46a's stock half). An approaching busy stretch from `lib/seasons` raises cover targets for that period, and says so: "last year this stretch ran 1.7× normal".
  - **Built** (`seasonBoost`): the forecast's first busy stretch ahead or under way, its index set against the business's last four complete weeks so the recent rate isn't counted twice, never below 1×, as a low–mid–high multiple from the stretch's own range. Cover and the reorder walk it piecewise, for the stretch's days only; the warning adds "That counts your busy stretch from …", and the item following the business's own season is listed as ASSUMED. With the forecast refusing (under 50 of 52 weeks), nothing is raised and the screen says why.
- [x] **P5-05** The `/stock` screen gains the cover column, the warnings and the reorder notes (sheet design system). The demo seed shows one product nearing a stock-out.
  - **Built** (`components/stock/StockScreen.tsx`, `/api/stock` `cover` block and `{action:"reorder"}`; ux-spec §3 "Stock"). The screen is now "Insights · Stock" (menu "Stock"); its head is the soonest stock-out. The demo seed's stock is retuned so only the Speckled Everyday Mug (90 on hand, about 15 a day, Midland Clay's 10 days) runs short, even at the fast end of Christmas; plate, vase and pour-over set hold more. The seed logs the warning into Fernhill's watch log. Fernhill is still watched, so its reorder note is shown with its arithmetic and held (rule 15), never proposed.

## Session B — Cash flow: when money gets tight _(~3 wks)_

Step 89.

- [x] **P5-06** Two bank questions (bank version bump; `lint_bank.py` passes):
  - "Roughly how much cash does the business have available today?" (Money);
  - "What's the least you'd want in the account at any time?" (Money, the buffer).

  Both are `Field<Money>` with provenance, and "I don't know" is allowed (rule 5).

  _Done 2026-10-28: bank 1.8.0, 5.3e `costs.cash_available` (asked under 5.3b's condition, money coming in) and 5.3f `costs.cash_buffer` (asked once 5.3e has a value); data conditions only, DB-tested through the resolver; lint_bank and db:seed pass._

- [x] **P5-07** The 13-week cash model (pure, rule 25). It starts from the stated cash, or from Stripe balance transactions where connected.
  - **Money in:** the business's own weekly revenue pattern, with `lib/seasons` where a year of history exists, as a range. Payout timing comes from the payment provider answer.
  - **Money out:**
    - fixed costs by their stated frequency (5.1);
    - per-unit costs × expected volume (5.2);
    - debt (5.3c) where a repayment is stated.
  - **Currency:** amounts are integer minor units per currency, never mixed (rule 1).
  - _Done: `lib/cash/model.ts` (pure), `payout.ts` (ASSUMED payout table), `inputs.ts` + `load.ts` (read-only). Starts from stated cash only; Stripe/Shopify balance transactions give the sales series and the in-transit days, not a bank balance. Refuses under 8 complete weeks of the last 13. Exactly one year of history spans last year's week and the recent range (growth can't be separated). Debt counts only via 5.1 `loan_payments` rows._
- [x] **P5-08** "Money gets tight" warnings: the first week whose low end dips under the buffer, with the reason, e.g. "quarterly VAT and a quiet February". They go to the watch log and the weekly summary, never a push to act. _Done: `lib/cash/warnings.ts`; watch kind `cash_warning` (logged on appear/move/clear), in NOTED_KINDS so the summary carries it; push words tested out._
- [x] **P5-09** Scenarios, side by side, in the campaign simulator's pattern: a slow month (−x%), a big order (+€y in week n), a hire (+€z a month), a price change (taken from what-if pricing). Pure, with a range per scenario. _Done: `lib/cash/scenarios.ts`; defaults from the business's own numbers (a typical week, the largest stated salary, what-if pricing's first step); a missing figure is a named MISSING cell._
- [x] **P5-10** The `/cash` screen (under Insights): the 13-week chart from the chart family, with its range band, the buffer line, the warnings and the scenarios.
  - **Notes:** a "planning aid, not financial advice" note and the sources line, always shown.
  - **Gate test:** rule 26's build-failing test asserts no money-moving op, path or scope exists in `lib/cash`.
  - _Done: `/cash` under Insights (nav + size-features row), `components/charts/CashChart.tsx`, `GET /api/cash` only, `lib/cash/fence.test.ts` (scans lib/cash, the route, the screen and the chart; planted failing cases). The demo seed (Fernhill) states cash and a €6,000 buffer read off its own forecast, so it always shows a tight week._

## Session C — The website as a customer meets it _(~2 wks)_

Step 90. The site-audit spec's Tier 1, without running browsers ourselves.

- [x] **P5-11** Page speed and mobile, from Google's public PageSpeed Insights API (read-only; `PAGESPEED_API_KEY` needed for speed — see the verify note below — and the screen says when it's missing).
  - **Pages:** the home page and up to four key pages (a product, a service, the cart or booking entry, contact).
  - **Measures:** LCP, CLS, INP (field data where available), page weight, tap targets and contrast, at mobile and desktop.
  - **Storage:** results are kept as observations with provenance. A fake serves tests.
- [x] **P5-12** The path to buying, walked by reading pages (rule 30): clicks from home to checkout or booking entry, price visible on the first screen, the form-field count on contact and booking forms, broken links. Nothing is submitted.
- [x] **P5-13** Findings feed the report. Each is a `SiteFinding` (spec §2), `kind: "measured"`, with a severity from stated thresholds. A rule-of-thumb € figure is shown only where the owner's own conversion and traffic exist, otherwise "not computed". `/site` shows the audit beside its existing before/after wording.

**Status 2026-10-27 (P5-11..13):** built against fakes, in `lib/site/audit/`. Migration **0064** (`site_audits`; renumbered from 0063 at merge). No model call anywhere, no network in tests.

- **P5-11:** `pagespeed.ts` sends a GET to `runPagespeed` and nothing else (the type admits only GET). The `PAGESPEED_API_KEY` (`lib/env.ts`, `.env.example`) goes in the `X-Goog-Api-Key` header, never a URL. It is in `RESEARCH_SOURCE_REGISTRY` with no scope, under the scope audit. Field data (CrUX p75 LCP/CLS/INP, CLS ×100 undone, `origin_fallback` kept) stays apart from lab data (LCP, CLS, TBT as INP's stand-in, bytes, score, contrast and tap-target failures). Every result carries its provenance (measured_at, Lighthouse version, final URL, keyed or shared quota). Pages are the home page plus up to four key pages from the site's own links (product, service, cart or booking, contact; a category fills a gap), at mobile and desktop, phones first. The cap is **20 calls per site (origin) per rolling 7 days**, counted from `site_audits.pagespeed_calls` with retries included. Each call gets 2 attempts, 3 run at once, with a 90 s timeout. Each run logs a `site_audit` line with the account id. `/site` says when the shared keyless quota was used and when the week's calls return. `pagespeed-fake.ts` serves tests and the demo.
- **P5-12:** `links.ts` classifies a link before it is followed. Login and account pages, cart action links (`/cart/add`, `?add-to-cart=`) and checkout are refused by name, and a hosted booking page (Fresha, Calendly, …) counts as the entry and is not read. `walk.ts` reads through the guarded GET-only fetcher (no cookies): 12 pages, 4 clicks deep, then 15 link checks. Its measures:
  - clicks from home to the checkout entry (product + Add to cart + checkout, the last step ASSUMED and said) or to the booking entry;
  - a price on the first screen (stated heuristic: the first 600 characters of the page's own text after header and nav);
  - field counts on contact and booking forms (search and cart forms skipped);
  - broken same-origin links.

  The build gate (`audit.test.ts`) scans every source in `lib/site/audit` for a write verb, a method other than GET, or a `key=` in a URL. It also checks that `lib/site/fetch.ts` sets no method, and at run time that the walk never asked for a login, cart action or checkout URL or another origin.

- **P5-13:** `findings.ts` turns the measurements into `SiteFinding`s (`kind: "measured"`, `screenshot: null`), with severity from `SITE_THRESHOLDS`, tested at the boundaries. The vitals use Google's bands (phone poor → high, phone needs-improvement or computer poor → medium); TBT is capped at medium as a stand-in. SYB's own lines: page weight >3 MB medium and >6 MB high, failures 5+ medium, clicks shop ≤4 / booking ≤2 fine, form 6+ fields medium and 9+ high, a broken link on the path high. The € figure sits only on the slow-mobile-load finding, only from the owner's own `presence.monthly_sessions`, `revenue.order_count_monthly` and `revenue.monthly_revenue` (measured or stated). It is a monthly range with its formula, window and sources. The 1–4% of orders per second over 2.5 s (at most 3 s) is named ASSUMED, as a rule of thumb that isn't theirs. Without those figures it reads "not computed" with what is missing (rule 25). The run writes `presence.site_audit` (web_research, naming the audit id). `generateReport` adds up to four medium+ site findings to the findings list, severest first, marked `kind: "measured"` and citing that fact, from the audit the snapshot names. The report shows "· measured" beside the area. `/site` has a **Measured** tab beside the wording changes (`components/site/SiteAuditSheet.tsx`), and `POST /api/site/audit` runs it (signed in, same-origin, maxDuration 300). The demo seed's Fernhill runs it from the fakes on day 2: 7 findings, 4 clicks to checkout, a broken `/collections/gifts`, and the € line from its measured connectors. That is after the 21-day-old report, so the report's hand-written recommendation indices stay valid; the next report carries them.
- **Not built (said on screen):** the spec's judged layer (screenshots, a vision model). Tests: `audit.test.ts` 28, `service.test.ts` 6.
- **Browser walk:** not completed. Sibling dev servers on `localhost` share the session cookie across ports, so the demo sign-in kept being replaced, and the check was dropped when the pane hung. Walk `/site` → Measured once alone on the box.
- **Conservative calls, owner to confirm:**
  - checkout and hosted booking pages are never sent to PageSpeed either;
  - external links aren't checked for breakage;
  - the cap is per origin, not per business;
  - one run per business per hour;
  - a model finding citing `presence.site_audit` isn't de-duplicated against the measured ones (P1-24: the model's output is never quietly dropped).

### Verify at build — Session C (2026-10-27)

P5-11, from PageSpeed Insights v5 as remembered, since no docs were read and no key exists yet:

- **Key in a header:** that `X-Goog-Api-Key` is honoured by `runPagespeed` (the documented form is the `key` query parameter, which SYB refuses to use so the key never sits in a URL or a log).
- **Categories:** that lowercase `category=performance&category=accessibility` is accepted (the docs show the enum in capitals).
- **Field data:** the `loadingExperience.metrics` keys (`LARGEST_CONTENTFUL_PAINT_MS`, `CUMULATIVE_LAYOUT_SHIFT_SCORE` reported ×100, `INTERACTION_TO_NEXT_PAINT` or the older `EXPERIMENTAL_` name), `category` values `FAST`/`AVERAGE`/`SLOW`, and `origin_fallback`.
- **Lab audits:** the ids `largest-contentful-paint`, `cumulative-layout-shift`, `total-blocking-time`, `total-byte-weight`, `color-contrast`, and which tap-target audit the current Lighthouse runs (`target-size` in accessibility; the old `tap-targets` SEO audit may be gone). A null score is read as "didn't run", not zero.
- **Errors:** that a page Lighthouse can't load returns 400 with `FAILED_DOCUMENT_REQUEST`-style text, or 200 with `lighthouseResult.runtimeError`; that the quota answer is 429; that a bad key is 400 or 403.
- **Quota and time:** ~~the keyless quota's size~~ — **checked 2026-10-28: zero.** Every keyless call answers 429 "Quota exceeded … limit value 0", so the audit now asks Google nothing without a key, says a free key is needed, and still walks the path (`NO_KEY_NOTE`, tested). Still to check with a key: the keyed per-minute and per-day quota, and a typical call's duration. The 90 s timeout, 3 at once and `maxDuration = 300` assume about 20–40 s a call. Check the route fits the Vercel plan's function limit, or move the run to `after()` and the cron.

## Session D — Sales pipeline for B2B _(~2 wks)_

Step 92. Shown only when 6.1a is `b2b` or `both`; branching lives in data (rule 4).

- [x] **P5-14** Deals. A `deals` table:
  - **Who:** contact or company (Phase 4 contacts);
  - **Stage:** the bank's vocabulary; lead → qualified → proposal sent → won / lost;
  - **Value:** `Money`;
  - **Plus:** expected close, next step and its date, provenance;
  - **Erasure:** with the contact (rule 29).
- [x] **P5-15** Pipeline maths (pure): weighted value as a range from the business's own win rate (stated or measured), stage ageing, and stale deals (no next step, or a next step past its date).
- [x] **P5-16** Follow-ups as drafted proposals: "Nobody has spoken to Café Nua in 23 days". A follow-up email is drafted in the owner's voice and goes through consent (rule 23) and the approval queue; nothing is sent automatically.
- [x] **P5-17** The `/pipeline` screen: stages as columns, deals with value and age, the stale list, and import from CSV with the same attestation as contacts (P4-03).

**Status 2026-10-28:** Built and ticked in six commits, every rule a test with a passing and a failing case (41 tests across five files). Fixture-proven only: no real follow-up has been drafted by a live model.

- **Bank 1.9.0 (the bank route, chosen over stages in code):** vocabulary `deal_stage` (lead, qualified, proposal_sent, won, lost) and question 6.1f `customers.win_rate` ("Of the deals you go after with other businesses, roughly what percentage do you win?", 0–100, unknown allowed, deep), asked under 6.1e's condition (`customers.type neq b2c`). Pins moved to 160 questions / 57 vocabularies with Session B merged. Production needs `db:seed`. Session B's P5-06 also bumps the bank, so this became 1.9.0 at merge.
- **P5-14, deals (migration 0063):** `deals`, `deal_events` and `deal_followups`, and the `deal_stage` enum. A test holds the code, the enum and the bank's vocabulary equal.
  - A deal is with a Phase 4 contact (`contact_id` NOT NULL, ON DELETE CASCADE). An existing contact is linked and keeps its consent. A new one is created through `addContact` as `unsure` ("a sales conversation is not marketing consent"). A suppressed address is refused.
  - Value is integer minor units + currency + basis (`quoted` / `estimated`), all or none by a check.
  - Every change writes a `deal_events` row with the old and the new value. The same stage twice is refused. Won and lost set `closed_at`; reopening clears it.
  - Erasing the contact cascades through the deal, its events and its drafted follow-up. The test proves every earlier decision-log entry is unchanged, the only new one is the erasure, and none holds the deal's words.
- **P5-15, maths (pure, `lib/pipeline/maths.ts`):**
  - The win rate is measured once 5 deals have closed in the last 365 days (a 90% Wilson range). Otherwise it is the owner's 6.1f answer ±10 points, named as their estimate. Otherwise there is none, and the weighted value refuses: it says what it can and can't say, and when it will be ready. It never borrows an average (rule 25).
  - The weighted value is per currency, never mixed, and names its window, its sources and its ASSUMED lines, including "one rate whatever the stage".
  - Stage ageing and staleness are boundary-tested.
- **P5-16, follow-ups (`lib/pipeline/followups.ts`):** module `pipeline`, kind `deal_followup` (added to ACTION_KINDS; no limit forbids it).
  - A follow-up is proposed for a stale deal only when its contact passes `canEmailForMarketing` (rule 23, applied conservatively to a sales email). The check runs again at drafting. Once per deal per month, five a run.
  - It goes through the watch, the 6.4b posture, the hard limits and P3-28 suppression.
  - The proposal holds ids only and says nothing sends. The kind has no executor, so the due runner leaves it approved.
  - Drafting is the owner's click: Sonnet through `draftItem` (voice card, disclosure by code), metered as workload `pipeline_followup` (`draftLlmFor`). The brief names no one: only the stage and the days. The greeting is a `{{name}}` slot the screen fills.
  - Caps are checked before the call: one draft per proposal, 30 a month, €2 a month.
- **P5-17, the screen and import:**
  - `/pipeline` sits under Customers. Its menu item shows only when `PIPELINE_APPLIES` holds, carried by `/api/nav`. The API refuses every write otherwise.
  - Import (`lib/pipeline/import.ts`) takes P4-03's attestation. Unreadable cells are counted, never guessed. Values are estimates unless the owner says quotes. The same file twice adds nothing. One `import` log entry per batch.
- **Demo seed:** Fernhill (6.1a "both") gets 11 trade deals. Nine come through the import and two through `addDeal`. Five are open, three of them stale; six are closed, so the win rate is measured at 50% (22–78%) beside the stated 35%.
  - Checked against the local dev server with a signed-in demo session over HTTP. `/pipeline` returns 200, `/api/nav` says `pipeline: true`, and `/api/pipeline` returns the board, three stale deals and the weighted €5,885–€20,715 of €26,600. "Propose follow-ups" answers with the watch's refusal (until 2026-11-05).
  - The browser pane couldn't be used for a visual walk, so the layout is still to be looked at.
- **Not done here:** a live-model draft, and a visual walk of `/pipeline` at desktop and phone widths.

## Session E — Staff planning, by role _(~2 wks)_

Step 93. Off by default (rule 28).

- [x] **P5-18** The team module switch on `/watch` (Modules), off by default. When off, nothing in this session runs or shows.
  - _Done 2026-10-27:_ `lib/team/module.ts`; a missing `account_modules` row is OFF for `team` only (the five earlier modules keep default-on). No migration. While off, `teamView` returns `{ enabled: false }` before reading a booking or a role (tested with a compute spy and at `/api/team`), and the menu item needs `/api/nav`'s `team: true` (tested).
- [x] **P5-19** Coverage by hour (pure).
  - **Demand side:** bookings utilisation (`lib/bookings`), trading-hours demand (`lib/hours`), and the busy season.
  - **Supply side:** role hours from 9.2 (role, hours a week).
  - **Output:** hours where demand runs over the stated capacity, and hours staffed with little demand, as ranges.
  - **Rule 28:** names are never read, and a test passes a named roster and proves the output is identical with the names removed.
  - _Done 2026-10-27:_ `lib/team/coverage.ts` (pure) + `lib/team/load.ts`. Held appointments (completed, no-show, late-cancelled) by weekday × start hour over the last 56 days, against the stated 1.4.2.3b capacity spread evenly over the open hours (stated, else read from when appointments start, ASSUMED). An hour runs short only when the middle half's low end reaches 100%; quiet when its high end is at or under 40%; words quote the middle half's mean. Hourly takings stand in without bookings (quiet only). The busy season's low end names further hours. Under 28 days it refuses with the count and a ready date. Roles: 9.2 title and hours only, grouped by title. Tests: a named roster (and named team-member/client columns in the database) gives byte-identical output; a source scan proves no scoring/ranking function and no read of a name or per-person column.
- [x] **P5-20** The `/team` screen: a role × hour grid of over- and under-cover, with the reasoning in words ("Saturdays 10:00–14:00 ran 96% booked; one teacher covers 8 seats"). Suggestions are notes for the owner; nothing about any person.
  - _Done 2026-10-27:_ `components/team/TeamScreen.tsx`, `/api/team`, ux-spec §3 "Team cover". Demo: the salon (Lumen Hair Studio) answers 1.6 and 9.2 (owner-stylist, two stylists), has the module switched on, and its export's Saturdays now fill 10:00–14:00 (start times only; counts, statuses and the random stream unchanged), so `/team` opens on "Saturdays 10:00–14:00 ran ~125% booked; one stylist covers about 1.1 appointments an hour". No network, no model.

---

## Cost discipline, Phase 5 shape

- **No model calls by default:** every calculation in this phase is arithmetic, so none is needed. The only model use allowed is drafting a pipeline follow-up (Sonnet, the existing drafting fence and caps).
- **PageSpeed Insights** is free at our volume. Calls are capped per site per week and logged like any other external read.

## Phase 5 is done when

- The demo seed shows:
  - a stock-out warning with a reorder note;
  - a 13-week cash range with a "tight week" warning;
  - a site audit with measured findings;
  - a B2B business's deals in a pipeline;
  - a role-level Saturday coverage note with the team module switched on.
- Every one of those is reproducible from the demo seed with no network and no model.
- The full suite, lint, typecheck and format pass.

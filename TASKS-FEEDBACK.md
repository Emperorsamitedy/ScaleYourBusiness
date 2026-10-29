# TASKS-FEEDBACK.md — the interview feedback round

Commit-sized tasks from Vilsta's customer-interview feedback (2026-10-19 to 2026-10-22). Numbers are the owner-facing feature list's (items 30–36 of 54; the list itself is a Claude Doc, "SYB — what it does for owners"). Reference the item number in each commit message.

**Why this file exists:** the feedback cut across phases — the intake, connectors, the owner chat, CRM, content and ads — so it is tracked here rather than bolted onto one phase's plan. Every rule in CLAUDE.md and in TASKS-PHASE2/3/4 applies unchanged.

**Recorded override:** item 34 reads stock levels, which CLAUDE.md's "Do not build yet" fences as inventory (Phase 5+). The owner asked for it explicitly on 2026-10-22 ("yep lets do all"), the same deliberate override as P0-86 and the Phase 2, 3 and 4 openings. It is scoped to finding slow stock and proposing ways to clear it. Reorder points, purchasing and stock management stay fenced.

## Done

- [x] **F-30** Business size in the owner's words: question 1.6a `identity.size_band` (bank 1.6.0), inferred from team size by the EU SME bands when unanswered (computed when read, never stored), and a data table of what each size sees (`lib/core/size-features.ts`, hiding nothing until Vilsta's review). Stated-vs-measured gaps stand out only when material, ≥15 % and above a unit floor; the rest collapse into one line, never hidden. PR #19.
- [x] **F-31** Wording true for any business ("your business"; "your salon", "your gym" where the type is known, `lib/core/business-noun.ts`), and a salon demo beside the webshop on the landing. PR #20. The sign-up's website now reaches the intake as a draft (PR #26).
- [x] **F-32** Bookings: Square appointments through two optional read-only permissions, and a CSV import for every other system (Fresha, Mindbody, Booksy, SimplyBook, Timely, generic). Measures no-shows, late cancellations, rebooking, booking revenue, and utilisation only when capacity is stated. Migration 0050. PR #21.
- [x] **F-33** The assistant acts: a change catalogue as data. Each change is drafted for one click, or deep-linked to the screen, and nothing is written before the click. Migration 0051. PR #23.
- [x] **F-34** Slow stock: read-only Shopify/WooCommerce stock and a stock CSV import. STUCK (no sale in 60 days) and SLOW (>180 days of cover). Five clearing options as proposals, ranked by net cash back, with a discount blocked by a "never discount" rule. Migration 0052. PR #25.
- [x] **F-35** Competitor research on pages the owner lists: robots.txt honoured, hardened fetch, deterministic extraction before a capped Haiku fallback, weekly change tracking. Bank 1.7.0. PR #22.
- [x] **F-36** Campaign simulator: ranges from the owner's own numbers for email, ads and content, side by side, with "Propose this" through each kind's existing path. No model. PR #24.

## Open

- [ ] **F-30a** Fill the size table from Vilsta's feature-by-feature review.
- [ ] **F-32a** Confirm the bookings import's column names against a real export from each platform (Fresha first). Every header in `specs/bookings-import-map-v1.json` is `verified: false` until then.
- [ ] **F-35a** Decide whether the fact sheet's existing "Find my competitors" flow (`lib/research/competitor.ts`) may keep reading pages that came from web search, or should only suggest and let the owner list them.
- [ ] **F-37** Ask Vilsta what "for the 23, I rather meant the functions" referred to.
- [ ] **M-1** Check the Haiku 5.5 move (PR #34) against the real API once a key is on hand: the eight calls listed in that PR.
- [ ] **M-2** Move Sonnet 5 → Sonnet 5.5 and the diagnosis Opus 4.8 → Opus 5.5 (about 20 % cheaper), after a recalibration run on the five real businesses. Sonnet 5.5 rejects the interviewer's `thinking: {type: "disabled"}`, so it needs `between_tools` instead. The owner chose "Haiku now, the rest later" on 2026-10-24.
  - Tooling for M-1 and M-2 exists (2026-10-24, no key needed to build it): `npm run verify:models -- --yes` runs M-1's eight checks; `npm run recalibrate:diagnosis -- --yes` (add `--sonnet` for the interviewer) is M-2's recalibration run; the `SONNET_MODEL` / `DIAGNOSIS_MODEL` env switches make the move, and unset means today's models.

**Review, 2026-10-23:** a read-only review of everything merged since the 17 October audit found no critical or high issues and 24 medium-to-low ones. All are fixed (PRs #27–#30) except one, "sell it off ranks last", which was judged not a defect: it is scored on the same net-cash basis as every option. See `docs/SECURITY-AUDIT.md`.

**Production, before these are live:** follow "Before you deploy main (2026-10-23)" in `docs/SECURITY-AUDIT.md`. It covers `db:migrate` through 0055, `db:seed` for bank 1.7.0, the webhooks, and the campaign gates.

## Ideas round (2026-10-26)

- [x] **I-42** Weekly summary email to the owner: what SYB did and found that week, so they needn't log in. Composed in code with no model, from the watch log, changes that ran, proposals waiting, open support questions (a count, never their words), goal checks and readbacks. Money prints through `lib/core/money`, and a quiet week says it was quiet. It is sent last on the Monday beat (`/api/cron/weekly-watch`) through Resend, and does nothing without `RESEND_API_KEY` and `APP_URL`. It is claimed once per account per ISO week before sending and never retried (migration 0057, `weekly_summaries`). It is on by default once there is a mode decision. The switch is on /watch (`users.notification_prefs.weekly_summary`), and every email has a signed one-click stop link (`/summary/stop/<token>`, RFC 8058). Email only; WhatsApp waits for a provider.
- [x] **I-51** Shareable report link: "Share this report" on `/report` makes a read-only link to that report, for 7 or 30 days (7 by default), listed with when it was made, when it expires and when it was last opened, and revocable at any time. The link is a snapshot: it is pinned to the report it was made for, and the history shown with it stops when it was made. Readers see no owner email, no customer contact, no personal field, none of the owner's answers to the recommendations, and no link into the account. Every dead link gets the same "no longer active" page. Creating and revoking are logged. `lib/report/share.ts`, `/shared/<token>`, migration 0057.
- [x] **I-49** Accountant export: two CSV downloads on `/profile` ("For your accountant"), signed-in owners only. The first has the current money facts, with the amount in major units as a decimal string beside its currency (from integer minor units, no float), status, source, confidence, dates, and derived_from and formula for inferred figures. The second has the superseded figures. Money facts are read from the bank (money questions and entity fields), so an unknown amount keeps its row. Formula-starting cells are neutralised. `lib/profile/money-export.ts`, `GET /api/profile/export`.
- [x] **I-43** What-if pricing: on `/simulate?tab=pricing`, beside the campaign simulator, the owner picks one product or service and up to four price changes (steps of ±5–20 %, or an exact price, held to 1–30 %). The headline is the break-even from their own price, cost to deliver and volume alone: a rise pays while it loses fewer than V × (P′ − P) ÷ (P′ − C) sales, a cut only if it wins more than V × (P − P′) ÷ (P′ − C). Sales, revenue and profit a month show as ranges under a customer-response band per kind of business (`lib/simulate/pricing-bands.ts`, labelled ASSUMED, planning assumptions and not measurements). With no cost, a rise's break-even is a floor that holds for any cost, and profit waits for the cost; a missing input links to the question that asks it. Booking businesses: each service from its own last 28 days of appointments, with a cut held to the room the stated weekly capacity leaves. Per-order costs are named, not counted. No model, no migration, no proposal, and nothing writes a price.

Ideas 46 and 48 of the owner-facing feature list, on one new screen, Insights · Seasons & bundles (`/patterns`). Both are arithmetic over the business's own measured rows: no model and no network.

- [x] **I-46** Busy-season forecast (`lib/seasons/forecast.ts`, pure; `lib/seasons/load.ts`). It reads one source's series, picked by the chart archetype's own candidates (revenue, booking revenue, then orders or appointments), never two sources added together. Complete Monday weeks are set against the normal week (the median of the last 52, its middle half as the range), with busy ≥ 1.25× and quiet ≤ 0.8× for two weeks or more in a row. It also indexes the months, and the next eight weeks beside the same weeks 364 days before ("ran 2.0× your normal week; the same weeks this year start in 4 weeks"). A second or third year widens each range. Under 50 complete weeks of the last 52 it refuses, saying how much there is, what it can and can't say, and from when it can. It never fills a season from industry averages. **Not built, deliberately:** a busy stretch approaching doesn't yet feed the content calendar or a stock note as a proposal. That needs a decision on which proposal kind and when; it's noted as I-46a.
- [x] **I-48** Bundles and add-ons (`lib/bundles/pairs.ts`, pure; `lib/bundles/load.ts`, `lib/bundles/propose.ts`). The Shopify and WooCommerce syncs now keep each counted order's distinct product ids (`order_baskets`, migration 0057). They come from the order lines the sync already read under `read_orders`, so no query, path or scope was added, and the scope audit is unchanged. A re-read replaces its days, and no customer data is stored. A bookings business's baskets are visits: one client's completed appointments on one day. Pairs show with support, confidence from the rarer item, and lift against chance. A pair needs 5 baskets together, 1.2× chance and 50 baskets in all, and what falls under each line is counted. The pair's margin comes from the owner's own offer prices and costs, or is stated as unknown. "Propose this pair" drafts one `offer_change` proposal, module `bundles`, through the existing path. It is held before care and while watching, checked against the hard limits and suppression, and made once per pair per month. Both items stay at full price. Nothing executes it, and no price, product or checkout is written. Stripe carries no products, and the screen says so. Square till orders aren't read for baskets.
- [ ] **I-46a** Decide whether an approaching busy stretch should propose something (a content-calendar push, or a stock note for a webshop) and through which kind; until then the forecast only shows. **Stock half closed by P5-04 (2026-10-27):** an approaching or running busy stretch raises the rate in days of cover and in the reorder note's quantity, stated, through the `stock_reorder_note` kind (TASKS-PHASE5.md). The content-calendar half is still open.
- [ ] **I-48a** Decide whether Square's till orders should feed baskets too (its line items, under the existing `PAYMENTS_READ`?). It needs Square's docs checked for the scope.

Demo seed: Fernhill's orders now carry two buying habits, each drawn from its own random stream so the rest of the story is unchanged: a pour-over set with a bud vase trio, and a serving bowl with a dinner plate (the bowl stays slow stock). Lumen's colour clients often stay for a gloss treatment in the next slot. Fernhill has a year of orders, so its seasons show. Lumen's 120 days of bookings show the refusal. Emberworks has no order history in the seed and shows the empty states.

## Idea 47: abandoned carts (owner, 2026-10-29: "build 47")

Shopify only for now: WooCommerce has no abandoned-checkout API without a plugin, and Square's online checkout isn't read. The existing rules hold, read-only (rule 9) and consent as a recorded fact (rules 19 and 23) in particular, and two choices are made here, conservatively:

- **Who may be emailed is decided by the contacts SYB already holds.** A cart is matched to a contact by the existing email hash (`lib/crm/contacts.ts`), and only a contact whose recorded consent passes `canEmailForMarketing` is ever proposed for a win-back. Shopify's own "buyer accepts marketing" tick is stored as a flag on the cart, but it does not create a contact or count as consent. Whether it may is **I-47a**, an owner decision.
- **No raw shopper email is stored from the connector.** A cart keeps the email's hash, never the address, so a shopper who isn't already a contact leaves nothing personal behind. Carts are deleted after 90 days, and erasing a contact deletes the carts that match their hash.

- [x] **I-47.1** Read abandoned checkouts. Add one fixed read query to `SHOPIFY_QUERIES` (`abandonedCheckouts`, under the `read_orders` scope already granted). Check Shopify's docs at build for the scope, and for whether reading the email needs protected customer data level 2 on an owner-created app. If it does, the connections screen says so in plain words. A cart is stored with:
  - its Shopify id, when it was created and updated;
  - its value as integer minor units and currency;
  - its line items (product ref, quantity and price);
  - the email hash, the marketing flag, and whether it was later completed.

  The new table `abandoned_checkouts` uses migration **0066**. Build the fake in `shopify-fake.ts`, update the query-list test, and add the scope audit test unchanged-green. No write and no new scope.

  **Done 2026-10-29.** `SHOPIFY_QUERIES.abandoned_checkouts`, read once per sync after the stock snapshot (the last 60 days, never fatal, never a partial count), stored by `lib/carts/store.ts`, migration 0066. Shopify's docs (read 2026-10-29, Admin GraphQL 2026-10): the query and `AbandonedCheckout` need `read_orders`, held, so no scope was added and the registry and audit are unchanged. Fields: `id`, `createdAt`, `updatedAt`, `completedAt`, `totalPriceSet`, and per line `title`, `quantity`, `originalUnitPriceSet`, `product { id }`. **The plan's email doesn't hold:** a checkout has no email of its own. It sits on its customer (`customer.email`, deprecated for `defaultEmailAddress.emailAddress`), and the Customer type needs `read_customers`; the marketing tick is there too (`defaultEmailAddress.marketingState`). Email is also level 2 protected customer data (for a Dev Dashboard app on the owner's own store, Shopify's page doesn't say). So the document reads no shopper, every Shopify cart lands with a null `email_hash` and `accepts_marketing`, and the connections screen says in plain words that no cart is matched to the owner's contacts. The hashing, the erasure link and the 90-day deletion are built and tested for any store that does give an email. See I-47b.

- [x] **I-47.2** The arithmetic (pure), over the last 30 days against the 30 before:
  - carts started, carts left, and the share left out of all checkouts (carts plus the orders the sync already counts);
  - the value left in carts, per currency, never mixed;
  - the products left behind most, mapped to the owner's offers as orders are.

  "Likely to win back" is a range from a stated rule of thumb (ASSUMED, named, never the owner's own number), shown beside how many of the shoppers can actually be emailed. It refuses (rule 25) with under 14 days of carts or under 10 carts, and says how many there are and when it will be ready. Test at the boundaries.

  **Done 2026-10-29.** `lib/carts/measure.ts`, pure. The window is the 30 complete UTC days ending yesterday. "Left" means never finished, and the ten carts counted are carts left. Days of carts count from the first cart read. The share left is left ÷ (left + the orders `orders.daily` counted), and unknown without measured orders. The window before is compared only when it passes the same two tests. The refusal gives a date only when days are short ("ready from 30 Oct"); when carts are short it says it waits for ten. The win-back range is `WIN_BACK`, ASSUMED, 3–10 % of the value of carts whose shopper may be emailed. With nobody emailable there is no range at all.

- [x] **I-47.3** Win-back proposals. Add a segment `abandoned_cart`: contacts whose hash matches a cart left 1–7 days ago with no later order. Each contact is gated by `canEmailForMarketing` and suppression every time.
  - It goes through the existing customer-email proposal path (`lib/crm/segment-proposals.ts`), with hard limits, the three-declines rule and nothing while watching (`watchingUntil`).
  - At most once per contact per 30 days.
  - The draft (the existing campaign drafting, capped as it is) names the products left behind, never the person. The greeting is a slot, and the AI disclosure is added in code.
  - Shoppers who can't be emailed are counted and said in words ("12 carts are from people with no recorded consent, so they aren't emailed"). They are never listed by address.

  **Done 2026-10-29.** `lib/carts/segment.ts` (pure) and `proposeFromSegments(…, { only: "abandoned_cart" })`. A cart counts when it was left 1–7 UTC days ago (today's waits for tomorrow) and never finished. "No later order" means no later finished cart with the same hash and no purchase on the contact's record after it: an order can't be tied to a person any other way. The reminder is asked for by name only, from `/carts`; the monthly lapsed and VIP run doesn't make it. It is keyed `crm:cart:<day>`, so once a day. A contact named in any cart proposal of the last 30 days is left out, whatever became of that proposal, and counted. The draft's brief names up to five products and forbids naming the person. **The greeting is fixed text put in by code** (`CART_GREETING`, "Hello,"), not a per-recipient slot: the send executor proves that only the unsubscribe slot changed, and it is untouched. The disclosure is added after the model, as for every draft. With Shopify's carts carrying no hash (I-47b), this proposes nothing from real Shopify data today. It is tested with carts that carry one.

- [x] **I-47.4** The `/carts` screen (sheet design system), under Customers, shown only when a Shopify connection exists:
  - The head is the main fact: "€1,240 was left in carts in the last 30 days; 9 of the 41 shoppers can be emailed."
  - Then the products left behind, the likely-to-win-back range with its assumptions and sources, and "Propose win-back emails" (off while watching, saying why).
  - The consent notes, and a foot: "SYB never emails a shopper who hasn't said yes. Shopify's own abandoned-checkout email, if you use it, is separate."

  **Done 2026-10-29.** `app/carts/page.tsx`, `components/carts/*`, `GET/POST /api/carts`, and "Abandoned carts" under Customers (`nav.carts`). The menu item shows when a store connection reads carts, decided from the provider registry and not by a provider name (`cartsApply`). The API sends counts only: no address, name or contact id. Proposing needs a signed-in owner and a same-origin POST. The button is off while watching (`watchingUntil`) and when the owner's consent answer is "no consent". It is also off when nobody who said yes left a cart in the last week, or when everyone who did was proposed a reminder in the last 30 days, and each case says why. A refused measure shows one sheet with the refusal's own sentence.

- [x] **I-47.5** Demo seed: Fernhill's fake shop gets about 30 days of abandoned carts. A few match its consented contacts, so the screen shows a real win-back proposal and the "can't be emailed" count. No network, no model.

  **Done 2026-10-29.** Fernhill's fake shop has about 40 days of checkouts (`shopCarts`), read by the real query on today's sync: €3,143 left in 44 carts, 6% of checkouts. Shopify doesn't give SYB the shopper (I-47b), so **the seed stands in for that read**: it writes the keyed hash for 13 planned shoppers and stores no address. Those are five consented customers, two studio customers with implied consent, and six strangers, so 5 of the 44 shoppers can be emailed. Fernhill is still watched, so its button is off and says why. The real proposal is on **Emberworks**, past its watch. It has a fake Shopify connected for carts only (no orders read, so nothing else on it moves) and 18 carts: three consented customers, two never asked, one unsubscribed, two strangers. The seed proposes "Remind 3 shoppers who left a cart this week and said yes to email" through the real path. No network, no model.

**Done when:** the demo shows `/carts` with a measured headline, a refusal path tested, a proposal made only for consented contacts, erasure removing a contact's carts, and the scope audit unchanged.

- [ ] **I-47a** Decide whether Shopify's "buyer accepts marketing" tick at checkout may create a contact with that consent recorded (source: the Shopify checkout, with its time). Until then it is stored but not used.
- [ ] **I-47b** Decide whether SYB should ask Shopify for `read_customers` (optional, like `read_all_orders`), so a cart's shopper can be hashed and matched to a contact. Without it no Shopify cart matches anyone and no win-back is proposed from real data; with it, SYB's credential can read the whole customer list, and Shopify's protected customer data rules for email apply. Found at build (I-47.1); the registry and the scope audit are unchanged until the owner decides. I-47a's tick also lives on the customer, so it depends on this.

## Idea 54: its own track record (owner, 2026-10-29: "go to the next one")

The scorecard (`lib/trust/scorecard.ts`, P3-26) already grades proposals that ran: helped, did nothing or backfired. What it doesn't grade is SYB's **forecasts**: the cash range, the stock-out dates, the busy seasons and the pipeline's likely close. Idea 54 records each forecast at the moment it is shown, with its range, and grades it once its window has passed, against measured data only. Rule 25 holds: every forecast states its basis. Two choices are made here, conservatively:

- **Nothing is recorded after the fact.** A forecast enters the record only when it was made, with the range shown then. There is no backfill from today's model run over old data, because a forecast written knowing the answer isn't a forecast. (The demo seed backdates its claims explicitly, and says so.)
- **Only measured actuals grade.** A stated or estimated figure never marks a forecast right. With no measured actual, the forecast is "can't tell", counted apart and never folded into "right".

- [x] **I-54.1** The record. A new table `forecast_checks` (migration **0067**) holds:
  - profile, kind, made_at, and the forecast's own key, so it is recorded once per window (for example the cash low of the week starting 2 Nov, as forecast in the week of 26 Oct);
  - the claim: metric, window start and end, low and high (money as integer minor units with currency, rule 1; counts or dates as such), and the basis sentence shown with it;
  - grading, filled once and never changed: graded_at, the actual and its source row, and a verdict of `inside`, `above`, `below` or `cant_tell`.

  A database trigger refuses any change to a claim, and any second grading.

  **Done 2026-10-29.** `forecast_checks` (`db/schema.ts`, migration 0067), tested against live Postgres in `lib/forecasts/guard.test.ts`. The key is unique per profile (`forecast_key`), so a second record of the same window is a no-op. Money is `low_minor`/`high_minor` plus `currency`, a count is `low_num`/`high_num`, dates are `low_date`/`high_date`; a `unit` column says which, and a check holds each set whole. The basis sentence and the claim as shown are both stored. `subject_ref` says where the actual will be read and what the claim started from, for example the units on hand it was worked out from. The grade is `graded_at`, `verdict`, `actual_minor`/`actual_num`/`actual_date`, `actual_note` (what happened, in words) and `actual_source` (the measured rows). Judgement calls: the triggers also refuse a row **inserted** already graded (a grade comes later or it isn't one), an update that isn't the grading, a **delete** on its own, and TRUNCATE. A delete through the business's own cascade passes, because the foreign key's trigger runs it (`pg_trigger_depth() > 1`); otherwise erasing a business or a test's cleanup would fail. A check refuses `inside`, `above` or `below` without `actual_source`, so a right or wrong verdict always cites measured rows; `cant_tell` needs none. `made_at` is when it was shown, and `recorded_at` is Postgres's own clock, so a backdated row shows as one.

- [x] **I-54.2** Record what is already forecast, where it is made. Check each forecast's code and pick those whose actual is measured later:
  - the cash forecast's next four weekly closing balances (P5 cash, `lib/cash`), but only where the balance is measured (Stripe balance or a bank import), otherwise none;
  - the stock-out warnings' "runs out around" date range (`lib/stock`), graded by the measured stock reaching zero, or not, within the range;
  - the busy-season forecast's next eight weeks (`lib/seasons`), graded by each week's measured series against the stated band;
  - the pipeline's likely close for deals due in the window (`lib/pipeline`), graded by the deals the owner marks won.

  Each is recorded at most once per window, on the beat or screen that already computes it. Nothing new is computed. If a forecast can't be graded from measured data, it isn't recorded, and the task note says which and why.

  **Done 2026-10-29.** Two of the four are recorded, by `lib/forecasts/claims.ts` (pure) and `lib/forecasts/record.ts` (insert-only, a failure never stops its caller):
  - **Stock-out warnings**, on the weekly beat inside `logStockWarnings`, where the warning is said. The range is the warning's own whole days ("about 4–6 days", `wholeDays`), as dates counted from the day it was said; the `runs_out` dates use the floor of each end and can be a day shorter than the words, so the words win. A warning with no upper end ("about 30 days or more") isn't recorded, because no day could prove it wrong. It is recorded once per item per ISO week, the warning's own once-a-week. `subject_ref` keeps the units on hand and the day they were counted.
  - **The season's next weeks**, on `/api/patterns` when the screen is shown. The screen says how each coming week ran last year against the normal week ("2.0× (1.8–2.2×)"). The claim is that range times the normal week now, in the series' own units: money in integer minor units rounded outward, or a count to one decimal. The basis sentence names the week, the normal and the source. Judgement calls: a week is recorded **once per week of the year**, not once per showing, because the same week last year is the forecast each time, and eight near-identical claims would count one forecast eight times; the first showing is the one on record. A week already under way isn't recorded, because part of the answer is in. Neither is a week last year didn't measure in full, or a range with no upper end. `SeasonsView` now carries `series_ref` (the connection and metric picked), so the grade reads the same series.
  - **The cash forecast isn't recorded.** No balance is measured anywhere: cash today is the owner's answer to 5.3e, and no connector or import reads a bank or Stripe balance (no `balance` metric exists). A closing balance could only be graded against another stated figure, which never marks a forecast right. See I-54a.
  - **The pipeline isn't recorded.** What `/pipeline` shows is open deal values × the win rate, with no window: it weighs every open deal whenever it closes, so no date ever closes the claim. "Deals due in the window" would mean building a new forecast from the owner's own expected-close guesses, which this task rules out ("nothing new is computed"). A deal can also be reopened, which clears `closed_at`, so its outcome isn't fixed. See I-54b.

- [ ] **I-54.3** Grading. A pure grader, plus a step on the weekly beat (`/api/cron/weekly-watch`): every claim whose window closed at least a day ago and has no grade gets one from measured rows. It is deterministic, with no model and no retry loop.
- [ ] **I-54.4** "My track record" on `/history`, beside the scorecard:
  - the headline counts graded forecasts, for example "7 of my last 9 forecasts landed inside the range I gave". It names how many it couldn't tell, and is broken down by kind;
  - each forecast is listed: what I said, when, on what basis, and what happened;
  - with fewer than three graded forecasts it says it is too soon to judge, and how many are waiting;
  - misses are shown as plainly as hits, with how far off they were in the forecast's own units.

  The weekly summary email gets one line when something was graded that week.

- [ ] **I-54.5** Demo seed: Fernhill gets backdated claims, graded against its seeded data, including at least one miss and one "can't tell". The seed comments that real accounts never backdate. No network, no model.

**Done when:** a graded forecast can't be edited, a miss shows as plainly as a hit, "can't tell" never counts as right, and the demo's `/history` shows the record.

- [ ] **I-54a** Decide whether SYB should read a measured balance (Stripe's balance, or a bank statement import) so the cash forecast's weekly closing balances can join the track record. Until one is measured, the cash forecast isn't recorded: it could only be graded against the owner's own figure.
- [ ] **I-54b** Decide whether the pipeline should show a windowed forecast ("of the deals you expect to close by 30 Nov, about €4,000–€9,000 is likely won") so it can be recorded and graded by the deals marked won. Today's weighted value has no window, and a reopened deal clears its close.

## Idea 50: answer with your voice (owner, 2026-10-29)

The owner taps a microphone, speaks, and the words appear in the answer box. They read and fix them, then record the answer as always. It uses the browser's own speech recognition (the Web Speech API), so there is no new provider, no key, no model call and no server change. Conservative choices:

- **Nothing is sent or recorded by SYB.** No audio reaches SYB's server, and none is stored. Only the text the owner chooses to record is saved, exactly as if typed. Speech never records an answer by itself.
- **Say who hears it.** Where the browser can recognise on the device, use that. Otherwise the first use shows one plain line: "Your browser turns your speech into text. In Chrome, Google does this; SYB never receives the audio." Check MDN and the spec at build, for on-device options (`processLocally` / `available()`) and which browsers support them. The privacy page says the same.

- [ ] **I-50.1** A pure helper and a hook:
  - `lib/voice/transcript.ts` merges recognised text into what is already typed: spacing and capitals, interim versus final results, and never overwriting the owner's own text;
  - `useSpeechAnswer`, a feature-detecting hook, which hides itself where the API doesn't exist (Firefox, for example) without an error. It uses the profile's language if known, else the browser's. It stops on a second tap, after silence, or at a 60-second cap.
- [ ] **I-50.2** A microphone button, `components/voice/MicButton.tsx`, on free-text answers only:
  - the intake's text and long-text controls (`components/intake/controls`), the owner chat on `/chat`, and the support reply drafts' edit box;
  - not on number, money, date or choice answers, where a misheard word is a wrong fact.

  It is labelled, with `aria-pressed`, an `aria-live` "Listening…" line, keyboard operable, and a 2px focus ring (ux-spec §11). It works at 360 px. A permission refusal says what happened and how to allow it, with no apology.

- [ ] **I-50.3** Tests run against a fake SpeechRecognition: the merge helper's cases, hidden when unsupported, nothing submitted by speech, the cap, and a permission error. Then a browser check on the intake at phone width; real recognition can't run headless, so say what was and wasn't verified. Update `/privacy`, `docs/SECURITY-AUDIT.md` (the browser vendor's processing, and that SYB receives no audio) and the ux-spec.

**Done when:** an owner can speak an answer into the intake and the chat, see it, fix it and record it, where nothing is recorded without their click and no audio reaches SYB.

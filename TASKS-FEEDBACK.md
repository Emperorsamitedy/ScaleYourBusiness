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

## Idea 44: compared with similar businesses (owner, 2026-10-29)

The owner sees a few of their own numbers set against businesses like theirs: same activity, same country, same size. The source is Eurostat's structural business statistics, the dataset `sbs_sc_ovw` ("Enterprise statistics by size class and NACE Rev. 2 activity, from 2021 onwards"). It is free and keyless, reusable under CC BY 4.0 with attribution, and was checked live on 2026-10-29: the dataset was updated 2026-09-30 and covers HU, `I56`, 2022. It has size classes `0_1`, `2-9`, `10-19`, `20-49`, `50-249` and `GE250`, NACE down to three digits, and indicators including `GOR_PC` (gross operating rate), `NETTUR_EMP_TEUR` (turnover per person employed), `LC_EMP_TEUR` (labour cost per employee) and `PUR_MEUR` / `NETTUR_MEUR`. Conservative choices:

- **A benchmark is a reference, not a fact about the business.** It never becomes a `Field` on the profile, never feeds the diagnosis or a proposal, and never speaks as a finding. Whether it may is **I-44a**.
- **Say exactly what it is.** Eurostat's figures are ratios of totals across every enterprise in the cell, not a median, and not "typical". Each line names the cell and year: "all restaurants and cafés with 2–9 people in Hungary, 2022, Eurostat". Each also names the one definition gap that matters most. For example, the gross operating rate is before the owner's own pay in a business where the owner isn't on the payroll.
- **No runtime network.** A script fetches a dated snapshot into the repo, and the app reads only that file.

- [x] **I-44.1** The snapshot. `scripts/fetch-benchmarks.ts` (`npm run benchmarks:fetch`, run by hand, never at build or in CI) writes `specs/benchmarks-eurostat-v1.json`:
  - per EU country (EU27, plus the `EU27_2020` aggregate), for the NACE codes the mapping uses and every size class, the latest year with a value for `GOR_PC`, `NETTUR_EMP_TEUR`, `LC_EMP_TEUR`, and the purchases share (`PUR_MEUR` ÷ `NETTUR_MEUR`);
  - Eurostat's status flags kept: confidential or missing cells are recorded as missing, never zero;
  - the dataset code, its `updated` date, the retrieval date, the API URL pattern and the licence line;
  - the annual euro reference rates for the same years (Eurostat `ert_bil_eur_a`), so a non-euro business's figures are compared in its own currency, rule 1, with the rate and year shown.

  Commit the snapshot. A test validates its shape and that no value is fabricated: every value carries its dataset, geo, nace, size and year.

  **Done 2026-10-29.** `scripts/fetch-benchmarks.ts` (`npm run benchmarks:fetch`) wrote `specs/benchmarks-eurostat-v1.json` in 29 requests: one per country (the 27 members and `EU27_2020`), each naming all 38 NACE codes the map uses and five indicators from 2021 on, then one for the rates. It is 1.0 MB, 6,259 cells, one cell per line; `specs/` was already in `.prettierignore`, so prettier never touches it. The JSON-stat decoding is pure, in `lib/benchmarks/jsonstat.ts`; the app reads the file through `lib/benchmarks/snapshot.ts` and never the network. `snapshot.test.ts` checks the shape, that every figure names its cell and year, that no zero stands in for a missing figure, that confidential figures stay missing by name, and one cell against the live value.

  What Eurostat's docs and answers said:
  - **The API.** It is `…/statistics/1.0/data/{dataset}?format=JSON&lang=EN&{dim}={code}`, with a filter repeated for several codes. Only one time parameter is allowed per query (`time`, `sinceTimePeriod`, `untilTimePeriod` or `lastTimePeriod`; since and until may be combined). A 413 means "treated asynchronously, try again later". The detailed-guidelines wiki is behind an EU login, so the flag meanings come from each answer's own `extension.status.label`.
  - **The JSON-stat 2.0 shape.** `id` and `size` give the dimensions; `value` and `status` are sparse objects keyed by the row-major position. The flags seen were `e` (estimated), `b` (break in series), `|C` and `b|C` (confidential, with no value).
  - **Time parameter.** I used `sinceTimePeriod=2021`, not `lastTimePeriod`. With `lastTimePeriod=1`, a cell whose 2024 is confidential but whose 2023 was published would be lost. Every cell keeps its own latest year. 10,189 of 10,592 figures are 2024; the rest are 2021–2023.
  - **The finding that changes the plan.** For every service activity, sbs_sc_ovw publishes size classes only for persons employed, turnover and value added. `GOR_PC`, labour costs and purchases exist only at `TOTAL`, all sizes together. Only industry and construction (`C`, `C10`, `F`, `F43`) have them by size. The classes `0_1` and `2-9` are empty everywhere; micro businesses are published only as `0-9`. So for a salon, café or shop, the margin and staff-cost lines compare against that activity's businesses of every size, and say so. Turnover per person is the one line that can match the size class.
  - **The licence.** Eurostat's copyright notice (`/eurostat/web/main/help/copyright-notice`) allows free reuse, commercial or not, with the source acknowledged; editorial content is under CC BY 4.0. A customised dataset is cited as "Source: [dataset code link], [access date]". Modifications must be stated, along with a disclaimer that Eurostat is not responsible. Data for countries outside the EU, EFTA and candidates is restricted, which is one more reason only the EU27 is fetched. The file's `source` carries the attribution, a `modified` line and the disclaimer.
  - **Exchange rates.** `ert_bil_eur_a` has `statinfo` AVG or END and `unit` NAC (national currency per euro). The snapshot keeps AVG for 2021–2025 for CZK, DKK, HUF, PLN, RON, SEK, GBP, USD, CHF and NOK. It has no BGN: Eurostat returned none, as Bulgaria uses the euro.

  Judgement calls:
  - **`LC_EMP_TEUR` is per person employed, not per employee**, whatever the plan says. Eurostat's own label is "Labour costs per person employed", and for personal services in Hungary it is €3.0k against €16.2k per employee, because most of the people working in that sector aren't on a payroll. The staff-cost line therefore uses `AVG_EXPN_SAL_BEN_TEUR` ("Average employee benefits expense", i.e. personnel costs ÷ employees), and `LC_EMP_TEUR` isn't fetched.
  - **Purchases share** is stored, worked out as `PUR_MEUR ÷ NETTUR_MEUR` from one year, with `derived_from`. It is shown nowhere yet (see I-44b).
  - **Unpublished figures** are left out of a cell (the file's `absent` line says so). Confidential ones are kept as `{"missing":"confidential","year":…}`. Neither is ever a zero.

- [x] **I-44.2** The mapping, as data, `specs/benchmark-map-v1.json` (rule 4): each `business_type` value maps to one NACE code, for example `restaurant` and `cafe` to `I56`, `salon_beauty` and `barber` to `S96` (the dataset stops at `S960`, so the line says it covers all personal services), `gym_fitness` to `R93`, `ecommerce_store` to `G479` or `G47`, and `clinic_health` to `Q86`. Every mapping has a one-line note on what the code covers. Types with no honest match (`nonprofit`, `other`, and `agriculture`, since section A isn't in SBS) map to none, and the screen says there is no comparison for them. `identity.size_band` and team size pick the size class (persons employed, the owner included). The country comes from the profile; outside the EU the screen says Eurostat doesn't cover it.

  **Done 2026-10-29.** `specs/benchmark-map-v1.json` is applied by `lib/benchmarks/map.ts`, which is pure. Each of the bank's 33 `business_type` codes has an entry. A match names its NACE code, its parent (the code one level up, tried when a cell is missing), the group in the owner's words, and a line on what the code covers. A non-match says why. `map.test.ts` holds the entries to the bank's vocabulary. It also checks that the map's codes are exactly the snapshot's 38, that each parent is a prefix of its child, and that every cost category is treated. The mapping, with the judgement on each:

  | business_type                      | NACE (parent) | Why this code                                                                                                                    |
  | ---------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
  | retail_shop                        | G47 (G)       | all retail except cars                                                                                                           |
  | ecommerce_store                    | G479 (G47)    | retail not in stores; the plan's first choice, and published at every size class for turnover                                    |
  | restaurant, cafe, bar              | I56 (I)       | the plan's choice. I561 and I563 exist, but one group for all three keeps the line honest about what it covers                   |
  | food_production                    | C10 (C)       | food manufacture, bakeries included                                                                                              |
  | salon_beauty, barber, wellness_spa | S96 (none)    | S960 is S96's only child, and the dataset has no section S, so there's no parent. Spas are 96.04, inside S96                     |
  | gym_fitness                        | R931 (R93)    | narrower than the plan's R93: sports activities (fitness facilities are 93.13) without amusement parks; published in all 28 geos |
  | clinic_health                      | Q86 (Q)       | the plan's choice; the line says it includes hospitals. Q862 would suit a GP or dentist but not a physio                         |
  | construction                       | F (none)      | the section                                                                                                                      |
  | trades_services                    | F43 (F)       | the building trades: electricians, plumbers, joiners                                                                             |
  | cleaning_services                  | N812 (N81)    | cleaning activities                                                                                                              |
  | automotive                         | G452 (G45)    | repair and maintenance, since the product calls this business "your garage" (`lib/core/business-noun.ts`)                        |
  | professional_services              | M (none)      | too broad for anything narrower to be honest                                                                                     |
  | consulting                         | M702 (M70)    | management consultancy                                                                                                           |
  | agency_marketing                   | M731 (M73)    | advertising agencies                                                                                                             |
  | it_services                        | J62 (J)       | programming and IT consultancy                                                                                                   |
  | software_saas                      | J582 (J58)    | software publishing; the line says build-to-order firms sit in J62                                                               |
  | education_training                 | P855 (P85)    | tutoring, language and driving schools, courses                                                                                  |
  | childcare                          | Q889 (Q88)    | child day-care is 88.91                                                                                                          |
  | real_estate                        | L68 (L)       | all real estate                                                                                                                  |
  | logistics                          | H (none)      | haulage, warehousing and couriers are split across H49–H53, so the section                                                       |
  | manufacturing                      | C (none)      | the section                                                                                                                      |
  | wholesale                          | G46 (G)       | wholesale except cars                                                                                                            |
  | photography_creative               | M74 (M)       | design, photography and translation together                                                                                     |
  | tourism_accommodation              | I55 (I)       | accommodation; the line says tour operators are N79                                                                              |
  | transport                          | H49 (H)       | land transport                                                                                                                   |
  | agriculture                        | none          | section A isn't in SBS                                                                                                           |
  | events                             | none          | venues, planners and caterers sit in three different groups (N82.3, I56.2, R90)                                                  |
  | nonprofit, other                   | none          | no honest group                                                                                                                  |

  More judgement calls:
  - **Size.** Classes come from the headcount (1.6, "including you", which matches Eurostat's persons employed, owners included). Every class that holds it is tried, narrowest first: 2 people tries `2-9`, then `0-9`. Without a headcount the band is used: solo is `0_1` then `0-9`, small is `2-9` then `0-9`. Medium (10–49) and large (50+) each span two of Eurostat's classes, so they pick none, and the line compares with every size. `0_1` and `2-9` are kept although Eurostat publishes neither today, so a later snapshot that has them is used without a code change.
  - **Country.** The profile's free-text `legal.country` is read by the existing `countryCode` (`lib/hours/timezone.ts`); Greece becomes `EL`. Anything outside the EU27 is "outside", and the screen says Eurostat's figures don't cover it.
  - **Costs.** `cost_categories` is data too: `salaries` is staff, `loan_payments` is financing (left out and named), and everything else, unknown included, is a running cost that Eurostat counts among purchases.

- [x] **I-44.3** The comparison, pure, in `lib/benchmarks/compare.ts`. Up to three lines, each computed only when the owner's own inputs exist (measured first, then stated, with the status shown, rule 2):
  - operating margin against `GOR_PC`, with revenue minus purchases, other operating costs and staff costs, before the owner's own pay, interest, depreciation and tax; the formula is spelled out with `derived_from` (rule 6);
  - turnover a year per person employed against `NETTUR_EMP_TEUR`, converted to the business's currency;
  - staff cost per employee against `LC_EMP_TEUR`, only when there are employees and a staff cost.

  Each line reads "above", "below" or "about the same" (within ±15 %), with both numbers and the gap. No grade, score or "you should". A missing input says which question would fill it and links to it. A cell missing in Eurostat falls back to the next size class, then the NACE parent, saying which. Tests at the ±15 % boundaries, the fallbacks, the currency conversion, and every refusal.

  **Done 2026-10-29.** `lib/benchmarks/compare.ts` is pure: no database, network, model or clock. `compareWithSimilar(inputs, snapshot)` refuses before any line when it lacks something it needs: no business type (link to 1.2), a type with no honest match (the map's reason), no country or one it can't read (link to 1.1b), or a country outside the EU27. Otherwise it gives the head (group, country, first size class tried, and why that size) and three lines. Each line is compared, missing (with what it needs, linked to its question) or refused (no Eurostat figure, no employees, no euro rate). A compared line carries:
  - both figures and the reading, with the gap in points or money and percent;
  - the owner's formula with the numbers, its `derived_from` keys and each input with its basis (OBSERVED for a measured revenue, STATED, ESTIMATED or DERIVED);
  - what was left out and why;
  - the exact cell, as "all online and mail-order shops with up to 9 people in Ireland, 2024, Eurostat", with Eurostat's flag in words and any fallback sentence;
  - the conversion rate and year.

  `compare.test.ts` has 31 tests: the ±15 % boundaries both sides (inclusive, negative and zero benchmarks), every fallback step, the forint conversion, each refusal, and one case run against the committed snapshot.

  Judgement calls:
  - **Fallback order.** The plan said "the next size class". I took each class that holds the headcount, narrowest first, then every size, then the parent code. A neighbouring class (10–19 for a business of 3) is a different size, and calling it "businesses like yours" would be less honest than "of every size". The sentence names what was missing ("doesn't publish this" or "keeps this confidential (2024)") and what the figure is instead. Because services publish margins only for every size (I-44.1), the margin and staff lines of a salon, café or shop always fall back to every size, and say so.
  - **The operating margin.** It is revenue minus cost of sales, per-sale costs, running costs and staff pay, all over revenue: before the owner's own pay, interest, depreciation and tax, like Eurostat's gross operating surplus over turnover.
    - Cost of sales: the offers' cost to deliver at their volumes, when every selling offer has a cost (§8.3: computed beats stated); otherwise 100% minus the stated gross margin (5.3a); otherwise the line asks for one or the other.
    - Per-sale costs: 5.2's per-piece costs × units, and its per-order costs × orders a month. When the count is missing, the cost is left out and named.
    - Running costs: every dated cost on 5.1 and 5.2, made monthly. A loan repayment is left out and named, because Eurostat's rate is before interest and the loan itself isn't a cost. A cost in another currency, or with no amount or frequency, is left out and named.
    - Staff pay: the `salaries` lines if any; otherwise the 9.2 rows marked employee, which must all have a cost. The owner's row is never counted, so this is the "before the owner's own pay" side. Contractor rows aren't added, as a contractor is assumed to be on the costs list. When staff pay can't be known (someone may be paid but nothing says what), the line refuses rather than leave the biggest cost out. A one-person business needs no staff pay.
    - A cost on the costs list that isn't operating (Fernhill lists its VAT return under "other") is counted as given. The category vocabulary has no "tax", and I don't branch on a label's words.
  - **Turnover per person** is monthly revenue × 12 ÷ the headcount, owner included, which matches Eurostat's persons employed. The definition gap shown is VAT, because Eurostat's turnover excludes it.
  - **Staff cost per employee** uses the employees on 9.2, each counted once (Eurostat counts part-timers as one too). Pay comes from their own monthly costs, else the costs list's salaries. The gap shown is the employer's social contributions, which Eurostat includes.
  - **"About the same"** means within 15% of Eurostat's own figure, either side, the boundary included. For a margin that is relative too: a 12% sector margin gives a band of ±1.8 points.
  - **Rates.** An exact year only: with no rate for the cell's year, the line refuses rather than borrow another year's.
  - **The status shown.** It is the basis class (`components/report/basis.ts`), read through the cash module's own readers (`lib/cash/inputs.ts`), so a revenue Stripe measured shows OBSERVED and the owner's estimate ESTIMATED.

- [x] **I-44.4** The screen, under Insights as "Compared with similar businesses" (`/benchmarks`, sheet design, 360 px):
  - the head is the cell in words;
  - then the lines, with each one's definition gap in a sentence;
  - then the source foot: "Source: Eurostat, sbs_sc_ovw, updated 30 Sep 2026, retrieved 29 Oct 2026, CC BY 4.0. These are totals across every business in the group, not a typical business."

  No model, no network.

  **Done 2026-10-29.** `/benchmarks` is built from:
  - `app/benchmarks/page.tsx` and `components/benchmarks/BenchmarksScreen.tsx`, the screen;
  - `components/benchmarks/view.ts`, its words, which are pure;
  - `app/benchmarks.css`, on the sheet system;
  - `GET /api/benchmarks`, behind `resolveAccess` and with no POST;
  - `lib/benchmarks/load.ts`, which reads only the current facts. It reuses the cash module's pure readers and `countryCode`, and writes nothing.

  The menu item sits under Insights after Competitors, with a size-feature row `nav.benchmarks` shown at every size. `lib/benchmarks/fence.test.ts` now reads all four roots. It checks there is no `fetch` other than `/api/benchmarks`, no URL other than the DOI, no database or Field write, no model import and no non-GET verb. It also checks that diagnosis, proposals, report, mode, validation, watch, execution, scorer, interviewer and profile code never import `lib/benchmarks`. `view.test.ts` checks the head, the foot and that no sentence judges. The screen is in `specs/ux-spec-v1.md` §3.

  Checked in the browser on Fernhill (all three lines compared), Lumen (turnover compared, margin and staff cost "Not compared yet" with their links) and Emberworks (no business type: one sheet with the link to 1.2). Each was checked at 375 px with no horizontal scroll (the formula is `.fig`, so it needed `white-space: normal` to wrap), and Fernhill also at 1280 px.

  Judgement calls:
  - **The menu label is "Similar businesses".** "Compared with similar businesses" wrapped to two lines in the rail; the kicker and page title keep the full name.
  - **The foot does not say "CC BY 4.0".** Eurostat's copyright notice applies CC BY 4.0 to its editorial content, and says statistical data may be reused "provided the source is acknowledged". The foot says "reused with the source acknowledged", then names the dataset, its DOI and both dates. It states the modifications and carries the non-responsibility line that the notice asks for.
  - **The reading word is neutral ink, never a colour.** A margin above the group isn't "good", and a staff cost below it isn't either.
  - **Size classes Eurostat never publishes are passed over silently.** Today that is `2-9` and `0_1` everywhere. The head names the first class that exists, so Fernhill's head reads "up to 9 people", not "2–9 people". A fallback sentence appears only when a published class lacks the figure.

- [x] **I-44.5** Demo seed: no new rows needed if Fernhill and Lumen already carry country, type, size and revenue; otherwise add the minimum. Browser check at 375 px.

  **Done 2026-10-29.** Fernhill needed nothing. It carries Ireland, `ecommerce_store`, a team of 2, monthly revenue (Shopify-measured, so OBSERVED), offers with costs and volumes, the costs lists and a team list with one paid employee. All three lines compare:
  - margin 33.4% against 1.2% for Irish online shops of every size;
  - turnover per person €265,854 against €730,550 for up to 9 people;
  - staff cost €22,800 against €40,840.

  Lumen carried country, type and size, but no revenue. The seed now answers 4.1 "yes" and 4.1a €21,000 a month, marked an estimate, through the normal `submitAnswer` path. That is the minimum: its turnover per person (€84,000 against €56,740 for Irish personal services with up to 9 people) compares as ESTIMATED. Its margin and staff-cost lines still show "Not compared yet", with links to the gross margin and the employees' pay, which demonstrates the refusals. Emberworks, never asked its type, shows the no-type sheet with the link to 1.2. Checked in the browser at 375 px on all three with no horizontal scroll, after `npm run db:seed-demo -- --fresh` on `syb_bench`.

**Done when:** a demo business sees its own margin and turnover per person next to a named, dated Eurostat cell; a missing input or cell says what's missing instead of guessing; and nothing from it reaches the diagnosis or a proposal.

- [ ] **I-44a** Decide whether a benchmark gap may ever appear in the diagnosis or prompt a proposal (for example a margin far below the sector's). Until then it only shows.
- [ ] **I-44b** Decide whether the purchases share (`PUR_SHARE_PC`, in the snapshot since I-44.1) gets a line of its own beside the margin, and whether the `EU27_2020` aggregate is ever a fallback when a country's cell is missing. Until then both are kept in the snapshot and shown nowhere: an EU-wide turnover per person compared against a Hungarian shop would mix price levels.

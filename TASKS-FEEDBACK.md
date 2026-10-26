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

Ideas 46 and 48 of the owner-facing feature list, on one new screen, Insights · Seasons & bundles (`/patterns`). Both are arithmetic over the business's own measured rows: no model and no network.

- [x] **I-46** Busy-season forecast (`lib/seasons/forecast.ts`, pure; `lib/seasons/load.ts`). It reads one source's series, picked by the chart archetype's own candidates (revenue, booking revenue, then orders or appointments), never two sources added together. Complete Monday weeks are set against the normal week (the median of the last 52, its middle half as the range), with busy ≥ 1.25× and quiet ≤ 0.8× for two weeks or more in a row. It also indexes the months, and the next eight weeks beside the same weeks 364 days before ("ran 2.0× your normal week; the same weeks this year start in 4 weeks"). A second or third year widens each range. Under 50 complete weeks of the last 52 it refuses, saying how much there is, what it can and can't say, and from when it can. It never fills a season from industry averages. **Not built, deliberately:** a busy stretch approaching doesn't yet feed the content calendar or a stock note as a proposal. That needs a decision on which proposal kind and when; it's noted as I-46a.
- [x] **I-48** Bundles and add-ons (`lib/bundles/pairs.ts`, pure; `lib/bundles/load.ts`, `lib/bundles/propose.ts`). The Shopify and WooCommerce syncs now keep each counted order's distinct product ids (`order_baskets`, migration 0057). They come from the order lines the sync already read under `read_orders`, so no query, path or scope was added, and the scope audit is unchanged. A re-read replaces its days, and no customer data is stored. A bookings business's baskets are visits: one client's completed appointments on one day. Pairs show with support, confidence from the rarer item, and lift against chance. A pair needs 5 baskets together, 1.2× chance and 50 baskets in all, and what falls under each line is counted. The pair's margin comes from the owner's own offer prices and costs, or is stated as unknown. "Propose this pair" drafts one `offer_change` proposal, module `bundles`, through the existing path. It is held before care and while watching, checked against the hard limits and suppression, and made once per pair per month. Both items stay at full price. Nothing executes it, and no price, product or checkout is written. Stripe carries no products, and the screen says so. Square till orders aren't read for baskets.
- [ ] **I-46a** Decide whether an approaching busy stretch should propose something (a content-calendar push, or a stock note for a webshop) and through which kind; until then the forecast only shows.
- [ ] **I-48a** Decide whether Square's till orders should feed baskets too (its line items, under the existing `PAYMENTS_READ`?). It needs Square's docs checked for the scope.

Demo seed: Fernhill's orders now carry two buying habits, each drawn from its own random stream so the rest of the story is unchanged: a pour-over set with a bud vase trio, and a serving bowl with a dinner plate (the bowl stays slow stock). Lumen's colour clients often stay for a gloss treatment in the next slot. Fernhill has a year of orders, so its seasons show. Lumen's 120 days of bookings show the refusal. Emberworks has no order history in the seed and shows the empty states.

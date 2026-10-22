# TASKS-FEEDBACK.md — the interview feedback round

Commit-sized tasks from Vilsta's customer-interview feedback (2026-10-19 to 2026-10-22). Numbers are the owner-facing feature list's (items 30–36 of 54; the list itself is a Claude Doc, "Ledgerline — what it does for owners"). Reference the item number in each commit message.

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

**Production, before these are live:** `db:migrate` through 0052, then `db:seed` for bank 1.7.0.

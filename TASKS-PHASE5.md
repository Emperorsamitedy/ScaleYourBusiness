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

- [ ] **P5-01** Two-window sell-through. From the inventory reads and the order baskets that already exist (`lib/stock`, `order_baskets`), compare the last N days with the N before, per product: units sold, the change between windows, and its noise band. The window A / window B comparison of step 88 is pure, deterministic and tested.
- [ ] **P5-02** Days of cover and stock-out warnings.
  - **Days of cover** is stock on hand ÷ the recent daily sales rate, as a range.
  - **The warning** fires when cover falls below the supplier's lead time (1.4.1.3 "delivery time in days", else a stated default marked ASSUMED). It reads "the blue mug runs out in about 6–9 days; your clay supplier takes 7".
  - **Where it goes:** the warnings land in the watch log and the weekly summary.
- [ ] **P5-03** Reorder suggestions as proposals (rule 27).
  - **Quantity:** sales over lead time + a safety margin, rounded up to the supplier's minimum order quantity, with its arithmetic shown.
  - **It's a note, not an order:** the action is `stock_reorder_note`, which the engine leaves unrouted. Approving it records the owner's intent and nothing else.
  - **Guards:** hard limits and suppression apply.
- [ ] **P5-04** The busy season feeds stock (closes I-46a's stock half). An approaching busy stretch from `lib/seasons` raises cover targets for that period, and says so: "last year this stretch ran 1.7× normal".
- [ ] **P5-05** The `/stock` screen gains the cover column, the warnings and the reorder notes (sheet design system). The demo seed shows one product nearing a stock-out.

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

- [ ] **P5-11** Page speed and mobile, from Google's public PageSpeed Insights API (read-only; `PAGESPEED_API_KEY` optional, and the screen says when the shared quota is used).
  - **Pages:** the home page and up to four key pages (a product, a service, the cart or booking entry, contact).
  - **Measures:** LCP, CLS, INP (field data where available), page weight, tap targets and contrast, at mobile and desktop.
  - **Storage:** results are kept as observations with provenance. A fake serves tests.
- [ ] **P5-12** The path to buying, walked by reading pages (rule 30): clicks from home to checkout or booking entry, price visible on the first screen, the form-field count on contact and booking forms, broken links. Nothing is submitted.
- [ ] **P5-13** Findings feed the report. Each is a `SiteFinding` (spec §2), `kind: "measured"`, with a severity from stated thresholds. A rule-of-thumb € figure is shown only where the owner's own conversion and traffic exist, otherwise "not computed". `/site` shows the audit beside its existing before/after wording.

## Session D — Sales pipeline for B2B _(~2 wks)_

Step 92. Shown only when 6.1a is `b2b` or `both`; branching lives in data (rule 4).

- [ ] **P5-14** Deals. A `deals` table:
  - **Who:** contact or company (Phase 4 contacts);
  - **Stage:** the bank's vocabulary; lead → qualified → proposal sent → won / lost;
  - **Value:** `Money`;
  - **Plus:** expected close, next step and its date, provenance;
  - **Erasure:** with the contact (rule 29).
- [ ] **P5-15** Pipeline maths (pure): weighted value as a range from the business's own win rate (stated or measured), stage ageing, and stale deals (no next step, or a next step past its date).
- [ ] **P5-16** Follow-ups as drafted proposals: "Nobody has spoken to Café Nua in 23 days". A follow-up email is drafted in the owner's voice and goes through consent (rule 23) and the approval queue; nothing is sent automatically.
- [ ] **P5-17** The `/pipeline` screen: stages as columns, deals with value and age, the stale list, and import from CSV with the same attestation as contacts (P4-03).

## Session E — Staff planning, by role _(~2 wks)_

Step 93. Off by default (rule 28).

- [ ] **P5-18** The team module switch on `/watch` (Modules), off by default. When off, nothing in this session runs or shows.
- [ ] **P5-19** Coverage by hour (pure).
  - **Demand side:** bookings utilisation (`lib/bookings`), trading-hours demand (`lib/hours`), and the busy season.
  - **Supply side:** role hours from 9.2 (role, hours a week).
  - **Output:** hours where demand runs over the stated capacity, and hours staffed with little demand, as ranges.
  - **Rule 28:** names are never read, and a test passes a named roster and proves the output is identical with the names removed.
- [ ] **P5-20** The `/team` screen: a role × hour grid of over- and under-cover, with the reasoning in words ("Saturdays 10:00–14:00 ran 96% booked; one teacher covers 8 seats"). Suggestions are notes for the owner; nothing about any person.

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

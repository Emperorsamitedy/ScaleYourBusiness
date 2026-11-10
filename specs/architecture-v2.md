# SYB architecture v2 — the five subsystems

> **Superseded as the spec of record by `specs/syb-v1-build-spec.pdf`**
> (the owner's full "SYB v1 build spec", Nov 9 2026, received 2026-11-10).
> Section 2 below is that spec's section 2. Where a decision here conflicts
> with the full spec, the full spec wins; the "Decisions after the full
> spec" list at the end says which ones changed and records the owner's
> answers to the three questions the full spec left open.

Received from the owner on 2026-11-10. Phase 7 builds it — `TASKS-PHASE7.md`.
Where this file and CLAUDE.md disagree, this file wins for the subsystems
below; the eight non-negotiable rules in CLAUDE.md still hold everywhere,
except rule 12 at station 4 (see D21).

## Hard rules (override anything else)

1. No external side effect without `ComplianceGate.check()` passing, a Trust
   Ladder authorization, and an open Proof Ledger measurement plan.
2. The Proof Ledger is append-only. Enforced with a DB trigger, not app code.
3. A derived figure inherits the LOWEST confidence grade of its inputs.
4. Peer benchmarks below k=7, or where one business exceeds 25% of an
   aggregate, are never rendered in any form.
5. Partner access to a business requires an active, unexpired mandate record.
6. Phone answering ships behind a country flag defaulting to blocked.
7. Every generated asset is labelled at render time, never at upload.

Tests for the acceptance criteria are written before the implementation.

## Architecture

Five subsystems, one dependency chain. The Proof Ledger sits at the centre:
every other subsystem either writes to it or reads from it, and nothing in
SYB may change the outside world without passing through it.

Call order for any agent action, with no exception path:

1. `TrustLadder.authorize(business_id, capability, proposed_action)` — BLOCKED,
   SHADOW, NEEDS_APPROVAL or AUTHORIZED
2. `ComplianceGate.check(business_id, capability, country, payload)` — CLEAR or
   a list of blocking reasons; a failure here overrides any ladder authorization
3. `ProofLedger.open_measurement(action)` — written before execution, returns a
   measurement_id; execution without one is a hard error
4. Execute, or in SHADOW record the counterfactual only
5. `ProofLedger.close_measurement(measurement_id)` at window end — scores the
   action in euro
6. `TrustLadder.record_outcome(...)` — feeds promotion eligibility

| Subsystem | Owns | Reads from | Writes to |
|---|---|---|---|
| Proof Ledger | Measurement plans, holdouts, euro scoring, append-only record | Connectors, Data Integrity layer | Immutable ledger, business verified-euro counter |
| Trust Ladder | Per-capability autonomy state, promotion eligibility, standing rules, emergency stop | Proof Ledger outcomes | Capability states, audit trail |
| Peer Benchmark Network | Cohort assembly, k-anonymity enforcement, benchmark serving | Anonymised business metrics, Eurostat fallback cache | Benchmark cache |
| Partner Console | Firm accounts, client book, mandates, white-label config, revenue share | All of the above, scoped by mandate | Firm-level aggregates |
| Entry Funnel | Free three-minute diagnostic, credited full diagnosis, subscription lifecycle | Peer Benchmark Network | Lead records, Stripe subscriptions |

### Invariants (written as tests before features)

- I1. No external side effect without a closed ComplianceGate check and an open measurement.
- I2. Ledger entries are append-only: corrections are new entries referencing the original, never edits.
- I3. A capability at station 1 or 2 can never produce an external side effect, regardless of caller.
- I4. A benchmark below the k-anonymity floor is never rendered, not even rounded or bucketed.
- I5. Partner access to a client is always scoped by an active, revocable mandate record.
- I6. Emergency stop sets every capability for that business to station 1 within one second and cancels pending approvals.

## Decisions recorded 2026-11-10

The owner answered "Use your defaults" to the eight open questions. Each is
binding until the owner changes it here.

- **D1 — acceptance criteria.** Only section 2 was supplied. The tests are the
  invariants I1–I6 and hard rules 1–7 above.
- **D2 — stations and CLAUDE.md rule 12.** Four stations: 1 BLOCKED,
  2 SHADOW, 3 NEEDS_APPROVAL, 4 AUTHORIZED. A capability with no recorded
  station is at 3 — exactly today's behaviour. Nothing reaches 4: promotion
  rules are not defined, so promotion eligibility answers "not eligible —
  the rules are not defined yet" with the outcome counts it has. Rule 12
  (nothing executes without a recorded human approval) is unchanged; the
  engine still requires an approved proposal at every station.
- **D3 — where it runs.** The call order lives inside `lib/execution/engine.ts`,
  the one door every agent action already passes through, after its existing
  read-only guards and before anything is claimed or sent. The Proof Ledger is
  its own table, protected by a trigger the same way `decision_log` is
  (migration 0010).
- **D4 — confidence grades.** A ≥ 0.85, B ≥ 0.70, C ≥ 0.50, D below, over the
  existing 0–1 confidence. A derived figure's grade is the lowest of its
  inputs' grades — computed from the inputs, never from the ×0.9-haircut
  number (data-model-v1 §8.1 records the same).
- **D5 — ComplianceGate v1.** Business-level rules only (a list, each with a
  named reason): an external capability needs a live write consent for that
  provider; phone answering needs the business's country on the allowlist
  (D6). Per-recipient consent (rule 23) stays in the campaign provider, which
  already filters every recipient; AI disclosure (rule 20) stays in the phone
  line and widget scripts. Per-country rules are added as the owner supplies
  them.
- **D6 — phone country flag.** `PHONE_ANSWERING_COUNTRIES` is a comma list of
  ISO alpha-2 codes; empty (the default) blocks every country. A blocked line
  answers with its closed message — the business's name, that it is automated,
  that it can't take the call — and the owner can't switch it on, with the
  reason named.
- **D7 — peer benchmarks.** A business contributes only after an explicit
  opt-in, stored as a consent record (who, when; withdrawable). Eurostat stays
  the fallback. k ≥ 7 distinct businesses AND no single business above 25% of
  any aggregate's numerator or denominator, or nothing is served — no number,
  no rounding, no bucket, no "fewer than seven".
- **D8 — Partner Console and Entry Funnel** are built last, once the owner
  confirms subscription prices, the diagnosis credit and the partner revenue
  share. I5's test lands with the Partner Console.

### Where the spec was silent — the stated choices

- **D9 — resuming after a stop.** The stop records each capability's station
  before it set them to 1; resuming (a signed-in owner, as today) puts them
  back. Proposals the stop cancelled stay cancelled.
- **D10 — "verified" euro.** A closed measurement adds to the business's
  verified-euro counter only when it was scored against a holdout and its
  grade is A or B. Totals are per currency, never converted (CLAUDE.md
  rule 1). A correction replaces its original's score in the counter; both
  entries stay.
- **D11 — scoring.** Each capability scores through its own measurer. A
  capability with no measurer yet closes its measurements at window end as
  unscored, with the reason, and adds nothing to the counter.
- **D12 — the measurement window** is 28 days unless the capability's
  measurer names another.
- **D13 — peer metric v1** is average order value (monthly revenue ÷ orders a
  month), cohort = same business type, in the reader's own currency only.
- **D14 — undo.** An owner's undo reverses an action that was already
  authorized, measured and run; it stays outside the call order. The emergency
  stop still blocks it, as before.
- **D15 — reading peer benchmarks** needs no opt-in; contributing does. A
  business is never part of its own cohort.
- **D16 — a purchase order's write consent is its approval.** It goes out from
  SYB's own email service, with no account of the business's to connect, so
  ComplianceGate's write-consent rule doesn't apply to it.
- **D17 — a stop pressed mid-flight** is caught by the ladder (every station is
  already 1) before anything is claimed, and reported as the stop.
- **Not yet routed through the ladder:** phone answering (it has its country
  flag, D6), the weekly WhatsApp summary and support replies — TASKS-PHASE7 P7-17.

## Decisions after the full spec (2026-11-10)

The full spec answers most of D1–D17. These replace the earlier choices:

- **D1 → superseded.** Each section's acceptance criteria (§3.7, §4.7, §5.7,
  §6.6, §7.7, §8.6, §9.5, §10.6, §11.5) and §12.1's definition of done are
  the tests.
- **D2 → superseded by §4.** Stations are Observe, Recommend (shadow), Act
  with approval, Act within limits. Promotion follows §4.3's rules per
  capability; auto-demotion after two consecutive losses; caps (§4.4) are
  required before station 4; purchase orders stay at station 3 forever.
- **D4 → superseded by §6.1.** Grades come from provenance, not a numeric
  band: A measured and cross-checked against a second source, B measured from
  one connected system, C derived from measured inputs with modelling
  assumptions, D anything that depends on an owner-stated number.
- **D5, D6 → superseded by §9.** ComplianceGate is a rules engine over a
  per-country matrix held as configuration (a database table, changed
  without a deploy, every change audit-logged). Phone answering is blocked
  wherever the matrix row is blocked — every country by default.
- **D7, D13 → superseded by §5.** Contribution is on by default with a
  one-tap opt-out; only connector-measured values enter a cohort; benchmarks
  are served as p25/p50/p75 plus the owner's percentile.
- **D8 → superseded by §7.5 and §8.3.** Prices are set in the spec.
- **D10–D12 → superseded by §3.** Plans carry their own design, window and
  grade; the counter is §3.4's formula, losses included.

The owner's answers to what the full spec left open:

- **D18 — the five live businesses stay at station 3.** Their approval queue
  keeps working. Businesses created after the rollout start at station 2 for
  their first 30 days (§4.2).
- **D19 — no tier ceiling while payments are unarmed.** As with the report
  gate today, the tier ceiling (§8.6) is enforced from the moment Stripe keys
  exist; promotion rules apply regardless.
- **D20 — Hungary is the launch market.** Hungarian and English live; the
  other five languages go behind the locale flag until each passes the
  coverage check (§1, §11.3).
- **D21 — CLAUDE.md rule 12 at station 4.** §4.1 defines station 4 as "acts
  inside owner-set limits, reports after": no per-action approval within the
  caps. Every other station keeps rule 12. Purchase orders never reach 4.

## Decisions taken building Phase 0 (2026-11-10)

Where the full spec left a detail open, the choice made and why. Each is
binding until the owner changes it here.

- **D22 — what the matrix's `blocked` blocks.** §9.2 defines the matrix for
  the regulated capabilities, so `blocked` (default true) blocks phone
  answering and the recording and transcription beside it, and
  `outbound_blocked` (default true) blocks outbound AI calling — which the
  table refuses to unblock before inbound. A third flag, `execution_halted`
  (default false), is §9.5's "cannot execute even at station 4, even with an
  owner override": it stops every external capability for businesses in
  that country. Reading `blocked` as "every capability" would have stopped
  every live business in Hungary until counsel signs the phone row. A
  country with no row is blocked for the regulated capabilities and not
  halted. AI disclosure can never be switched off (a table check).
- **D23 — PHONE_ANSWERING_COUNTRIES is superseded by the matrix.** Its
  parser stays, but nothing obeys it. A deployment that had phone answering
  switched on through the variable needs the country's matrix row, with
  counsel's sign-off, before its lines answer again.
- **D24 — grades of the other SourceRef kinds (§6.1).** A connector reading
  and an aggregate of connector series are B; a parsed document is B; web
  research, a system default, and a peer or official reference standing in
  for this business's own number are C (a model); an owner's answer typed
  or said is D; an inference whose inputs aren't all connector series is D,
  since its reference alone can't show it rests on nothing stated.
- **D25 — the bank-statement connector reads closing balances only** in
  Phase 0, as I-54a does. Reading money-in as revenue (§6.2's "uploaded bank
  statement that parses cleanly") lands with Phase 3's Diagnosis Grade,
  where it is decided what a deposit counts as.
- **D26 — the numeric grade bands (D4) are kept, not deleted**, for the 0–1
  confidence the profile still carries; no figure takes its grade from them.

## Decisions taken building Phase 1 (2026-11-10)

- **D27 — where the daily chain head goes.** §3.5 asks for an append-only
  store the application can't rewrite (S3 Object Lock in compliance mode, or
  equivalent). No such store is configured, so the head is published daily
  to `ledger_chain_heads` (append-only by trigger) and `publishChainHead`
  takes an external writer for when one is: its reference is kept with the
  day's row. Until then a head is as durable as the database; the public
  verify endpoint (`GET /api/ledger/verify`) lets anyone holding an earlier
  head check the chain still ends in it.
- **D28 — the spec's money columns are minor units in the plan's currency.**
  `expected_effect_eur` and the rest are `*_minor` with the plan's
  `currency` (CLAUDE.md rule 1); nothing is converted, and the counter sums
  per currency.
- **D29 — designs SYB can't run yet aren't claimed.** §3.3's preference
  table is data (`DESIGN_PREFERENCE`); no holdout, split or switchback is
  built yet, so every plan is pre/post (grade C at best) or unmeasurable,
  with the downgrade's reason recorded on the plan.
- **D30 — a plan's forecast is its proposal's scenario.** Base case as the
  point, downside and upside as the range, the monthly profit change scaled
  to the window. A proposal without money in its base case gets a plan that
  says no forecast was made, and stays out of the calibration score.
- **D31 — verdicts come from the observed interval.** Wholly above zero is a
  verified gain, wholly below a loss; straddling zero is no effect when the
  interval is no wider than the expected effect, otherwise inconclusive.
- **D32 — a plan is scored at window close, never earlier**, and a stop or a
  failed run leaves it to close inconclusive at its window's end.
- **D33 — Session A's `proof_ledger` is kept, not written.** The engine
  writes `measurement_plans` and `ledger_entries`; the old table, its
  module and its tests stay as they were.

## Decisions taken building the multi-market foundations (2026-11-10)

The owner's multi-market spec (Parts A–E) and their answers of 2026-11-10:
clean ledger rebuild, placeholder quotas, segments "by form, then staff",
screenshot slots for the NAV guide.

- **D39 — SYB's own spend caps stay in euros.** The support, review and
  follow-up budgets are SYB's own money, kept in SYB's books in EUR; saying
  "this month's support budget (€5) is spent" is not a converted figure of
  the business's. A business's own money is never shown converted.
- **D40 — the ledger's clean rebuild.** The v1 ledger tables were never
  deployed; the local test rows were cleared and the chain restarts with the
  EUR projection inside every hash. No chain_version split is carried.
- **D41 — revenue doesn't decide the segment.** A revenue band would need
  thresholds per currency, and comparing across currencies is forbidden. A
  business whose legal form or size isn't known has no segment (and no cap)
  until it is — it isn't guessed into one.
- **D42 — a currency's presentation is data.** `presentation: home` renders
  with the currency's own symbol and separators everywhere (HUF: "35 413 Ft"
  whoever reads it); `reader` uses the reader's language with the table's
  decimals (EUR, written differently across the euro area).
- **D43 — price resolution.** A country's own enabled row prices it, else the
  default row. A billing/VAT mismatch is flagged and priced at the market
  with the higher PPP index — compared as indices, never through FX.
- **D44 — the regional benchmark rung, for money, counts only neighbours in
  the reader's own currency.** A cohort has one currency (§A.7) and nothing
  is converted to compare.
- **D45 — NAV.** Query-only, three operations, its own nightly runner. A
  technical user NAV rejects (or three failed syncs in a row) marks the
  connection failed with a Hungarian reconnect message; what was read stays.
  The guide's screenshot gate is checked at runtime and on /ops, so the test
  suite stays green while the owner's screenshots are on their way.
- **D46 — the price-book startup check** fails the start when a country's own
  prices are on while any quota is unconfirmed; a database that can't be
  reached at boot is logged, not fatal.
- **D47 — the partner per-client HUF rows** apply Hungary's list ratio (about
  235 Ft per euro of list price) to §7.5's €39 / €29 / €22: 9 000, 7 000 and
  5 000 Ft. Seeded off, for the owner to confirm.
- **D48 — known gap: the LLM cost meter** estimates EUR from USD prices with
  a fixed rate in lib/llm/pricing.ts. It is SYB's internal cost estimate, not
  a business's money; moving it to stored ECB rates is a follow-up.

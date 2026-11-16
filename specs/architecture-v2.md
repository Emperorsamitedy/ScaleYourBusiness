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
  *Closed in Phase 3 (2026-11-12):* the meter loads the stored ECB USD rate
  once a day and prices with it; the fixed rate is only the fallback while
  no rate is stored.

## Decisions taken building Phase 2 (2026-11-10)

- **D34 — what a standing rule's expiry does.** An "allow" widens what SYB
  may do, so once expired it stops applying; a "forbid" or
  "require_approval" narrows it, so it keeps binding past its date, still
  flagged for renewal, rather than loosening SYB's leash by the calendar.
  Rules surface for renewal in their last 14 days. The owner's free-text
  boundaries (Phase 3 rule 14's hard limits) stay the owner's never-list.
- **D35 — where the 30-day shadow period starts.** A business's shadow
  period (`business_profiles.shadow_until`) is set when its intake starts
  through the app's own start route, not by every internal bootstrap, so
  the five live businesses and every existing test business keep station 3
  (D18). A recorded station always wins over the period.
- **D36 — station 4 in the engine (D21).** A pending proposal for a
  capability at station 4 runs without a per-action approval only when its
  provider can state the action's size and targets (`capFacts`), the stored
  caps say "within", and no standing rule forbids it or asks for approval.
  Anything else stays pending for the owner — station 3 behaviour — or is
  refused with the reason. The engine records the station-4 decision on the
  proposal and in the decision log as an approval by the ladder, never by a
  person.
- **D37 — auto-demotion counts outcomes since the last move.** Two
  consecutive loss verdicts on a capability, both recorded after its last
  station change, drop it one station and leave an owner notice carrying
  both plan and entry ids. A gain or a no-effect in between resets the
  count. Shadow losses count too: a capability whose recommendations would
  have lost money twice in a row drops from 2 to 1.
- **D38 — blackout windows read in UTC** until the business's timezone is
  threaded through the engine; the caps screen says so. *Closed in Phase 3
  (2026-11-12):* quiet hours, quiet dates and the "today" a daily cap counts
  are read on the business's own clock (presence.timezone); UTC only when no
  timezone is known.
- **D49 — ceilings over every station.** A station never passes the
  business's segment ceiling (a sole trader: 2) or, once Stripe keys exist,
  its tier's (Watch 2, Act 3, Autonomous 4). A business with no subscription
  keeps station 3's behaviour, as the five live businesses do today (D18).
- **D50 — the rule-12 constraint, amended at station 4 only.** The database
  still requires a person behind every approval and rejection; the one
  exception is a proposal the ladder approved within the owner's caps, marked
  `approved_within_limits` and logged as the system's approval.
- **D51 — raising a station goes through the evidence, everywhere.** The
  public setStation only lowers; changeStation and the request/confirm pair
  are the only ways up, and no "raise everything" call exists.

## Decisions taken building Phase 3 (2026-11-12)

- **D52 — what a deposit counts as.** An imported bank statement with a
  credit column, or one signed amount column, has each day's money in
  summed and written as `cash.money_in.daily`: every deposit, positive
  amounts only, nothing told apart (descriptions and payees are still never
  read, so a transfer or a loan counts too). It makes the statement a
  revenue-side source for the Diagnosis Grade (§6.2's "uploaded bank
  statement that parses cleanly"), and two sources agreeing within 5 % still
  earn A. It is never called revenue where a figure is shown, and `sideOf`
  keeps it on neither side. Closes D25.
- **D53 — monthly re-diagnosis rides the weekly beat.** No cron of its own:
  the Monday job re-runs a business whose latest report is 30 days old or
  older, at most 25 a run. An unchanged profile returns the existing report
  with no model call, and the plan's quota guard still applies.
- **D54 — HUF printed in whole forints in recommendation words too.** The
  break-even sentences use the currency table's rounding, so 1,498.80 HUF
  reads 1,499 HUF; the arithmetic behind it is unchanged.
- **D55 — the leak register shows money only at grade A or B**, the same
  gate as the headline; below it the leak shows its grade and how to raise
  it.

## Decisions taken building Phase 4 (2026-11-12)

- **D56 — NACE at 4 digits is data.** `specs/peer-cohorts-v1.json` gives each
  business type its finest NACE Rev. 2 code (the classification Eurostat SBS
  still publishes), and a cohort widens by cutting it: "56.30" → "56.3" →
  "56". A type broader than any 2-digit division (construction, professional
  services, logistics, manufacturing) is held at its section letter, its only
  level. "other" has no cohort. Each code is SYB's reading, for the owner to
  correct.
- **D57 — contribution on by default (§5.5), supersedes D7.** The consent
  table is kept and reread: a business's latest row decides, a live row is in,
  a withdrawn row is out, and no row at all is in. Opting out of a business
  that never chose writes a row that is out from the moment it is written.
  Every row is kept. D15 stands: reading needs nothing, and a business is
  never in its own cohort. Aggregates are computed live, so an opt-out leaves
  the very next one. The DPA basis is counsel's
  (`specs/peer-benchmarks-dpa-notes.md`).
- **D58 — the reader's band comes from their measured month only.** A reader
  with no measured month is compared across every band. A stated revenue
  never places anyone in a band, and never contributes (§5.3).
- **D59 — the distribution's arithmetic.** Quartiles are linear between ranks
  over integers (minor units, or basis points for a share), from one exact
  division. The reader's percentile counts below, plus half of equal. The 25 %
  revenue check is made in euro, for weighting only. A metric's own
  numerator and denominator are checked only where they add up (one
  currency, or counts). A zero total has no dominant business. Known
  property: at k = 7 the median is one member's value, though not whose; the
  floor, the fixed ladder and the dominance rule are the protection, and the
  extraction-attack test holds them.
- **D60 — what is measured now.** Average order value, revenue per employee
  (with the owner-stated headcount, as §5.3 says), ad spend as a share of
  revenue, and no-shows with late cancellations. Gross margin, repeat customer
  rate, CAC and payback, busiest hours and stock turns show "not measured
  yet" until a measured source exists. They are never filled from what an
  owner said. D13's `peerAverageOrderValue` keeps its call and now answers
  with the measured cohort's median.
- **D61 — the band widens to every band**, not to the bands next to it.
  §5.1's region groups are the country's fallback; FR and IT are groups of
  one, and a country in no group widens straight to the band. The
  multi-market resolver's neighbour rung (§D.1) stays as it is for its own
  callers.

## Decisions taken building Phase 5 (2026-11-12)

- **D62 — the free entry calls no model.** §8.2's six questions are
  answered from data (`specs/entry-v1.json`): sector, country, a monthly
  revenue band (§5.1's yearly bands ÷ 12), headcount, one channel question,
  and one operations question chosen by sector group. The one leak is the
  first rule that holds, priced as the band's midpoint × a low and a high
  rate. Every rate is SYB's rule of thumb, labelled grade D and "your
  estimate", with the rate shown, for the owner to correct. The euro range
  is in euro, as §8.1 says. The peer comparison is revenue per person from
  the live cohort, in euro only. The lead keeps the answers and the result,
  never a person; the share token keeps the referral chain (§5.6).
- **D63 — "rolls forward" means the window grows.** A quarter with fewer
  than 8 closed plans pays nothing out, and the next evaluation covers both
  quarters and both quarters' fees, until a quarter reaches 8. A credit is
  always one quarter's fee ("the next quarter is free").
- **D64 — the €49 credit is a one-time coupon on the first invoice**, at
  most that invoice's amount, created for that subscription only. It is
  recorded as a deferred credit when the diagnosis is paid and marked
  applied when the first invoice is paid. A credit in another currency than
  the subscription's is never converted: it waits for a person.
- **D65 — a downgrade is a new locked row.** The price lock covers the tier,
  so moving to Watch closes the current row and locks a new one at Watch's
  price on the same Stripe subscription, with no proration.
- **D66 — dormant means silence, not failure.** An active plan whose
  connected measuring connectors have sent nothing for 45 days has its
  collection paused (Stripe `pause_collection`, invoices voided), and the
  owner is told. A failed connector is a connector problem, not dormancy.
  Billing starts again only when the owner says so.
- **D67 — the guarantee is reproducible outside the application.** Each
  evaluation stores the standing ledger entries it read, with their chain
  hashes, and the SHA-256 of its canonical inputs. `scripts/verify-guarantee.mjs`
  (Node built-ins only) recomputes the outcome from an export and checks
  the hash. The credit is a negative customer balance on Stripe; with
  payments unarmed it stays pending, and that is said.
- **D68 — an extra business takes its parent's ladder ceiling**, and Watch's
  when its parent isn't live. Jobs ride the weekly beat: the guarantee once
  per quarter (idempotent per subscription and quarter), and the dormant
  check only when payments are armed.

## Decisions taken building Phase 6 (2026-11-12)

- **D69 — "enforced at the data layer" is a database function.**
  `partner_may(user, business, scope)` (migration 0117) is the one test: a
  live firm member, that firm's mandate for that business, unrevoked,
  unexpired, the scope in it. Every partner read and action in
  `lib/partners` puts it in its WHERE or asks it first, and nothing caches
  its answer, so a revocation applies to the very next request. A trigger
  lets a granted mandate change in one way only: its revocation, set once.
- **D70 — partners act as themselves.** A firm member is an ordinary SYB
  user acting through their own session, never through the client's door.
  Their firm role (principal, manager, staff) decides what they may do in
  the console; the client's mandate decides what they may do in the
  business. Approving a proposal goes through the same decision path as an
  owner's, logged with actor `partner` and the person's user id (rule 12
  holds: a named human). Every partner action writes a `partner_action`
  entry whose reference keeps the firm readable.
- **D71 — a client grants from the email with no account beforehand.** The
  emailed link proves the address. With no SYB user for it, the grant makes
  the business and its owner and signs them in on the connections page. An
  address that already uses SYB grants from Settings → Firms with access,
  signed in, for the business it chooses.
- **D72 — the book's money and order.** A leak's money shows only at
  Diagnosis Grade A or B, as on the owner's report (§6.2). Money stays per
  currency; ordering across currencies converts at the stored ECB rate for
  the sort alone, and no converted figure is shown (D44). The firm-level
  proof ledger (§7.4) is per quarter and per currency.
- **D73 — the sender domain is stored, not used yet.** A firm's emails go
  out from a domain only after it is verified with the email provider;
  until then SYB's own sender is used and the domain is kept.
- **D74 — the 30-minute onboarding is a timed test with a person**, like
  P0-71. The automated part (40 clients imported, asked and emailed in
  their languages) runs in seconds in the test suite.

## Decisions taken building Phase 7, the growth engine (2026-11-12)

- **D75 — the §10.2 brief extends the existing creative_briefs table**
  (P3-51) rather than adding a second one: trigger, evidence (§6.1 figure
  ids), subject, angle, assets required and supplied, locale, brand voice,
  measurement plan, and whether it depicts a real person. A brief written
  before §10 cites no figure, so it no longer renders until figures are
  cited (`citeEvidence`).
- **D76 — "no evidence, no generation" is held in three places.** The render
  paths call `requireGenerationBrief`. A trigger refuses a brief that cites
  another business's figure. A NOT VALID check plus a trigger make every new
  media_generations row name a brief that cites at least one figure; rows
  from before the rule stay as they were.
- **D77 — opportunity detection is data, not a model.** Each trigger lists
  the figure key prefixes that support it (`TRIGGER_KEYS`); the evidence of
  a brief opened from the studio is what detection found, never what the
  request sent.
- **D78 — the brand voice is confirmed before first use.** It is built from
  the voice card (the owner's own sentences and stated tone, each with its
  source) as plain lines, shown as a draft, and generation waits until the
  owner confirms it or writes their own words. An edit supersedes; a
  confirmed voice is never replaced by a rebuilt draft.
- **D79 — labelling records are keyed by the stored media.** They are written
  where the file is stamped (the two render paths), and a trigger refuses to
  queue or publish an AI-generated item without one. Items made before the
  rule were backfilled from their render stamp, which every generated file
  has carried since P3-53. The publish step stamps when it went out; the
  approval names who said yes.
- **D80 — the first three generated pieces wait for a yes at any station**,
  checked in the station-4 limits path before anything else. Ad promotion
  of an organic post needs station 4 on the ad capability (`canPromoteToAd`);
  publishing needs 3 (`canPublish`). Organic posts stay measured before and
  after, grade C at best (§10.5).
- **D81 — the library's upload route takes up to 4 MB** (photos and short
  clips, what a serverless body allows); longer footage arrives through a
  shot list's direct upload, as before. Connecting a Drive folder waits for
  a Drive connector.

## Decisions taken building Phase 8, compliance completion (2026-11-12)

- **D82 — the consent gate is asked by keypad.** Every call opens with the AI
  disclosure (Art. 50(1)), then asks consent to transcribe — and to record,
  when the owner switched recording on — with a keypad-only gather: a spoken
  "yes" would already be transcription. 1 is yes; 2, any other key or
  silence is no. Whether recording was asked is fixed when the call comes in.
  The strictest version is the only version: every country, every call.
- **D83 — the no-record path came first.** A refused call is listened to by
  keypad only, never by speech; it can be put through to a person by keypad
  (never recorded), or ends politely. Not even SYB's own lines are kept as a
  transcript, and speech that arrives anyway is dropped unread — the call
  completes with no transcript and no audio. A late 1 can't change it.
- **D84 — ContentLabeller is lib/compliance/labeller.ts**, the one statement
  of how SYB marks what a model made: the in-file stamp for images and video
  (unchanged, at render), a C2PA-style provenance manifest on every labelling
  record (generator, digital source type, visible label, method, standard,
  file hash), and an `X-AI-Generated` header on every AI-drafted email (the
  campaign sender and support replies) beside the visible line. Interactive
  surfaces keep saying they are an AI first, in their own modules.
- **D85 — a business's erasure is a request with an operator's completion.**
  The owner asks (owner-only, `business.erase`); from that moment the
  business is in no benchmark aggregate (no aggregate is stored, so there is
  none to recompute) and the request is in the decision log. A person removes
  the data and stamps completed_at — a whole-business deletion is not run by
  a button.
- **D86 — voiceprints don't exist in SYB.** §9.4 asks that enrolment sit
  behind its own flag, off by default, with nothing depending on it; there is
  no voiceprint code at all, and a source scan keeps it that way until a
  decision says otherwise.
- **D87 — counsel's sign-off is data, not a deploy.** The matrix already
  refuses to unblock a country without a dated sign-off and reference and
  logs every change; what is left is the owner's: counsel in each launch
  market signs the row.

## Decisions taken building the bookkeeper path for NAV (2026-11-12)

- **D88 — a firm sets up NAV through the owner's own door, client by
  client.** The multi-market spec §E.4's bookkeeper path is a walk across the
  book (lib/partners/nav), not a second way in: every row goes through
  connectNav exactly as an owner's would (queryTaxpayer at once, the
  registered name back, sealed under that business's own key, read-only
  operations only). A principal or manager runs it, never staff. Each client
  is asked of the database's partner_may with `manage_connectors` at that
  moment, so a client without that mandate is "not found" and nothing is
  stored for it. A firm shares each business's own hourly limit on NAV
  attempts, so it can't try more passwords against a business than the owner
  could. One client's failure is that client's outcome and the rest carry on.
  The answer is a fixed outcome code per client, never an input, and a
  failure's log line names only the account and the error's class. Every
  connection and every console revocation is in the owner's audit trail as
  the partner's own action. The owner keeps their own one-tap revocation; the
  firm's is a second door to the same wipe, under the same mandate.


## Decisions taken closing the accuracy gaps before launch (2026-11-17)

The owner asked for the accuracy risks to be fixed before going live ("ok
build it"). Two were found to be real: no plan was ever scored (the
measurer registry was empty, so every plan closed inconclusive), and a
served peer comparison at the privacy floor read as precise as one of
hundreds.

- **D89 — pre/post is scored as a difference in differences against the
  business's own same weeks a year earlier, or not at all.** The control
  D29 promised as "adjusted for the trend of similar businesses" was never
  built, and a cohort's monthly figures can't line up with a 28-day window;
  the business's own last year can, weekday for weekday. Each day after the
  action is compared with the same weekday a whole number of weeks before
  it (clear of the action's own day), minus the same comparison 364 days
  earlier. The interval is a 95 % t-interval on the daily effects (the t
  value conservative between tabled df), widened by the AR(1) factor for
  their lag-1 correlation (capped at 0.9), in integers end to end with an
  integer square root rounded up. It closes inconclusive, saying why, rather
  than score: no revenue for the same weeks a year earlier; under 75 % of
  the window's days measured in all four arms; more than one currency, or a
  series in another currency than the plan (nothing is converted); a metric
  other than revenue (gross profit and cash days aren't measured yet, and
  revenue doesn't stand in for them); or any other non-shadow, measurable
  plan whose window touches these weeks or the same weeks a year earlier —
  one business-wide series can't tell two actions apart, so neither is
  credited. A missing last day is waited for 3 days, then scored without
  it. The grade stays C (§3.3: pre/post caps at C, whatever the control);
  holdouts remain the only way to A. Tradeoff accepted: a business that
  runs actions back to back, or connected less than about a month before
  acting, earns no verified figure until it doesn't — the counter undercounts
  rather than overcounts.
- **D90 — a served peer comparison says how far it can be leaned on.** The
  k ≥ 7 floor protects privacy, not precision: at seven the median is one
  member's value. A comparison is "a rough guide" — said beside the figure,
  with each reason named — below 20 businesses, or when the ladder widened
  to the 2-digit division, a region, or every size; a 3-digit widening alone
  stays fair. Nothing is blended to make it look steadier (§5.4, P7-64), and
  no order statistic is shown (a cohort's extremes are its members' own
  values). A shared entry result saved before this derives its label from
  the cohort size and widenings it saved.

## Decisions taken opening and building the idea check (2026-11-17)

The owner opened TASKS-IDEAS.md ("build and ship it") after being offered
the defaults to its five open questions; the defaults are taken as D91.

- **D91 — the idea plan's open questions, answered by default.** (1) The
  short idea check is free and needs no account; a full version kept on an
  account is part of the paid plans. (2) Keeping an idea for the launch
  handover needs an account; the free check is anonymous and shared by
  token, like `/check`. (3) Recruitment-based income is explained, never
  worked through (rule 39). (4) Local competitor density is left out until a
  source of record is chosen. (5) Countries outside the EU get the money
  maths and say they have no market figures. Shipped in two parts: part 1
  (the free check, I-01..I-03, I-20..I-23, I-30..I-31, I-40..I-42); part 2
  (I-10, I-11 in the bank, I-32, I-50..I-52) keeps an idea on an account and
  hands it over at launch.
- **D92 — survival rates come from bd_9bd_sz_cl_r2, all three from one
  table.** The newer bd_size (from 2021) publishes only the 1-year rate so
  far, and the two tables differ in method; mixing them would set a 2023
  one-year rate beside 2020 three- and five-year rates from another method.
  So V97041/43/45, every size class together, the latest year per cell
  (2020 at retrieval), the year and Eurostat's break-in-series flag shown.
  A type's own NACE code, then its parent group, said so; never another
  country. Refreshed by hand (`npm run demography:fetch`).
- **D93 — the free check is a form from `specs/idea-v1.json`, not the
  question bank.** Like `/check` (entry-v1.json), it is a fixed set of
  structured questions with its branching as data (`unless`); the bank's
  idea section (I-11) and free-text extraction (I-12) belong to part 2's
  conversational version. No model is called: every figure is arithmetic.
- **D94 — the riskiest assumption is ranked among the estimates only.** As
  a share of itself, the price always has the least room in a plan that
  covers its costs (revenue is the largest base), so ranking it would always
  name the price and say nothing. The price is a decision and is shown as a
  lever. Among customers, cost per sale and monthly costs the least room
  wins (in practice the customers, unless each sale's own cost outweighs
  what it leaves); and when the plan's revenue per person is above the
  sector's (Eurostat, outside the ±15 % band), the customers are the
  riskiest whatever the room, said so.
- **D95 — the next test's lines come from the plan's own break-even.** A
  pre-sale passes at a quarter of break-even customers and fails below a
  tenth, both rounded up; business buyers get ten conversations, three paid
  pilots to pass, none to fail; a cost gets three written quotes, passing at
  the stated figure and failing at its breaking point. They are stored with
  the result when it is made (rule 41), so a shared check shows the lines as
  they were set.
- **D96 — an idea is its own business, and the database keeps it from
  operating (part 2).** One account holds one profile (the v1 invariant),
  so keeping a check makes a NEW account and profile for the same verified
  email, as "add a business" does (idea 52), created as `kind = 'idea'`
  from the start: triggers in migration 0124 refuse any connection,
  proposal or execution for an idea, refuse turning an operating business
  into an idea, keep a launch date as it was, and keep test results
  append-only. Triggers rather than a check at each call, because a
  connection is made in seven places. What was stated is written as owner
  facts where the data model has a field, the plan's monthly revenue
  included with a note that it is planned; measured sales supersede it
  after launch (rule 3) and I-51 sets the plan beside them, never swapped.
  Sign-in has no return path yet, so a signed-out person is told to sign in
  and come back to the shared check. The conversational version (I-11's
  bank section, I-12's extraction) is not in part 2: the form covers the
  same inputs, and the interviewer is its own piece of work.
- **D97 — the conversational version is a description read into the form,
  not new bank questions.** The bank already models an idea: question 1.5's
  `identity.stage` has the code `idea`, and its pre-launch questions read
  it. So keeping an idea writes `identity.stage = idea` (and launching,
  `recently_launched`), an idea business opened at `/intake` goes to its
  plan, and the operating interview never asks it trading questions. I-11's
  "idea section of the bank" is therefore not added: the idea's own inputs
  stay in `specs/idea-v1.json` (D93), and growing the bank the interviewer
  sends every turn by thirteen questions would buy nothing the form lacks.
  I-12 is a free-text "describe your idea" box: Haiku reads it into the
  form's answers under a fixed schema, every value re-checked against the
  form's own lists and bounds, nothing kept, each filled answer marked "from
  your description" until the person touches it and sends the form. Public
  like the free check, so its spend is capped per address (10 an hour) and
  for everyone (300 a day), and costed under workload `idea_describe`
  against the nil-UUID "no account" line, since llm_calls needs an account
  and a visitor has none.
- **D98 — local competition is a dated snapshot of map counts, offered city
  by city.** The owner chose it on 2026-11-17 ("Local competition"), lifting
  TASKS-IDEAS's "not in scope". OpenStreetMap is the only open source of
  record for places by kind (ODbL, attribution shown with every count). A
  live query per check was tried and refused: the public Overpass server
  took 36–44 s a count and often answered 502, and its mirrors timed out.
  So, as with Eurostat (D92), a script run by hand (`npm run local:fetch`)
  writes `specs/local-counts-v1.json`: each country's three largest cities
  from Wikidata (CC0: population, OSM relation, names in the seven
  languages), and per city, inside its own boundary, one count per group in
  `idea-v1.json`'s `local.groups`. The run is resumable and polite; a city
  that never answered is left out, and the city question offers only
  counted cities ("somewhere else" otherwise). Shown: the count, places per
  10,000 residents, and the same for the country's other counted cities.
  A count is a floor, never a total, and is said to be one (rule 37); a
  business type that sells online, is too broad, or is rarely mapped gets
  its reason and no number. Population is Wikidata's largest truthy value.

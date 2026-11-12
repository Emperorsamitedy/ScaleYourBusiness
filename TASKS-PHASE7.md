# TASKS — Phase 7: SYB v1 (the owner's build spec)

**Opened 2026-11-10 by the owner.** The spec of record is
`specs/syb-v1-build-spec.pdf` — sections 1–13, built in its §12 phase order,
each phase's gate passing before the next starts. Decisions taken against
it, including the owner's answers D18–D21, live in `specs/architecture-v2.md`.

The spec's seven hard rules (§12.2), its six invariants (§2) and §12.1's
global definition of done are this phase's non-negotiables. CLAUDE.md's
rules 1–8 and every earlier phase's rules still hold, except rule 12 at
station 4 (D21). Nothing in the existing feature list is deleted (§1).

Sessions A and B (2026-11-10, commit 41c03a3) built the first cut of the
centre against section 2 alone. The phases below rework it to the full
spec where it differs, and build the rest.

---

## Phase 0 — Foundations (§11.1, §6.1, §9)

- [x] **P7-30** Connector contract over the existing providers: authorize,
      health, pull → normalised events, push (execution side), capabilities,
      cost_model
- [x] **P7-31** The figure provenance object: value, currency, source
      (measured, stated, derived, peer, official), source_detail, captured_at,
      grade A–D by provenance, depends_on; a derived figure takes its
      inputs' lowest grade, and C at best when it models
- [x] **P7-32** ComplianceGate as a rules engine over a per-country matrix
      table, editable without a deploy, every change audit-logged

**Gate:** a Stripe connector and a bank-statement parser both produce
normalised events with grades attached. — **Passed 2026-11-10**
(`lib/connectors/contract.test.ts`, "PHASE 0 GATE"). Built: `lib/core/grade.ts`
(provenanceGrade, sourceGrade), `lib/figures/figure.ts` and the `figures`
table whose trigger refuses a laundered grade, `lib/connectors/contract.ts`,
`lib/compliance/matrix.ts` with the audit-logged matrix, the rules engine in
`lib/compliance/gate.ts`, and the matrix editor on /ops. Decisions D22–D26.

## Phase 1 — Proof Ledger (§3)

- [x] **P7-33** `measurement_plan` with §3.2's fields, immutable once opened
      (edits refused and logged as tamper events; window_end can't move)
- [x] **P7-34** `ledger_entry` with verdicts, observed range, net, forecast
      error; append-only by trigger; corrections name the original
- [x] **P7-35** SHA-256 hash chain, a verify endpoint that finds the first
      break, the daily chain head published to an append-only store
- [x] **P7-36** `MeasurementRequiredError`: no plan, no run
- [x] **P7-37** The headline counter (§3.4): losses in, inconclusive and
      unmeasurable shown apart as "not yet proven", SYB's fee as its own line
- [x] **P7-38** Calibration score: median absolute forecast error over the
      trailing 20 closed plans, per business and globally

**Gate:** the database refuses a ledger update; verify catches one altered
byte; a seeded loss shows as negative in the counter. — **Passed 2026-11-10**
(`lib/ledger/proof.test.ts`, "PHASE 1 GATE"). Built: `measurement_plans`
(immutable; edits become tamper events) and `ledger_entries` (append-only,
SHA-256 chained, forks refused) in migrations 0102–0103; `lib/ledger/plans.ts`
(designs as data, MeasurementRequiredError), `close.ts` (verdicts,
corrections), `chain.ts` (verify, daily head), `counter.ts` (§3.4 counter,
§3.6 calibration); the engine opens a plan from each proposal's scenario;
`GET /api/ledger/verify` and the daily `cron/ledger-head`. Decisions D27–D33.
Still to come with later phases: the dashboard's counter and calibration on
screen (Phase 3's monthly statement and §3.6's pricing page), and measurers
that score each capability (each lands with its holdout).

## Phase 2 — Trust Ladder (§4)

- [x] **P7-40** Stations 1–4 as §4.1; new businesses at station 2 for 30 days
      (§4.2), the five live businesses at 3 (D18)
- [x] **P7-41** Promotion rules (§4.3), enforced in the API; no global switch
- [x] **P7-42** Station-4 caps (§4.4), per business per capability, enforced
      server-side; purchase orders capped at 3
- [x] **P7-43** Auto-demotion after two consecutive losses, with the owner told
- [x] **P7-44** Standing rules as {scope, condition, action, expiry}, 90-day default
- [x] **P7-45** The ladder screen (§4.6) and the day-30 shadow summary (§4.2)
- [x] **P7-46** Tier ceilings (§8.6), unenforced while payments are unarmed (D19)

**Gate:** no external call around the ladder; stop under one second;
day-30 summary renders, zero gains included. — **Passed 2026-11-10**
(`lib/ladder/v1-ladder.test.ts`, `lib/ladder/share-render.test.ts`,
`lib/execution/station4.test.ts`). Built: the 30-day shadow default for new
businesses, the §4.3 promotion rules with the two-step 3 → 4, station-4 caps
enforced in the engine from the stored row, typed standing rules with expiry,
auto-demotion with owner notices, connector-failure demotion (§11.2), segment
and tier ceilings, the /ladder screen and the shareable /shadow summary.
Decisions D34–D38, D49–D51.

## Phase 3 — Diagnosis rebuild (§6)

- [x] **P7-50** Grades on every figure in every view; no euro headline below B
      (report headline and leak figures gated on the Diagnosis Grade; a bank
      statement's money in counts, D52)
- [x] **P7-51** Priced gaps: unlock value, method, effort; top three = week one
- [x] **P7-52** Leak register with lifecycle; fixed-and-verified needs a gain entry
- [x] **P7-53** Monthly re-diagnosis as a diff; monthly ledger statement
      (/statement; re-diagnosis on the weekly beat, D53)
- [x] **P7-54** 8-minute first interview; questions a connector answers suppressed

**Gate:** no euro headline at grade C or D in any locale; re-diagnosis diffs.
**Passed 2026-11-12** (lib/diagnosis/v1-diagnosis.test.ts). Decisions D52–D55.

## Phase 4 — Peer Benchmark Network (§5)

- [x] **P7-60** Cohorts: NACE 4→3→2, country→region, revenue band, month;
      widening recorded and said in words
- [x] **P7-61** Floor in the query layer (k ≥ 7, ≤ 25%); extraction-attack test
- [x] **P7-62** Measured values only; p25/p50/p75 + the owner's percentile
- [x] **P7-63** Contribution on by default, one-tap opt-out, out within 24 hours
- [x] **P7-64** Eurostat labelled with its vintage, never blended
      (live panel above the Eurostat sheets on /benchmarks; DPA notes for counsel)

**Gate:** a cohort of 6 returns nothing through every path; the extraction
attack can't isolate a business.
**Passed 2026-11-12** (lib/peers/cohort.test.ts). Decisions D56–D61.

## Phase 5 — Entry funnel and pricing (§8)

- [x] **P7-70** One-number entry: 6 questions, no account, result in < 10 s
- [x] **P7-71** Tiers Watch / Act / Autonomous, extra business, annual −20%
- [x] **P7-72** €49 diagnosis credited against month 1 on the first invoice
- [x] **P7-73** Stripe subscription lifecycle, dunning, cancellation flow
      (built and tested against a stand-in Stripe; armed when the keys exist)
- [x] **P7-74** The quarterly guarantee job, from the ledger alone

**Gate:** free entry < 10 s with no account; the guarantee computes from the
ledger alone.
**Passed 2026-11-12** (lib/entry/one-number.test.ts, lib/billing/guarantee-run.test.ts,
lib/billing/lifecycle.test.ts). Decisions D62–D68.

## Phase 6 — Partner Console (§7)

- [ ] **P7-80** Firm, firm member, mandate, rollup — access only via an
      active mandate, enforced at the data layer
- [ ] **P7-81** Book view sorted by leak size; white-label; commentary blocks
- [ ] **P7-82** Bulk onboarding of 40 clients

**Gate:** no partner access without an active mandate; 40 clients < 30 min.

## Phase 7 — Growth engine (§10)

- [ ] **P7-90** Evidence-cited briefs (no evidence, no generation)
- [ ] **P7-91** Asset library with rights records; identity release before a
      real person renders
- [ ] **P7-92** Brand voice profile as editable words; first three pieces
      always approved
- [ ] **P7-93** `labelling_record` per asset; no publish without one

**Gate:** a brief without evidence fails; nothing publishes unlabelled.

## Phase 8 — Compliance completion (§9)

- [ ] **P7-95** Country matrix with legal sign-off dates; Article 50 marking
- [ ] **P7-96** Phone: consent gate, the no-record path, outbound dark

**Gate:** a blocked country can't execute at any station; a refused consent
yields a completed call with no audio or transcript.

---

## Multi-market foundations + NAV (the owner's spec §14–§15, 2026-11-10)

Additive and corrective; nothing removed. Placed in Phase 0's order (A and E
first, the ledger being append-only). Decisions D39–D48.

- [x] **MM-A1** Money as a type: exact `scaleMoney`, `perUnit`, `scaleMinor`,
      `ratioBp`; `multiply` exact on the factor's written decimal; display
      through `presentMoney` — no float on any money path (source-scanned)
- [x] **MM-A2** The seeded `currencies` table (HUF whole forints, Stripe's
      divisible-by-100 asserted at the billing boundary)
- [x] **MM-A3** ECB daily rates, stored once per day, conversions carrying
      rate + date + source and reproducing from them; the fx-rates cron
- [x] **MM-A4** The ledger's internal `reporting_eur` (never owner- or
      partner-facing, scanned); the clean rebuild (D40)
- [x] **MM-A5** The guarantee in the billing currency; a test fails if a
      conversion is touched
- [x] **MM-A7** A two-currency cohort fails loudly
- [x] **MM-B** Price book as data (HU rows seeded off), locked subscription
      prices, VAT mismatch review, reviewed annual changes, quota gate and
      the startup check; usage per business per month and cost by tier and
      capability
- [x] **MM-C** Segments by form then staff; micro_sole capped at station 2
      through every path and at Watch; segment as a cohort dimension
- [x] **MM-D** The cold-start benchmark ladder with origin labels in seven
      languages; the seeded-launch rule; case studies by mechanism
- [x] **MM-E** NAV Online Számla, read-only: three query operations only
      (source-scanned), SHA-512/SHA3-512 signing, per-business keys, log
      redaction, connect-validate-name, both sides normalised (B), own
      runner, Hungarian degradation, one-tap revocation, the guide with its
      screenshot gate
- [ ] **MM-E2** Partner bulk NAV setup — lands with the Partner Console (Phase 6)
- [x] **MM-B2** Wire the hard quota cap into video generation and the LLM path
- [x] **MM-A9** The LLM cost meter onto stored ECB rates (D48)
- [ ] **Owner** NAV registration answer from counsel; NAV guide screenshots;
      confirm quotas and HU prices; counsel's HU matrix sign-off; NAV DPIA/DPA

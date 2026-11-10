# SYB architecture v2 — the five subsystems

Received from the owner on 2026-11-10 (section 2 of a longer spec; sections
1 and 3+ were not supplied). Phase 7 builds it — `TASKS-PHASE7.md`. Where
this file and CLAUDE.md disagree, this file wins for the subsystems below;
the eight non-negotiable rules in CLAUDE.md still hold everywhere.

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

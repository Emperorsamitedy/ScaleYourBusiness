# TASKS — Phase 7: The five subsystems (architecture v2)

**Opened 2026-11-10 by the owner.** They supplied section 2 of a new spec
(`specs/architecture-v2.md`) — Proof Ledger, Trust Ladder, ComplianceGate,
Peer Benchmark Network, Partner Console, Entry Funnel — with seven hard
rules and six invariants, and asked for the tests before the code. Asked
eight open questions, the owner answered "Use your defaults" (decisions
D1–D8 in the spec, plus D9–D13 where the spec was silent).

The spec's hard rules 1–7 and invariants I1–I6 are this phase's
non-negotiables; they live in the spec, not here, so they can't drift.
CLAUDE.md's rules 1–8 and every earlier phase's rules still hold. In
particular rule 12 is unchanged (D2): no station lets anything run without
a recorded human approval.

---

## Session A — the centre: grades, ledger, ladder, gate _(built 2026-11-10)_

- [x] **P7-01** Confidence grades (D4, hard rule 3): `lib/core/grade.ts`; a
      derived figure takes the lowest input grade; data-model-v1 §8.1 records it
- [x] **P7-02** Proof Ledger table with the append-only trigger (hard rule 2,
      I2): UPDATE, DELETE and TRUNCATE raise; corrections are new entries
- [x] **P7-03** `openMeasurement` / `closeMeasurement` / `correct`, one plan
      per proposal, one close per plan; the verified-euro counter per currency (D10)
- [x] **P7-04** Due measurements close at window end through each
      capability's measurer, or unscored with the reason (D11, D12); cron route
- [x] **P7-05** Trust Ladder stations 1–4, default 3 (D2); `authorize`;
      raising to 4 refused until promotion rules exist; every change audited
- [x] **P7-06** Emergency stop (I6): every capability to station 1 in the
      stop's own transaction, pending proposals cancelled; resume restores (D9)
- [x] **P7-07** `recordOutcome` and promotion eligibility (D2: not eligible,
      rules undefined, with the counts)
- [x] **P7-08** ComplianceGate v1 (D5): write consent for external
      capabilities, phone country allowlist; a failure overrides the ladder
- [x] **P7-09** Phone country flag (D6, hard rule 6): `PHONE_ANSWERING_COUNTRIES`,
      default blocked; a blocked line answers closed, and can't be switched on
- [x] **P7-10** The engine runs authorize → check → open measurement before
      the claim (I1, I3); SHADOW records the counterfactual only
- [x] **P7-21** Hard rule 7 pinned: generated assets are stamped on the two
      render paths only, never on upload (a structural test)

**Done when:** I1, I2, I3 and I6 are tests that pass, and every existing
engine test still passes with every capability at its default station.

## Session B — Peer Benchmark Network _(built 2026-11-10)_

- [x] **P7-11** Opt-in consent records, withdrawable (D7)
- [x] **P7-12** The aggregate: k ≥ 7 distinct businesses and no business above
      25% of a numerator or denominator, or nothing at all (I4, hard rule 4)
- [x] **P7-13** Serving average order value (D13) for a business's cohort, its
      own currency only, Eurostat named as the fallback
- [x] **P7-14** `POST/DELETE /api/peers/consent`, owner only, same-origin

**Done when:** a cohort of six, or seven with one at 26%, serves nothing a
test can find.

## Session C — still open

- [ ] **P7-15** Owner screens: the ladder (each capability's station, the
      stop's effect) and the peer opt-in card on /benchmarks
- [ ] **P7-16** Measurers for the capabilities that already read back their
      results (campaign email, posts, ad changes), so they close scored, not
      unscored
- [ ] **P7-17** The other outbound paths an agent drives outside the engine
      (the weekly WhatsApp summary, support replies) through the same call order
- [ ] **P7-18** Promotion rules for station 4 — waits for the owner (D2)
- [ ] **P7-19** Partner Console, with I5's mandate test — waits for prices (D8)
- [ ] **P7-20** Entry Funnel — waits for prices (D8)

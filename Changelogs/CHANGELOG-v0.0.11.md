# Changelog — Ledgerline (SYB)

All notable changes to this project, for anyone picking up work on this account.
Reconstructed 2026-09-11 from the full git history; versions are retroactive milestones, dates are real.

**Orientation for a new collaborator:**

- Production: https://syb-kappa.vercel.app (Vercel; deploys are manual — `npx vercel --prod --archive=tgz`; `vercel git connect` has NOT been run)
- Plans: `TASKS.md` (Phase 0, done), `TASKS-PHASE1.md` (done), `TASKS-PHASE2.md` (current — first open box is P2-01)
- Rules: `CLAUDE.md` — read it before writing anything; the specs in `specs/` win over everything
- Deploy order when schema changes: migrate the prod DB first (`DATABASE_URL=<prod> npx drizzle-kit migrate`), then deploy; bank changes also need `npx tsx scripts/seed-bank.ts` against prod
- Local: `docker compose up` (Postgres on **5433**), `npm run dev`, `npx vitest run` (369 tests)

---

## [Unreleased]

Phase 2 — Measurement (`TASKS-PHASE2.md`): read-only connectors (Stripe first), measured facts superseding estimates with provenance, deterministic anomaly detection. Next task: **P2-01**, the `connections` table.

Parked, deliberately (owner decisions on record): Stripe/Resend keys (payment gate built but unarmed), `OPS_KEY`/`CRON_SECRET` in Vercel env, the 7-persona harness tail, P0-71 (human-timed entity entry).

---

## [0.13.0] — 2026-09-11 — Core sharpened; Phase 2 opened

### Added

- `TASKS-PHASE2.md` — the Measurement programme: connector spine → Stripe → commerce → traffic/ads → anomaly detection, with three new non-negotiables (read-only scopes with a build-failing audit, secrets encrypted at rest, stated-vs-measured deltas shown, never silently swapped)
- Fifth real business through production (Justin Welsh, digital courses) — first exercise of the digital branch; the report caught VAT exposure on international digital sales; mode engine's first production ruling (watching/6)
- `HARNESS_ONLY` env — run named harness personas instead of first-N

### Changed

- Bank **1.2.1**: ten prompts stopped inviting a bare "no" ("Do you have problems with returns?" → "What goes wrong with returns, if anything?")
- Diagnosis prompts: **PROVISIONAL retired as CALIBRATED** — five real businesses, zero invented numbers, every finding evidence-cited; prompts untouched because they demonstrably work; new bar is "recalibrate on an observed grounding failure, not taste"
- `CLAUDE.md` now tells the truth: Phases 0–1 complete; **Phase 2 opened by explicit owner override of the paying-customers gate** (recorded like the P0-86 re-scope, so the trail never pretends the gate was met)

### Learned (telemetry's first catch)

- Production runs `INTERVIEWER_MODE=deterministic` — a full prod intake+report costs **~€0.18** (two diagnosis calls), not the €0.5–1.2 previously estimated under the llm-mode assumption

## [0.12.0] — 2026-09-11 — Mode decision & watching (Session H; Phase 1 complete)

### Added

- **Mode decision engine** (P1-42/45): pure function from ten named inputs per data-model §9 — `instant` only when nothing can break; anything else `watching` 4/6/8 weeks; **defers below 50% completeness** rather than guessing; every ruling stores the exact inputs that produced it; 19 rule tests
- **/mode screen** (P1-43/44): the WHY list renders stored inputs verbatim; extending the watch is one click; shortening requires sign-in plus a stored acknowledgement
- **Weekly watch job** (P1-46): Vercel cron (gated by `CRON_SECRET`) snapshots watched profiles, diffs against last week, logs honestly — an unchanged week says "held steady", never invents motion; completion announced exactly once
- **/watch status screen** (P1-47) + **module selection** (P1-48): analytics is not a row in the table, so it cannot be disabled
- Tables: `mode_decisions`, `watch_activity`, `account_modules` (migration 0021)

## [0.11.0] — 2026-09-11 — Cost telemetry, funnel, ops panel (P1-51/52/53)

### Added

- `llm_calls` table: every model call persisted (Vercel keeps no function logs — cost was archaeology before this; now it's a query)
- Server-written funnel stages in `intake_events` (started → core complete → report → recommendation responses); the client sink refuses funnel kinds, so a browser cannot forge a conversion
- `/ops?key=…` + `/api/ops` (gated by `OPS_KEY`): funnel conversion, where stalled intakes stopped (by last question shown), cost per account by workload

### Fixed

- Client event batches shared one `defaultNow()` timestamp, making "last question shown" ambiguous — receipt time now carries one millisecond per batch position

## [0.10.0] — 2026-09-11 — Auth & payment (Session I, P1-49/50)

### Added

- **Magic-link auth**: email + one-shot 15-minute link, no passwords anywhere; the link creates the account on first use and claims the browser's anonymous intake; sessions 90 days, revoked-not-deleted; only sha256 hashes at rest; Resend delivery with an honest on-screen fallback
- `/login`, `/signup`, `/register` (→307): one mechanism, two entrances, with the "no password — nothing to forget or reset" answer where the eye expects "forgot password"
- **Stripe payment gate** for the €49 report (`REPORT_PRICE_MINOR`): Checkout via plain HTTP, webhook signature verified by hand-rolled constant-time HMAC, "paid" written ONLY by the verified webhook, idempotent under redelivery; **gate arms itself when `STRIPE_SECRET_KEY` exists and stands down (logged) when it doesn't** — production is currently unarmed by owner choice
- Auth screen, cinematic split: the landing's film on the left with a looped three-beat demo of the system working (question → recorded fact with provenance → evidenced finding), built from real components, no gif
- Tables: `login_tokens`, `auth_sessions`, `payments` (migrations 0019)

## [0.9.1] — 2026-09-11 — Pilot fixes, wave 2

### Fixed

- Unknown entity field keys were silently dropped (Beardbrand's channels lost their types, labels fell back to "Channel 1") — now a 422 naming the valid keys, before anything is written
- Gap links ("Answer now") dead-ended on completed interviews and skipped questions — an explicit ask now resolves against everything applicable and unanswered; answered questions still route through reopen (closes P1-60 for real)
- `DELETE /api/intake` — an owner can leave a profile and start another (was impossible; cookie is httpOnly)

### Changed

- **P0-86 closed as re-scoped** (owner decision, recorded): the pilot method is real published businesses run through production with defects fixed on the spot — four on record at the time (Ember & Oak, From The Ground Up Socks, Beardbrand, The Match Artist), stopped when a run found nothing new

## [0.9.0] — 2026-09-09/10 — The real-business pilot, wave 1

### Fixed (each found by a real business, not a review)

- **Reporting currency follows the country** — was hardcoded HUF; a US business's whole report printed in forint. `currencyForCountry` handles free-text reality ("USA", ISO codes, native names) and refuses to guess
- **Entity rows are all-or-nothing** — one bad value used to strand a five-product list as one nameless offer and lock the question
- **Reopen without a reason: 422, not 500** — the route cast the body unchecked
- **Interviewer no longer re-runs on every read** — `getIntakeState` made a Sonnet call per page load/poll/refresh; measured live at 192 calls for ~50 answers (~4×). The pick is cached on the profile and self-invalidates when answered. Guard test counts calls
- Bank **1.2.0** (P0-88/89): six data-corrupting questions rewritten (yes/no prompts over number/money inputs; "make money" ambiguity at the root of the revenue branch; `allow_unknown` on fixed costs — "I don't know" is a real answer); linter now refuses the whole class, proven against a deliberately regressed bank

## [0.8.1] — 2026-08-31 → 09-01 — The cinematic landing

### Changed

- Landing rebuilt as the long cut: film beds, all five phases with honest status chips, Ember voice; several class-collision and `position: sticky`/`overflow` bugs fixed along the way

## [0.8.0] — 2026-08-29 — Diagnosis (Sessions E/F/G)

### Added

- **Findings** (P1-22..27): Opus reads a snapshot, never the live profile; code validates every finding's evidence keys and discards what can't cite itself
- **Recommendations** (P1-28..33): scenario blocks with assumptions, base/downside/upside, break-even conditions with visible arithmetic; computed sensitivity, not asserted
- **Report screen** (P1-34..41): summary, unit economics with per-figure source lines, findings with "rests on:" evidence, recommendations with equal-weight accept/decline (decline reasons are training data), gaps that link back into the intake; cost guard returns the existing report when the snapshot hasn't moved

## [0.7.0] — 2026-08-26 → 28 — Phase 1 foundations

### Added

- Profile **snapshots** (P1-01..06): content-hash deduped, immutable, diffable — every report's reproducible input
- **Unit economics** (P1-07..14): margins, break-even, blended figures — arithmetic that shows its working and refuses when inputs are missing rather than assuming
- **Competitor research** (P1-15..21): capped, sourced, never invented; live discovery providers
- Landing v1 + **resume links** (P1-55..58, 61): signed, hashed at rest, 30-day expiry
- **Fact sheet** (P1-59): every captured fact with provenance; gaps with what answering buys

### Measured

- Staging live at syb-kappa.vercel.app; prompt caching verified against the real API; harness: 13 personas, 1,602 turns, zero assertion failures, €0.684 median per full synthetic intake (48% under estimate)

## [0.5.0] — 2026-08-23 — Validation & reconcile (Session Q)

### Added

- Validation engine: nine deterministic rules run per write, versioned findings (P0-78..81)
- Reconcile panel — "curious, not corrective": contradictions surfaced as questions, both originals kept in history (P0-82..84)
- Intake telemetry (P0-87): every hesitation, dwell, and the actual abandonment point, batched via sendBeacon

## [0.4.x] — 2026-08-22/23 — The intake UI

### Added

- Intake service + API — the UI's entire contract (P0-60a)
- One-question-at-a-time shell: keyboard-first, chips with provenance lines, on-deck preview (P0-59..67)
- Entity-list sub-forms (products, channels…) with per-row spine records (P0-68..70)
- Chip reopen with history + reason; mobile Recorded(n) strip (P0-72..77)
- **Ember Grid** design system (`docs/DESIGN.md`) and the glass restyle of the whole intake

## [0.3.0] — 2026-08-21 — Interviewer & parser

### Added

- Interviewer: Sonnet picks the next question from resolver-computed candidates only, tier-gated (core before important before deep), prompt-cached bank (P0-48/49)
- Per-call cost logging tagged by workload — the €50/month budget's instrument (P0-51)
- Haiku parser with deterministic coercion gate, estimate detection, multi-answer extraction (P0-54..57)
- Harness groundwork: 20 personas, per-transcript invariant assertions (P0-52/53)

## [0.2.0] — 2026-08-21 — The question engine

### Added

- Bank loader: 153 questions, 55 vocabularies, 8 entity schemas; versioning keeps answers; `lint_bank.py` gate refuses bad banks (P0-36..38)
- Condition evaluator (seven operators, nesting, `.length`) — branching lives in data, never code (P0-39..41)
- Applicability resolver + weighted completeness with `core_complete` and `blocking_gaps` (P0-42..47)

## [0.1.0] — 2026-08-20/21 — The data core

### Added

- Money as integer minor units + ISO currency; two-currency totals refuse silently rather than blend (P0-09/10)
- `Field<T>`: value, six-state status, confidence, SourceRef, observed/recorded times — no bare values anywhere (P0-11..18)
- All tables: accounts, users, profiles, `field_records` (fourteen sections, one store), offers + entity spines (P0-19..25)
- **Supersession**: partial unique index holds "one current record per field"; history is never overwritten (P0-26..29)
- Vocabularies with other/label_raw; recurring-"other" report (P0-30..32)
- **Append-only decision log**, enforced by trigger — mutation attempts throw (P0-33..35)

## [0.0.1] — 2026-08-20 — Scaffold

### Added

- npm init, strict TypeScript, ESLint, Prettier, vitest; Next.js app; Postgres 16 via Docker (host port 5433); Drizzle with first migration; fail-fast `.env` handling; CI running typecheck, lint, tests and the bank linter on every push (P0-01..07)
- Specs and `lint_bank.py` into the repo; `CLAUDE.md` ground rules (P0-06)

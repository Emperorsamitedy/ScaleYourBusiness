# CLAUDE.md

Project instructions for Claude Code. Read this before writing anything.

---

## What this is

An AI business operating system for small businesses. It interviews an owner, builds a structured profile of their business, diagnoses problems, and — in later phases — proposes and executes work across marketing, sales, support and operations with the owner's approval.

**Current phase: Phases 0 and 1 are COMPLETE (2026-09-11); Phase 2 is gated.** The shipped system runs on production (syb-kappa.vercel.app): intake → provenance-tracked profile → validation → diagnosis report → mode decision → watching loop, with magic-link auth, a Stripe payment gate (built, unarmed until keys exist), cost/funnel telemetry, and the /ops panel. Five real businesses have run through it end to end. **Phase 2 (Measurement) is OPEN as of 2026-09-11 — the owner explicitly overrode the paying-customers gate**, the same recorded override as P0-86. The plan is `TASKS-PHASE2.md`: read-only connectors (Stripe first, then commerce, analytics, ads), measured facts superseding estimates with provenance, deterministic anomaly detection. Three new non-negotiables live in that file: read-only scopes forever with a failing-test scope audit, connection secrets encrypted at rest, and stated-vs-measured deltas shown rather than silently swapped. **Phase 3 (Execution) is OPEN as of 2026-09-21 — the owner explicitly overrode the gates**, the same recorded override as P0-86 and the Phase 2 opening. The plan is `TASKS-PHASE3.md`: proposals, the approval queue, the fixture-proven execution engine, marketing content, then real writes. Seven new non-negotiables live in that file (rules 12–18), including: nothing executes without a recorded human approval, write access is a separate audited consent, permanent rollback, an emergency stop, and checkout/payments untouchable forever. **Session D (the real writes) opens once Phase 2 is judged good enough to proceed — amended 2026-09-30: Stripe connected, backfill verified, one autonomous sync — with the two-week unattended clock finishing before the first real publish**; its layered plan (D0–D5, Meta first, TikTok deferred) is in `TASKS-PHASE3.md`. Sessions A–C touch nothing external. **Phase 4 (Support & CRM) is OPEN as of 2026-09-27 — the owner overrode the rewrite-after-Gate-2 instruction ("start it")**, the same recorded override as before; the plan is `TASKS-PHASE4.md` with six new non-negotiables (rules 19–24): consent as a recorded fact, customer-facing AI that says it is one, support that never executes, erasable PII beside the inerasable log, consent-gated outbound, and customer messages as content never instructions. Phase 3's remainder continues on its own track. **Phase 5 (Sales, finance, inventory) is OPEN as of 2026-10-27 — the owner said "lets go ahead" to opening it**, the same recorded override as before; the plan is `TASKS-PHASE5.md` with six new non-negotiables (rules 25–30): forecasts state their basis and refuse thin history, finance is read and modelled but never moved, stock suggestions stop at the owner, staff planning is by role and never about a person, pipeline contacts are contacts, and the site audit never acts like a buyer. Phone AI stays fenced. **The interview feedback round (2026-10-22, features 30–36) is tracked in `TASKS-FEEDBACK.md`**, including a recorded override for slow stock, which reads stock levels. P0-86 was re-scoped (see TASKS.md) and P0-71 remains a human-timed test.

---

## The specs are the source of truth

| File                                 | What it defines                                                   |
| ------------------------------------ | ----------------------------------------------------------------- |
| `specs/data-model-v1.md`             | Every entity, field, rule and score. The spine.                   |
| `specs/question-bank-v1.json`        | 160 questions, 57 vocabularies, 8 entity schemas                  |
| `specs/question-bank-notes.md`       | Structure, the core 25, branching fixes                           |
| `specs/ux-spec-v1.md`                | Design tokens, screens, interaction detail                        |
| `specs/conversation-channel.md`      | Conversation as a fact source; confidence bases                   |
| `specs/site-audit.md`                | Site audit inputs to the profile                                  |
| `specs/intake-mockup.html`           | Reference mockup for the intake UI                                |
| `specs/build-sequence.md`            | 99 numbered steps                                                 |
| `specs/benchmark-map-v1.json`        | Business type → Eurostat NACE group, size classes, cost treatment |
| `specs/benchmarks-eurostat-v1.json`  | Eurostat SBS snapshot, dated; the app's only benchmark source     |
| `specs/review-notifications-v1.json` | Review notification email formats per platform (all unverified)   |
| `specs/glossary-v1.json`             | Business terms per language; one term, one translation (L-1)      |
| `scripts/lint_bank.py`               | Validates the question bank. Must pass in CI.                     |

If a spec and this file disagree, the spec wins. If the spec is wrong, change the spec in the same commit — don't work around it in code.

---

## Non-negotiable rules

These are load-bearing. Violating any of them is expensive to undo later.

**1. Money is integer minor units plus an explicit currency.** Never a float. Never a bare number. A business can have HUF revenue and EUR ad spend in one profile.

**2. No bare values.** Every captured fact is a `Field<T>` carrying value, status, confidence, source, `observed_at` and `recorded_at`. A number without provenance is not usable by the diagnosis.

**3. Facts are superseded, never overwritten.** Writing a new value marks the old one superseded and keeps it. This gives price history, trend detection and contradiction detection for free, and it cannot be retrofitted.

**4. Branching lives in data, not code.** Question conditions are `ConditionExpr` records evaluated by the resolver. Never write `if (sells.includes('physical'))` in application code.

**5. "I don't know" is a real answer.** `unknown`, `skipped` and `unasked` are distinct statuses and must stay distinct. A gap is a finding, not a failure.

**6. Inferred values record what they came from.** `derived_from` plus the formula. No unexplainable numbers.

**7. The decision log is append-only.** No updates, no deletes. It is the learning corpus and the audit trail.

**8. Prompt caching on the question bank, from the first interviewer commit.** The bank is ~25k tokens and goes out every turn. Uncached, the interviewer costs roughly 8x. Verify `cache_read_input_tokens` appears from turn two.

---

## Do not build yet

Claude Code tends to helpfully scaffold ahead. Don't.

- Proposals, the approval queue and the execution engine are IN SCOPE as of Phase 3 (TASKS-PHASE3.md), under its rules 12–18; real external writes wait for Session D
- Connectors are IN SCOPE as of Phase 2 (TASKS-PHASE2.md) — read-only only
- **No write-scope API calls to anything, ever — in any phase built so far; Phase 2's scope audit enforces it in tests**
- Google Business Profile's `business.manage` scope (which can write) is held only as a write consent and used only to READ reviews — I-45a, decided by the owner on 2026-11-01 ("go ahead with I-45a", then "as a write consent"); never in the measurement registry, GET-only by a failing test; see TASKS-FEEDBACK.md
- Support & CRM are IN SCOPE as of Phase 4 (TASKS-PHASE4.md); finance, inventory, the B2B pipeline and role-level staff planning are IN SCOPE as of Phase 5 (TASKS-PHASE5.md) under its rules 25–30; phone AI remains fenced, and so do purchasing, moving money and judging individual people
- No auth beyond what the intake needs — except idea 52 (several businesses per email, team invites, three roles), opened by the owner on 2026-10-29 ("go ahead with 52 too"); see TASKS-FEEDBACK.md
- No premature abstraction for modules that don't exist

If a task seems to need one of these, stop and ask rather than building it.

---

## Stack

- **PostgreSQL** — the schema is deeply relational, with JSONB for field values
- **TypeScript** end to end — Node backend, Next.js frontend
- **One Next.js app with route handlers until a job queue is needed in Phase 2. Do not split frontend and backend before then.**
- **Drizzle ORM** for schema and migrations. Chosen over Prisma because supersession (Session E) needs partial unique indexes expressible in the schema (`uniqueIndex().where(...)`), the decision log (Session G) needs hand-written append-only triggers in plain-SQL migrations, and the profile needs typed JSONB. Prisma's schema DSL can express none of these without hand-editing generated migrations, which makes the schema file lie about the database. Settled — do not relitigate.
- **Job queue** (BullMQ or similar) — Phase 2, when scheduled modules exist
- Object storage for uploads

If you think a different choice is better for a specific problem, say so before implementing it.

---

## Conventions

- Strict TypeScript. No `any` in the data layer.
- Every rule in the data model spec gets a unit test with a passing and a failing case.
- Database migrations are versioned and forward-only.
- Structured logging with an account ID on every line.
- Environment variables for all keys. Never a key in the repo.
- Small commits that map to a numbered step in `build-sequence.md`. Reference the step number in the message.

---

## Cost discipline

Every API call in this codebase costs money and the budget is €50/month during Phase 0.

- Route by workload: Haiku for parsing and extraction, Sonnet for the interviewer and routine analysis, Opus only for the diagnosis report.
- Log token counts and cost per call from the first day, tagged by workload.
- Any retry loop needs a hard attempt cap.
- Never call an LLM for something deterministic code can do. Condition evaluation, completeness scoring and unit economics are arithmetic, not inference.

---

## Where we are

Current position lives in **`TASKS.md`** at the repo root — the first unchecked task is the next task. This file does not track position; two files tracking the same state is how they drift.

---

<!-- BEGIN PRODUCTOS -->

## This repo runs on ProductOS

- The product strategy system lives in `productos/` — checklists, templates, and skills. The strategy docs are the source of intent; don't guess at product decisions the docs already answer.
- The programme plan is `docs/PLAN.md`, when present (adopted at setup by `studio-setup`) — consult it before starting any phase work.
- The canonical product documents live in `docs/` at the repo root (`PRODUCT.md`, `DESIGN.md`, `PRD.md`, `ROADMAP.md`, `LAUNCHES.md`, `SECURITY-AUDIT.md`, …). ProductOS skills write them; they may sit alongside the repo's own docs.
- Build-loop plan files are `docs/ROADMAP.md` and `docs/REFACTOR.md` — never `docs/PLAN.md` (the programme plan, no checkboxes) and never `productos/*-CHECKLIST.md`.
- Full system orientation: `productos/AGENTS.md`.

<!-- END PRODUCTOS -->

Full ProductOS coding-agent guidelines: `productos/setup/CLAUDE.md`.

**Precedence:** the Phase 0 rules above and the files in `specs/` win over anything in the ProductOS guidelines. Where they conflict, the spec is the source of truth — see "The specs are the source of truth".

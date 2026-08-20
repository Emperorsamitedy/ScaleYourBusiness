# CLAUDE.md

Project instructions for Claude Code. Read this before writing anything.

---

## What this is

An AI business operating system for small businesses. It interviews an owner, builds a structured profile of their business, diagnoses problems, and — in later phases — proposes and executes work across marketing, sales, support and operations with the owner's approval.

**Current phase: Phase 0 — Foundation.** We are building the data layer, the question engine, the interviewer agent and the intake UI. Nothing else.

---

## The specs are the source of truth

| File | What it defines |
|---|---|
| `specs/data-model-v1.md` | Every entity, field, rule and score. The spine. |
| `specs/question-bank-v1.json` | 153 questions, 55 vocabularies, 8 entity schemas |
| `specs/question-bank-notes.md` | Structure, the core 25, branching fixes |
| `specs/ux-spec-v1.md` | Design tokens, screens, interaction detail |
| `specs/conversation-channel.md` | Conversation as a fact source; confidence bases |
| `specs/site-audit.md` | Site audit inputs to the profile |
| `specs/intake-mockup.html` | Reference mockup for the intake UI |
| `specs/build-sequence.md` | 99 numbered steps |
| `scripts/lint_bank.py` | Validates the question bank. Must pass in CI. |

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

- No approval queue, proposals or execution engine — Phase 3
- No connectors to external platforms — Phase 2
- **No write-scope API calls to anything, ever, in Phase 0 or 1**
- No support, CRM, finance or HR modules
- No auth beyond what the intake needs
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

# Changelog v0.0.14 — Ledgerline (SYB)

Phase 3 opens and two-thirds of it ships to production in two days:
the proposal spine, the execution fence, the content machinery, and
the trust layer. Convention per v0.0.12 — new file, released files
stay history.

---

## Orientation delta (what changed since v0.0.13)

- **Phase 3 (Execution) is OPEN** — the owner overrode the gates on
  2026-09-21 ("start"), recorded in `TASKS-PHASE3.md` and `CLAUDE.md`
  like the P0-86 and Phase 2 overrides before it. The plan carries the
  owner's full scope statement (folded in 2026-09-21, superseding
  build-sequence steps 68–80 where they disagreed) and seven new
  non-negotiables, rules 12–18.
- **Production now runs Sessions A, B, C and E** — 24 of the phase's
  39 tasks. Prod DB migrated 24 → 28 (all additive; 15 profiles, 473
  facts, 491 decision-log rows, 4 reports intact). All eleven screens
  200; the four new APIs 401 unauthenticated.
- **The weekly-watch cron fired on its own** (Mon 2026-09-21 06:21
  UTC) and snapshotted the watched profile — the system's first
  autonomous production action. The connector-sync cron has nothing
  to sync until a real connection exists.
- New dependency: `ffmpeg-static`/`ffprobe-static` — the cutting room
  runs on a pinned static binary, no system install.

## Session A — proposal spine and approval queue (P3-01..07)

The `proposals` table holds rules 12 and 14 in Postgres itself:
requires_approval pinned true by a check constraint, blocked
proposals must name their 13.5 limit, approvals demand a human id,
rejections demand a reason, executions demand a result. The
decision-log kinds proposal/approval/rejection/execution (enum values
since P0-33) became real rows with recomputable sha256 hashes,
written in the same transaction as every state change. Hard limits
are parsed from 13.5's free text ONCE by Haiku into a stored fact
with provenance; the generation-time check is a code taxonomy over a
closed ACTION_KINDS set. Generation classifies recommendations with
Haiku, proposes nothing it can't classify, never re-proposes what the
owner declined, and turns open interrupt anomalies into investigate
proposals at zero model cost. /proposals renders ux-spec §8 verbatim:
equal-weight Approve/Decline, decline-with-reason, bulk review,
scheduled actions (execute_not_before, migration 0025), the restraint
view quoting the owner's own words, and the product's one badge.

## Session B — the execution fence (P3-08..13)

One engine entry point, seven ordered guards: emergency stop (checked
again before every retry attempt), approved-only with distinct
refusals, the owner's schedule floor, the watching block (step 67 —
and no mode decision blocks too), the registry's closed op set,
reversibility honesty, and exactly-once idempotency held by a unique
index. Undo payloads captured BEFORE attempt one, kept forever; undo
passes the same fence. The execution scope registry has three build
gates: pinned-literal equality (rule 13), honest write naming under
the measurement audit's own vocabulary, and the rule-18 money fence —
each proven by a deliberately planted violation. Rule 9's zero-write
measurement audit is re-asserted from the write side. Migration 0026.

## Session C — goals, calendar, voice, shot lists, cutting room (P3-14..19)

Goals got their service and screen over the P0-22 spine — supersession
keeps January's statement under March's edit. The voice card makes
"the owner's voice" checkable: every trait names a field key or
utterance id, exemplars are the owner's own sentences, and the 13.5
boundaries ride the card. Calendars and shot lists are PROPOSALS —
evidence on every slot and shot, drafting nothing before approval,
planning only onto channels the owner already runs. Production turns
an approved plan into disclosed items in content_items (migration
0027 — disclosure NOT NULL). The cutting room cuts, crops, captions
(libass — the static ffmpeg ships without drawtext, found by running
it) and burns the disclosure into container metadata with no flag to
remove it; music comes only from the licensed manifest, which is
EMPTY until the owner's licensing quotes exist, and says so by name.
Verified live in the browser: goal → calendar proposal (real Haiku
parse put "never sound corporate" on the card) → approval → six
disclosed items. Two off-by-ones caught in that walk (week-slot
anchor, UTC date rendering), both fixed with tests.

## Session E — the trust layer (P3-25..29)

Readback confronts every executed proposal with the measured revenue
series: after-window mean vs the 28 days before, thresholds pinned at
±5% with boundary tests in both directions, plus the honest
non-verdicts too_early and unmeasured. The scorecard shows suggested/
approved/declined/helped/did-nothing/backfired with the approval-rate
arithmetic spelled out; restraint is excluded from the rate. /history
is the decision log made legible. The third decline of a kind
provably silences it in generation (owner-initiated /content requests
deliberately bypass suppression). A full proposal card fits 375×812
with both buttons reachable; the sub-30s stopwatch run stays
human-timed (P0-71 discipline).

## Verified

672 tests across 69 files, all passing; typecheck, eslint, prettier
clean. Every session's done-when is either fully met or its open
remainder recorded in TASKS-PHASE3.md status notes.

## Still parked (owner decisions, on record)

- The Stripe test key at /connections — Phase 2's done-when still
  waits on it, and Session D's first real write waits on Phase 2
- Licensed-music quotes (P3-18's manifest is empty until then)
- Session D's platform pick; Sessions F/G prerequisites (Tier 1 site
  audit, the chat surface) — deliberate calls, not momentum
- Stripe payment keys, RESEND_API_KEY, OPS_KEY, the Pro-or-move
  hosting decision

## Next

1. The Stripe test-mode key at /connections — fifteen minutes, closes
   Session B (Phase 2), starts the two-week sync clock, and gives the
   readback its first real measured series.
2. Watch the crons: connector-sync becomes meaningful the moment a
   connection exists; weekly-watch fires Mondays 06:00 UTC.
3. Then judge Phase 2's done-when honestly, pick Session D's platform,
   and the first real write goes through the fence that is now waiting
   for it.

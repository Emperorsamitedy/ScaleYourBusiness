# Changelog v0.0.15 — Ledgerline (SYB)

Phase 3's last two buildable sessions ship, the emergency stop gets
its button, and the test suite confesses it was double-counting.
Convention per v0.0.12 — new file, released files stay history.

---

## Orientation delta (what changed since v0.0.14)

- **Every buildable Phase 3 session is now built and on production**:
  Sessions A, B, C, E, F and G — 31 of 39 tasks. What remains is
  owner-gated only: Session D (first real write; Phase 2's done-when
  plus the platform pick) and Gate 2 (needs real traffic).
- New screens live: `/site` and `/chat`. New APIs: `/api/site`,
  `/api/chat`, `/api/stop` — all 401 unauthenticated.
- New dependency surface: none since v0.0.14 (ffmpeg-static arrived
  there); the site fetcher is plain `fetch` behind its own guard.

## Session G — the conversation channel (P3-36 + step 46a, 2026-09-22)

Session G's one task exposed a prerequisite: the conversation channel
itself (conversation-channel.md, step 46a) had never been built. Both
shipped together. Haiku classifies intent FIRST (§6) so most turns
never touch the expensive path; asks get Sonnet answers grounded ONLY
in the profile and report, naming what's missing; requests become
proposals — module "conversation", originating_finding naming the
exact utterance — and "just do it" gets the spec's answer: approvals
stay. Watching mode refuses requests outright with the review date.
A limit stated in chat appends to goals.owner_boundaries as a
conversation-sourced fact naming its utterance at 0.70 confidence,
and can never be REMOVED in chat — limits survive bad days.
tell/correct record NOTHING silently (the write tier, step 60a, is
honestly not built and the reply says so). Pasted text is data, not
instructions, verbatim in both prompts. Verified live with real
models: a grounded answer citing only profile facts, then "run a 20%
off flash sale" born blocked against the owner's own "We never
discount", the restraint explained in chat — the done-when verbatim
on screen for ~€0.003. Per-turn cost lands on every utterance row.

## Session F — website changes, Tier 3 (P3-30..35, 2026-09-22/26)

Platform detection names shopify / woocommerce / wordpress / webflow /
wix / squarespace / custom from page markers with the spec's
editability matrix, evidence attached. The fetcher is GET-only behind
a real SSRF guard — refusal by RESOLVED address for loopback,
RFC-1918 and link-local, per redirect hop. Rule 18 stands as two
walls at the GENERATOR: money-path URLs refused before any fetch
(proven with a fetcher that throws if called), and targets within
400 chars of checkout/payment markers unproposable — zero proposal
rows after either refusal. The approval card renders the REAL page
before and after, live in the owner's browser at desktop and phone
widths, scripts off (an amendment from static screenshots to
something strictly fresher), verified against live example.com.
Apply goes through the Session B engine via the fixture_site
executor (pinned registry literal extended deliberately — the
designed friction), refetches first and refuses stale diffs,
health-checks after (server error / empty page / load regression
past max(3×, +2000ms), boundaries tested both directions), and a
seeded 500 auto-rolls-back AS THE SYSTEM (undone_by null) while
conversion noise is structurally unexpressible — no such input
exists, and a test scans the module's exports to keep it that way.
Undo restores byte for byte, permanently. Wix/Squarespace get
rendered before/afters plus deterministic editor steps; real
platforms refuse to apply with the Session D gate named — success
against a fixture while the real site sits unchanged would be a
progress bar over a lie.

## The emergency stop's button (P3-12 finish, 2026-09-26)

Rule 15 promised "one owner-visible control" and only the service
existed. Now: `/api/stop` and an EmergencyStop component on
/proposals, /site and /content — every surface that can cause a
write. The asymmetry mirrors P1-44: stopping is ONE CLICK, no
confirmation, no sign-in (the person at the keyboard in an emergency
gets to stop the machine; who is recorded when a session exists,
null when it doesn't); resuming asks for confirmation and a
signed-in name. Halted is the one place --err renders at full
strength; a second panicked stop keeps the FIRST stop's record.
Verified live: stop → halted card with timestamp → resume-with-
confirmation → quiet again.

## Fixed — the doubled test suite (2026-09-26)

The full suite reported 1383 passing tests — EXACTLY double the
truth. A stale harness worktree under `.claude/worktrees/` held a
complete old checkout and vitest was silently running both copies.
The worktree is removed, vitest now excludes `.claude/**`,
`.vercel/**` and `.data/**`, and the honest count is 692 across 71
files. A doubled green suite is the kind of lie that feels like good
news; recorded so nobody trusts a suspiciously round number again.

## Fixed — dual-stack fetches on v6-less hosts (2026-09-22)

undici died with a bare "fetch failed" fetching any dual-stack site
(AAAA + A records) from this box, which has no IPv6 route — found
live against example.com. `setDefaultAutoSelectFamily(true)` (happy
eyeballs) is now set explicitly in the site fetcher, with the reason
in a comment.

## Verified

692 tests across 71 files; typecheck, eslint, prettier clean; prod ==
main with all twelve screens 200 and every new API 401 unauthenticated.

## Still parked (owner decisions, on record)

- The Stripe test-mode restricted key at /connections — the whole
  remaining critical path funnels through it (a pk_test_ publishable
  key was offered 2026-09-26 and correctly refused: wrong kind, and
  credentials go in the pane, not the chat)
- Session D's platform pick; licensed-music quotes; RESEND_API_KEY;
  OPS_KEY; the hosting decision; the old pasted key's revocation;
  P0-71/P3-29 stopwatch runs

## Next

1. The Stripe key (owner) → backfill verified → the two-week sync
   clock starts → Phase 2's done-when judged → Session D opens.
2. Monday 06:00 UTC: the weekly-watch cron's second autonomous firing.
3. A dedicated security pass over the new Phase 3 attack surface
   (SSRF fetcher, chat prompts, the stop endpoint, preview iframes,
   apply/undo) — in progress as this file is written.

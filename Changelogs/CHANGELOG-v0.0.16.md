# Changelog v0.0.16 — Ledgerline (SYB)

Session D planned in depth before its first commit, the Phase 2 gate
amended so the plan can start, and one install fix. Convention per
v0.0.12 — new file, released files stay history.

---

## Orientation delta (what changed since v0.0.15)

- **Session D has a real plan.** `TASKS-PHASE3.md` Session D grew from
  five lines to six layers (D0–D5), 25 lettered sub-tasks, a done-when
  per layer, an owner-side checklist, and a "verify at build" list of
  the places Meta's own docs contradict themselves. The five original
  task IDs (P3-20..24) are kept as layer headings so every existing
  cross-reference still resolves.
- **Owner decisions recorded 2026-09-30:** Meta first (Facebook Pages +
  Instagram via Facebook Login + Marketing API); TikTok deferred; Google
  Ads still blocked; the Phase 2 gate amended (below).
- **Nothing in code changed** except `package.json`. Tests, migrations
  and screens are as v0.0.15 left them.
- Samuel's commits now carry his `JanKenzeroX` identity. Vercel's
  Hobby contributor rule (v0.0.13) still applies: until the hosting
  decision lands, Tedi re-authors on merge and the trees are verified
  identical.

---

## Planned — Phase 3 Session D, layered (2026-09-30)

Sources, in order: the owner's scope, build-sequence step 74, data-model
§11, ux-spec §8, then Meta's Graph API v26.0 / Marketing API v25.0
references and Vercel's cron and Blob pricing pages, read the same day.

- **D0 Foundations** — what the fixture-proven engine still lacks, found
  by reading the code: a provider-id → provider map (`undoExecution`
  hard-codes the fixture today), execution connections as a `purpose`
  column on `connections` with a trigger that keeps write scopes off
  measurement rows, Vercel Blob for rendered media (Instagram fetches
  from a public URL), publish state on `content_items`, and the due
  runner that finally executes scheduled approvals.
- **D1 Meta connection and consent** — registry entries `meta_publish`
  and `meta_ads` with the pinned literal edited deliberately; a
  system-user token verified against `/me/permissions`; a consent
  screen distinct from measurement with its own decision-log kind; and
  access-level honesty — Advanced Access, Business Verification and
  Tech Provider verification all stated, none pretended.
- **D2 Publish path** — the owner approves the finished item, not just
  the plan; `is_ai_generated: true` on every Instagram container and
  the disclosure line in every Facebook caption (build gate); no native
  Facebook scheduling because a post Meta holds would fire after an
  emergency stop; undo by deletion on both platforms; at-most-once
  stated honestly since Meta has no idempotency key.
- **D3 Campaigns** — pause / resume / daily budget as reversible ops,
  campaign creation as irreversible (Meta's DELETED and ARCHIVED are
  both permanent), `validate_only` before every mutation, HUF and the
  other offset-1 currencies as whole units, ±50% and ceiling guardrails
  checked twice, rule 18 re-proven.
- **D4 Readback** — per-post and per-campaign insights into the Phase 2
  observation tables, views-based only (Meta retired the `*_unique`
  Page metrics 2026-06-15), per-kind verdicts in the trust layer.
- **D5 Failure honesty** — error taxonomy as tests, degrade to paused,
  the stop proven mid-run, telemetry.

**One decision now load-bearing:** Vercel Hobby crons run once a day
with ±59 minutes of slack. A scheduler needs Pro (per-minute) or an
interim GitHub Actions schedule. Recorded in P3-20e as the owner's call
before D2.

## Amended — the Phase 2 gate (2026-09-30, owner decision)

The two-week unattended-sync clock no longer holds Session D's build.
Phase 2 is judged _good enough to proceed_ once a Stripe test-mode
restricted key is connected, the backfill is verified on the report, and
the connector-sync cron has fired on its own once. The clock keeps
running alongside and must finish before the first real publish. The
done-when text is unchanged and still owed: a commerce source, the two
weeks, one genuine anomaly. `CLAUDE.md` says the same in one sentence.

## Fixed — install scripts on npm 11.17 (`013a23d`)

npm 11.17 refuses to run a dependency's install script until it is
approved by name. A fresh clone left `ffmpeg-static` without its binary
and warned on three `esbuild` versions and `@sentry/cli`. The
`allowScripts` block in `package.json` records the approvals; `npm
install` finishes clean and the cutting room's ffmpeg runs.

---

## Unrecorded — Tedi's to write up

Commits after v0.0.15 with no changelog entry yet (2026-09-26 → 09-28).
Listed here so the gap is visible; the reasoning behind them is Tedi's
to record, not mine to guess.

- `8864983` Security: close both verified SSRF findings in the site
  fetcher
- `6db8745` Security: ownership clauses on every session-gated operation
- `f657dc8` TASKS-PHASE4.md: Support & CRM, planned — opened by owner
  override
- `71db5ff` P4-01/02/04: the contact spine
- `1579d7f` P4-03: import under attestation
- `b420c2d` Design review: the Phase 3/4 screens brought back onto Ember
  Grid
- `5fa7428` … `5c4abc2` Signup/login redesign, five iterations
- `0bae0fc` + `a1aff16` Intake squared and quieted, then reverted
- `09aeb35` Large select vocabularies: even grid
- `fb90302`, `f640718` Fact sheet: display fixes, scrollspy rail
- `8a53e26` + `143d9c5` Fact sheet worksheet hero, then reverted
- `11e38d1`, `7c40a5a` Mode screen: less talk; signed-out state

---

## Still parked (owner decisions, on record)

- The Stripe test-mode restricted key at `/connections` — now the one
  thing between the amended gate and D1
- The hosting decision (Vercel Pro or a move): the due runner's clock
  AND the contributor-block workaround both hang on it
- Meta owner-side setup: business portfolio, system user, Business
  Verification, App Review, Tech Provider verification, Full Access
- Session D's licensed-music quotes (P3-18), `RESEND_API_KEY`,
  `OPS_KEY`, Google Ads approvals, the old pasted key's revocation,
  P0-71/P3-29 stopwatch runs

## Next

1. D0 (P3-20a–e) can start today — it needs no external account. Build
   it while the Stripe key and the Meta portfolio are set up.
2. The Stripe key → backfill verified → first autonomous sync → the
   amended gate is met → D1.
3. The hosting decision before D2.

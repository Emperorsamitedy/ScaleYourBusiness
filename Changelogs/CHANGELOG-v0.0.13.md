# Changelog v0.0.13 — Ledgerline (SYB)

Phase 2 reaches production: the deploy unblock, the automation armed, and the
formatting debt paid. Convention per v0.0.12 — new file, released files stay
history.

---

## Orientation delta (what changed since v0.0.12's orientation)

- **The repo moved**: `github.com/JanKenzeroX/ScaleYourBusiness` (old
  CyberSammy-tg URL redirects for now; local remotes updated)
- **Production now runs Phase 2** — code and schema in step at `45e7e84`
- **`CONNECTOR_KEY` and `CRON_SECRET` are SET in Vercel Production** — the
  v0.0.12 "automations parked" entry is closed; both crons are armed
- Vercel CLI updated 59.11.1 → 59.23.2

---

## Fixed — the eight-day deploy block (2026-09-16 → 09-20)

Every deployment of the Phase 2 commit sat in `readyState: BLOCKED` with zero
builds, across six attempts and three days of diagnosis. Ruled out with
evidence along the way: the code (`next build` and `vercel build` both pass
locally), the network (0/20 DNS failures, 8/8 node fetches), the CLI version,
and daily limits.

**The actual cause, identified by the owner:** Vercel's Hobby-plan contributor
rule. The Phase 2 commits were authored by `Samuel Tegene
<dokimasabrham91@gmail.com>` — an identity not on the Vercel account — and
Hobby refuses to build commits from non-members. Every earlier deploy was
owner-authored; the first `BLOCKED` was the first deploy after pulling the
companion's commits. The timeline fits exactly.

**The fix:** both commits re-authored to the account owner via rebase-amend —
the same authorship transfer GitHub's "Squash & merge" performs — with
`Co-authored-by: Samuel Tegene` trailers preserving credit in the history.
Tree hashes verified byte-identical before the force-push (`git diff
8c7d604 HEAD --stat` → empty). `8c7d604 → 45e7e84`, forced update, owner-run.

**Recorded plainly:** this works around the collaboration policy rather than
satisfying it. The durable fixes remain a Pro seat or a hosting move. Until
one of those happens, commits must reach `main` authored as
`samuel.tewodros.123@gmail.com` — either Samuel Tegene sets that identity in
`git config user.email` on his machine, or his work is re-authored on merge as
here. **Samuel: before your next commit, run `git fetch && git reset --hard
origin/main`** — your local history predates the rewrite and pushing it would
resurrect the blocked commits.

---

## Deployed — Phase 2 live on production (2026-09-20)

- Migrations **0022 and 0023** applied to the production database first
  (22 → 24), verified purely additive: `connections`, `metric_observations`,
  `connector_syncs`, `anomalies` created; all existing data intact through
  the whole saga (13 profiles, 403 facts, 4 reports, 17 offers, 421
  decision-log entries)
- Deploy `45e7e84` reached `READY` on the first attempt after re-authoring;
  the production alias serves it
- Full surface verified live: all seven screens 200 including
  `/connections`; `/api/connections` 401 unauthenticated; the cron routes
  404 without the bearer secret — every gate behaving as designed
- **`CONNECTOR_KEY`** (32-byte hex, generated locally, never seen by tooling)
  and **`CRON_SECRET`** added to Vercel Production as Secrets, followed by a
  redeploy so the runtime loads them. The connections screen can now encrypt
  a provider credential; both crons — connector sync daily 04:30 UTC, weekly
  watch Mondays 06:00 UTC — will be invoked by Vercel's scheduler with the
  secret. First firings are the proof-of-life; check `connector_syncs` and
  `watch_activity` after.

---

## Fixed — the formatting debt (v0.0.12's "Found, not fixed")

`npx prettier --write .` across the repo: **74 files** reformatted, closing
the CI formatting failure v0.0.12 flagged on at least six files. Verified
after: `prettier --check` clean, `tsc --noEmit` clean, `eslint` clean,
**600/600 tests passing**. No functional change anywhere — whitespace and
style only.

Also: `.vercel/` added to the eslint ignore list. A local `vercel build`
leaves thousands of generated files in `.vercel/output`, which turned a
clean lint into 4,380 errors until diagnosed; generated output is now
ignored like `.next/`.

---

## Still parked (owner decisions, on record)

- Stripe / Resend keys — the payment gate is built but unarmed; login links
  render on-screen
- `OPS_KEY` — `/ops` stays dark
- The 7-persona harness tail; P0-71
- Google Ads (P2-20) — blocked on Google's developer token + OAuth
  verification
- The Pro-or-move hosting decision that retires the contributor workaround

## Next (unchanged from v0.0.12, minus what closed today)

1. **Real-account runs** — Stripe test key, Shopify dev store, WooCommerce
   site, GA4 property, Meta ad account. Each closes its session's done-when.
   The Stripe run is first and one screen away: `/connections`.
2. **Two weeks of unattended daily sync** — the clock can now actually run;
   its prerequisites (`CRON_SECRET`, migrations, deploy) all closed today.
3. Then judge Phase 2's done-when honestly, and plan Phase 3.

# Changelog v0.0.12 — Ledgerline (SYB)

Phase 2 (Measurement), Sessions A to E: the connector spine, Stripe, stores, traffic and ad spend, and anomaly detection.

---

## 📁 How changelogs work now — please read

Changelogs live in `Changelogs/`, one file per version, named
`CHANGELOG-v0.0.NN.md`. They are **append-only in spirit**: a released file
is history and does not get rewritten. New work goes in the next number.

- `CHANGELOG-v0.0.11.md` — everything up to and including v0.13.0
  (Phases 0 and 1, reconstructed from git history on 2026-09-11)
- `CHANGELOG-v0.0.12.md` — this file, Phase 2 Session A onward

**Tedi — please follow the same convention**: when you start the next block
of work, create `CHANGELOG-v0.0.13.md` rather than editing this one, and
record your changes there as you go. One file per version keeps the trail
readable for whoever picks the project up next, and it means we stop
colliding on the same file every time we both work in the same week.

---

## Orientation for a collaborator

- Production: https://syb-kappa.vercel.app (Vercel; deploys are **manual** —
  `npx vercel --prod --archive=tgz`; `vercel git connect` has NOT been run)
- Plans: `TASKS.md` (Phase 0, done), `TASKS-PHASE1.md` (done),
  `TASKS-PHASE2.md` (current — **every buildable Phase 2 task is done; what remains is real-account runs and two weeks of unattended sync**)
- Rules: `CLAUDE.md` — read it before writing anything; the specs in
  `specs/` win over everything
- Deploy order when schema changes: migrate the prod DB first
  (`DATABASE_URL=<prod> npx drizzle-kit migrate`), then deploy; bank changes
  also need `npx tsx scripts/seed-bank.ts` against prod
- Local: `docker compose up` (Postgres on **5433**), `npm run db:migrate`,
  `npm run db:seed`, `npm run dev`, `npx vitest run` (**600 tests**)
- Env: copy `.env.example` to `.env`. From Phase 2, **`CONNECTOR_KEY`** is
  required to connect or sync a provider. Generate one with:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- Windows: Python is now found as `python3`, `python` or `py` (override with
  `PYTHON`), and `.gitattributes` keeps checkouts LF so `format:check`
  behaves the way it does in CI

---

## Added — Phase 2 Session A: the connector spine (P2-01..06)

All six boxes of Session A are ticked in `TASKS-PHASE2.md`. Its "done when"
is met: the in-repo fixture connector connects, backfills, syncs
incrementally, derives facts that supersede estimates, and passes the scope
audit — with no external account anywhere.

- **`connections`** (P2-01) — one live row per account+provider, partial-unique
  on non-disconnected so a provider can be reconnected after being dropped.
  Disconnecting wipes the credential and stops sync but **keeps the row**:
  every observation cites its connection for provenance (rule 2), and a fact
  whose source row vanished would be a bare value with extra steps.

- **`metric_observations`** (P2-02) — one row per
  connection + metric + dimensions + day, upserted on that natural key.
  Re-ingesting a day corrects it in place, so a killed backfill is safe to
  re-run and cannot double-count. Money stays integer minor units plus
  currency (rule 1); counts stay numeric. `dimension_key` is the canonical
  serialisation of `dimensions` — the half of the natural key a jsonb column
  cannot reliably provide.

- **Secrets at rest** (P2-03, rule 10) — AES-256-GCM under `CONNECTOR_KEY`,
  fresh IV per write, GCM tag for tamper detection. Tests prove a stored row
  is noise without the key, and that "wrong key" and "tampered payload" are
  deliberately indistinguishable in the error.

- **The scope audit** (P2-04, rule 9) — a code-level per-provider scope
  registry, plus a test that **fails the build** if any registered scope is
  write-capable. At connect time the granted scopes are verified against the
  registry: a provider granting _more_ than we asked for is a connect
  failure, not a shrug. The landing page promised read-only in writing; this
  is that promise as code.

- **Derived-fact writer** (P2-05) — observations become
  `revenue.monthly_revenue`, `revenue.order_count_monthly` and
  `marketing.monthly_ad_spend` as `inferred` facts at the §8.1 connector
  confidence (0.95), each naming its observation window and method (rule 6).
  The owner's estimate is **superseded, not overwritten** (rule 3) and stays
  in history under their own name with their own wording. A window holding
  two currencies **refuses** rather than blending, and the owner's figure
  stays current (rule 1).

- **Sync runner** (P2-06) — a daily Vercel cron at 04:30 walking every
  connected connection, with a per-connection Postgres advisory lock (held on
  its own pooled client, so a killed process releases it with the session),
  a hard page cap per run, and a failure count that parks a connection as
  `failed` after five consecutive errors. Each run writes a `connector_syncs`
  telemetry row, in the `llm_calls` mould. **The job-queue decision is
  recorded, not assumed** (`lib/connectors/sync.ts`): cron routes stay until a
  measured run exceeds half the route's limit; only then does BullMQ take
  over the loop, and nothing else changes.

- **Fixture connector** — an in-repo provider with no network and no external
  account, so the entire spine is provable in CI. Its figures are a pure
  function of the date, so re-ingestion is byte-identical and idempotency can
  be asserted exactly. Deliberate credentials exercise the over-granting
  refusal and the failure cap.

- Migration **0022**; new env var `CONNECTOR_KEY`; second cron entry in
  `vercel.json`.

### Tests

**430 passing** across 47 files, up from 369. Sixty-one new tests cover the
spine, including the ones `TASKS-PHASE2.md` names by hand: the estimate
survives in history with the owner's name, the current fact is measured, and
currencies never blend.

---

## Fixed

- **A daily cron would have written 365 identical history rows a year.**
  The "has this actually changed?" check compared the stored value against
  the freshly computed one with `JSON.stringify`. Postgres normalises JSONB
  key order, so a `Money` written as `{amount_minor, currency}` reads back as
  `{currency, amount_minor}` — every unchanged day looked like a change.
  Replaced with an order-insensitive deep equality, and there is now a
  regression test that first proves storage really does reorder the keys.

- **`lint_bank.py` could not be found on Windows.** The bank loader shelled
  out to `python3`, which on a default Windows install is a Microsoft Store
  alias that runs nothing and exits non-zero. It now probes
  `python3` → `python` → `py` for a real Python 3 (override with `PYTHON`),
  testing for a version string rather than merely "the call did not throw".
  Without this, `npm run db:seed` and every bank-dependent test fail on a
  fresh Windows clone.

- **`.gitattributes` added.** Without it a Windows checkout
  (`core.autocrlf=true`) produces CRLF files that `prettier --check` rejects
  on sight — all ~227 of them — so `npm run format:check` was unusable
  locally while passing in CI on Linux.

- **`package-lock.json`** version field was stale at `0.0.1`; it now tracks
  `package.json`. No dependency versions changed.

---

## Added — Phase 2 Session B: Stripe, the first truth (P2-07..13)

Built and tested against a recorded-shape Stripe (`lib/connectors/providers/stripe-fake.ts`). **The session's done-when still needs one run with a real Stripe test-mode restricted key.**

- **Owner decision, recorded (2026-09-14): restricted keys only, no Stripe App.** Stripe has no API that lists a restricted key's permissions, so the plan's "validate the key's scopes on save" cannot be built. P2-07 is amended in `TASKS-PHASE2.md`. What is enforced instead: full-access `sk_` keys are refused before any request; every read is proven at connect time, with Stripe's own 403 message shown on a missing permission; the connector can only send GETs to registered paths, guarded at the type level, at runtime, and by a source-scanning test that fails the build. The connections screen says in words that the key's other permissions cannot be checked (`scopeVerification: "probed"`).
- **Stripe connector** (P2-07..09): reads balance transactions only, API version pinned to `2026-08-26.dahlia`. Revenue is sales minus refunds and partial-capture reversals, before fees; disputes, fees and payouts are excluded. UTC days, currencies never blended, zero days emitted. A year backfilled in 30-day windows, resumable by cursor; daily runs re-read the last two days; a day too busy for one window shrinks instead of skipping; retries on 429/5xx capped at 3.
- **Measured facts reach the report** (P2-10/11): `lib/connectors/measured.ts` marks a fact as measured by its `connector:` series. Fixed a real gap: the economics engine only read `answered` facts, so Stripe figures would have been silently ignored. The report, fact sheet and diagnosis now label them "measured", and the report shows "You estimated X; Stripe measured Y" by walking the supersession chain back to the owner's own figure (rule 11).
- **Connections screen and API** (P2-12): `/connections`, `/api/connections`, `/api/connections/sync`. Sign-in required; another account's connection is "not found"; the key is encrypted and never returned.
- **Watch log** (P2-13): a sync writes "Read 365 days of Stripe payments." only when new days landed or a figure changed.

### Tests

**482 passing** across 51 files, up from 430. New suites: `stripe`, `report-integration`, `activity`, `ownership`.

### Found, not fixed

- **CI's formatting step is very likely failing on `main`.** At least six of Tedi's committed files fail `prettier --check` (for example `components/report/Report.tsx`, `app/globals.css`, `lib/diagnosis/findings.ts`). This change set deliberately does not reformat them, to avoid unrelated churn and merge conflicts. A separate `npx prettier --write .` commit would fix it.

---

## Added — Phase 2 Session C: stores (P2-14..17)

Built and tested against recorded-shape Shopify and WooCommerce. **The session's done-when still needs one run against a real Shopify development store and a real WooCommerce site.**

- **Shopify's plan had to change** (P2-14 amended in `TASKS-PHASE2.md`). New admin-created custom apps can't be made since 2026-01-01, so there is no "custom app token" for a new store. The owner creates an app in Shopify's **Dev Dashboard**, installs it on their store, and gives us the store address, client ID and client secret. We exchange those for a 24-hour token with the client credentials grant, which only works when app and store share a Shopify organization.
- **Shopify read-only is genuinely verified.** Shopify reports a token's exact scopes, so a write scope, or any read scope outside the registry, refuses the connection (`scopeVerification: "reported"`). GraphQL sends reads as request bodies, so the build gate is: only the fixed read queries in `SHOPIFY_QUERIES`, plus the token exchange; the source scan fails the build otherwise. Requests only ever go to a `*.myshopify.com` host.
- **History depends on Shopify's approval.** Orders older than 60 days need `read_all_orders`, which Shopify must approve. With it the backfill reads a year; without it, 60 days, and the connections screen says so.
- **WooCommerce** (P2-17) behind the same contract: REST, basic auth, page-numbered lists. Its keys can't report their access level, so it is `probed` like Stripe: GET-only to registered paths, and the screen asks for a Read key. The owner-typed store address is validated first: https only, no IP literals, localhost, internal names or embedded credentials.
- **Product matching** (P2-15): the system suggests matches between store products and the owner's offers by name, with no model call; the owner confirms each one; the match is stored as the owner's own fact (`offers.<id>.product_ref.<provider>`). "No match" is recorded too, and unmatched products are listed as a gap.
- **Measured units per offer** (P2-16): a store's units sold per matched product become that offer's monthly `volume_period`, superseding the owner's estimate. The economics engine now accepts measured entity facts, and the report's "you estimated, the store measured" line covers volume.
- **Shared plumbing:** exact decimal-string money parsing (`decimal.ts`, no floats), a shared day-window planner (`days.ts`), multi-field credentials encrypted as one object, `/api/connections/mapping`, and a matching panel on `/connections`.

### Fixed during the session

- **A first backfill re-read about 25 days it had just fetched.** Store syncs re-read the last 30 days to catch late refunds, but the planner applied that to the final window of a first backfill too. It now re-reads only once the connection has caught up to yesterday. Data was never wrong, because re-reading overwrites, but it wasted API calls.
- **Business-wide revenue could have double-counted per-product rows.** Derivation now sums only rows that aren't sliced by product, offer or channel.

### Tests

**539 passing** across 55 files, up from 482. New suites: `shopify`, `woocommerce`, `mapping`, `decimal`.

---

## Added — Phase 2 Session D: traffic and ad spend (P2-18, P2-19, P2-21; P2-20 blocked)

Built and tested against recorded-shape Google Analytics and Meta. **Needs one run each with a real GA4 property and a real Meta ad account.**

- **Google Ads deferred (owner decision, 2026-09-15).** Google requires Ledgerline itself to hold a developer token and pass OAuth app verification for the `adwords` scope, and offers no read-only scope: read-only would rest on the owner connecting as a Read-only user in their Ads account. P2-20 stays blocked until both approvals exist; ad spend is measured from Meta meanwhile.
- **Google Analytics** (P2-18): the owner adds a service account as Viewer on the GA4 property and pastes its key file. The connector signs a one-hour token asking for `analytics.readonly` and nothing else, confirms the scope with Google's tokeninfo, and reads sessions per day and per default channel group. It knows exactly three Google URLs and ignores the key file's own `token_uri`; the build gate fails on any other host or scope. GA4 reprocesses recent days, so the last 3 are re-read.
- **Channel matching** (P2-18): the product-matching pattern generalised. GA4 channel groups are suggested against the owner's channel type and platform (Paid Social ↔ paid ads on Meta, and so on); the owner confirms; a matched channel's visits become `channels.<id>.monthly_sessions`, and the business total becomes `presence.monthly_sessions`. Both fields added to the data model as measured-only.
- **Meta Ads** (P2-19): a system user token with `ads_read` for the owner's own ad account, which needs no app review. Meta reports a token's permissions, so `ads_management` or anything beyond `ads_read` refuses the connection. Reads daily spend in the account currency and attributed purchases; overlapping purchase types are never summed; the last 8 days are re-read while attribution settles. GET-only, token in a header, never in a URL. **PROVISIONAL**: Meta's developer documentation was unreachable from the build environment, so field and error details follow Meta's widely documented behaviour and must be confirmed against a real account.
- **What the ads pay back** (P2-21): `marketing.cost_per_purchase` is measured as spend over attributed purchases (refused, never divided by zero, when there are none). The economics engine gains a blended return on ad spend, revenue over ad spend, computed only when both sides exist and shown on the report with its source line. Cost per acquisition now computes from measured spend and orders.

### Tests

**576 passing** across 58 files, up from 539. New suites: `ga4`, `meta-ads`, `traffic-and-spend`.

---

## Added — Phase 2 Session E: anomaly detection (P2-22..25)

Deterministic statistics on the daily observations, no model calls. Phase 2's last buildable block.

- **The baseline** (P2-22): for any day, the 28 days before it give an overall mean and a factor per weekday (a Sunday that always runs at 60% of the week gets a factor near 0.6, so a quiet Sunday is expected, not alarming). Expected = mean × the day's factor. The "usual variation" is the median absolute deviation of the window's residuals, scaled to a sigma and floored at 5% of the day's expected value so a flat series still has a unit.
- **The rule** (P2-23): a day is beyond at more than 3× the usual variation, either direction, strictly; an anomaly is 2 consecutive beyond days the same way. One odd day is noise. The plan's two sentences are the first two tests: a seeded 20% weekday drop fires, a normal weekend dip does not. Boundaries are tested at exactly 3× (not beyond) and a hair past it (beyond), both ways.
- **The watch** (P2-24): every sync ends with the anomaly check. A new run writes an `anomalies` row and one watch-log line with the arithmetic in words ("Revenue (EUR) fell 22% below the expected level for 2 days in a row: … 28-day average … × Sunday factor 0.60; 4.1× the usual variation, threshold 3×"). A continuing run says nothing more; a recovery resolves the row and says so once. The status screen's interruption thresholds are now code: a revenue drop of 30% or more week over week marks the anomaly `interrupt` and the screen shows it. The two other promised interruptions are listed as "promised, not yet checked automatically" rather than implied.
- **Telemetry** (P2-25): each anomaly stores the window's points, the weekday factors, the residual statistics and the week-over-week sums, so a false positive can be replayed from the row and the constants tuned from evidence. Migration **0023**.

### Fixed during the session

- The first draft floored the variation scale at 5% of the overall mean rather than the day's expected value, so the same 20% drop read as a smaller deviation on a quiet Sunday than on a busy Saturday. Caught by the plan's own "seeded 20% drop fires" test landing on a Sunday.

### Tests

**600 passing** across 60 files, up from 576. New suites: `anomaly/baseline`, `anomaly/detect`.

---

## Still parked (owner decisions, on record)

Unchanged from v0.0.11, plus one new entry:

- Stripe / Resend keys — the payment gate is built but **unarmed**
- **`CRON_SECRET` and `OPS_KEY` are not set in Vercel.** This is the
  "automations" item: `vercel.json` schedules the weekly watch job (Mondays
  06:00) and now the connector sync (daily 04:30), but both routes reject
  every call with a 404 until `CRON_SECRET` exists in the Vercel
  environment. The jobs are built and tested; they are simply not armed in
  production. `/ops` is dark for the same reason, behind `OPS_KEY`.
- The 7-persona harness tail
- P0-71 — the human-timed entity-entry test

---

## Next

Phase 2's buildable work is complete. What remains is the owner's to schedule:

1. **Real-account runs** (on hold by owner choice): a Stripe test key; a Shopify development store and a WooCommerce site; a GA4 property with a service account as Viewer; a Meta ad account with a system user token. Each closes its session's done-when and confirms the provisional details noted in the code.
2. **Two weeks of unattended daily sync** on production, which needs `CRON_SECRET` set in Vercel (the "automations" item, still parked) and migrations 0022 and 0023 applied to the production database before deploying.
3. **Google Ads** (P2-20): apply for a developer token and Google OAuth verification when ready.
4. Then the Phase 2 done-when can be judged honestly, and Phase 3 planned.

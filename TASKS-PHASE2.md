# TASKS-PHASE2.md — Measurement

Commit-sized tasks in strict order. Work top to bottom. Reference the task ID in each commit message.

**Scope: Phase 2 only** — read-only connectors that replace what the owner estimated with what actually happened, without ever losing the estimate or its provenance. The landing's own words are the contract: *"Read-only connections to the places your numbers already live. What actually happened replaces what you estimated — and your original stays in the history, with your name on it."*

**Gate status, recorded honestly:** TASKS-PHASE1.md gated Phase 2 on strangers paying for the report. The owner overrode that gate on 2026-09-11 ("we're going to phase 2"), the same deliberate override as P0-86. This file exists because of that decision; nobody should later mistake it for the gate having been met.

**Status: PROVISIONAL.** Provider API specifics (Stripe restricted-key scopes, Shopify API versions, GA4 quotas) must be verified at build time, not trusted from this plan. Every session that touches a provider starts by reading that provider's current docs.

**What Phase 2 is NOT** (still fenced, Phase 3+): the approval queue, proposals, the execution engine, anything with a write scope anywhere, support/CRM/finance modules. If a task seems to need one of these, stop and ask.

---

## Non-negotiables inherited, plus three new ones

The eight CLAUDE.md rules apply unchanged — measured facts are `Field<T>`s with `source.kind: "connector"`, they supersede rather than overwrite, and money stays integer minor units with its own currency. New for Phase 2:

**9. Read-only scopes, forever.** A scope audit is part of the definition of done for every connector: a code-level registry of exactly the scopes requested, and a test that fails the build if any write-capable scope appears in it. The landing promised this in writing.

**10. Connection secrets are encrypted at rest.** API keys and tokens for owner accounts are AES-256-GCM encrypted with a key from the environment, never stored plaintext, never logged, never returned by any API. A leaked database row must not be a leaked Stripe account.

**11. Measured beats stated, visibly.** When a connector value supersedes an owner estimate, the report shows the delta ("you estimated $8,300/month; Stripe measured $6,910") rather than silently swapping. Trust is built by showing the correction, not hiding it.

---

## Session A — The connector spine _(~18h)_

Schema and contracts everything else stands on. No provider code yet.

- [ ] **P2-01** `connections` table: account_id, provider, status (connected/paused/failed/disconnected), encrypted_secret, granted_scopes[], cursor, last_sync_at, created_at. Disconnecting revokes locally and stops sync; rows are kept, not deleted.
- [ ] **P2-02** `metric_observations` table, append-only: provider, metric key ("revenue.daily", "orders.daily", "ad_spend.daily", "sessions.daily"), dimensions jsonb (offer_id, channel_id, currency), period_date, value_minor/value_num, observed_at. One row per provider-metric-dimension-day; re-ingestion upserts idempotently by that natural key.
- [ ] **P2-03** Secret encryption: AES-256-GCM helpers keyed from `CONNECTOR_KEY` env, with tests proving a row read without the key is noise and that secrets never appear in logs or API responses.
- [ ] **P2-04** The scope audit (rule 9): per-provider scope registry in code, a test that fails on any write-capable scope, and granted_scopes verified against the registry at connect time — a provider granting MORE than asked is a connect failure, not a shrug.
- [ ] **P2-05** Derived-fact writer: `metric_observations` → profile facts (`revenue.monthly_revenue`, `revenue.order_count_monthly`, `marketing.monthly_ad_spend`) written as `inferred` with `derived_from` naming the observation window and method (rule 6), superseding owner estimates (rule 3). Unit tests: estimate survives in history with owner's name; current fact is measured; currencies never blend.
- [ ] **P2-06** Sync runner: a daily Vercel cron route (CRON_SECRET pattern from P1-46) walking connected accounts with a per-connection advisory lock, hard attempt caps, and cost/duration telemetry per sync into the structured log + llm_calls-style table. **Job-queue decision recorded, not assumed:** stay on cron routes until a real sync exceeds serverless limits; the BullMQ criterion is written down here, not improvised later.

**Done when:** a fake in-repo provider ("fixture connector") can connect, backfill from fixtures, sync incrementally, produce derived facts that supersede estimates, and pass the scope audit — all without any real external account.

---

## Session B — Stripe, the first truth _(~20h)_

*"Payments are the most reliable truth about revenue."*

- [ ] **P2-07** Connect flow: the owner creates a **restricted, read-only** Stripe key themselves (guided UI listing exactly which read scopes to grant and why — the guide IS the scope registry rendered); we validate the key's scopes against the registry on save. No OAuth app dependency for v1; Stripe Connect can come later without schema change.
- [ ] **P2-08** Backfill: twelve months of balance transactions → daily `revenue.daily` and `orders.daily` observations, refunds netted, currency preserved per row, resumable by cursor so a killed backfill continues instead of restarting.
- [ ] **P2-09** Daily incremental sync from the stored cursor; idempotent under re-runs and Stripe's eventual consistency.
- [ ] **P2-10** Derived facts live: measured monthly revenue and order count supersede the intake estimates via P2-05. The Beardbrand-class refusals ("average order value — order count missing") start resolving from measurement.
- [ ] **P2-11** Report integration (rule 11): economics prefers measured values; where a stated figure was superseded, the report shows stated-vs-measured with both sources. The `stated_vs_computed_margin` pattern generalises.
- [ ] **P2-12** Connections screen: provider, read-only badge, granted scopes listed verbatim, last sync, backfill progress, disconnect. In the Ember language; no new design system.
- [ ] **P2-13** Watching integration: sync writes honest `watch_activity` entries ("Read 34 days of Stripe payments") — the ux-spec §6 example becomes literally true.

**Done when:** a real Stripe test-mode account connects read-only, backfills 12 months of fixture-seeded data, the profile's revenue facts flip to measured with the estimate preserved in history, and the report shows the stated-vs-measured delta.

---

## Session C — Commerce: Shopify first _(~18h)_

- [ ] **P2-14** Shopify read-only connect (custom app token, scope-audited: read_orders, read_products only).
- [ ] **P2-15** Product mapping: Shopify products ↔ the profile's `offers` entities — suggested automatically, confirmed by the owner, stored as facts with provenance. Unmapped products are a gap, not a guess.
- [ ] **P2-16** Backfill + daily sync of orders by offer → `revenue.daily` and `orders.daily` with offer_id dimensions; per-offer volume feeds the economics engine's per-offer margins at last.
- [ ] **P2-17** WooCommerce variant of P2-14..16 behind the same interface — proves the connector contract generalises before the ads providers multiply it.

**Done when:** per-offer measured volume renders in the report's numbers table with "measured" source lines.

---

## Session D — Traffic and spend: GA4, Meta Ads, Google Ads _(~22h)_

- [ ] **P2-18** GA4 read-only: sessions/users by channel per day → channel-dimension observations mapped to the profile's `channels` entities (same confirm-the-mapping pattern as P2-15).
- [ ] **P2-19** Meta Ads read-only: daily spend + attributed purchases → `ad_spend.daily`; measured spend supersedes `marketing.monthly_ad_spend`, and the 8-week watch rule (Session H) starts firing on measured truth.
- [ ] **P2-20** Google Ads read-only, same shape.
- [ ] **P2-21** CAC and ROAS computed (not asserted) when spend and orders are both measured — with the economics engine's existing refusal discipline when either side is missing.

**Done when:** the FTGU-class finding "you advertise but can't measure if it pays off" can be answered by the system itself for a connected business.

---

## Session E — Anomaly detection _(~14h)_

*"Knows a weekend dip from a real 20% drop."* Deterministic statistics — no model calls; this is arithmetic on observations (CLAUDE.md cost rule).

- [ ] **P2-22** Baseline model per metric: rolling 28-day mean with weekday seasonality factors, computed nightly from observations.
- [ ] **P2-23** Anomaly rule: deviation beyond k·MAD from the weekday-adjusted baseline for N consecutive days → an anomaly record with the arithmetic shown. Thresholds in code with tests at the boundaries, both directions (drops AND spikes).
- [ ] **P2-24** Watching integration: anomalies write `watch_activity` and, when they cross the Session H interrupt thresholds, surface as the interruption the status screen has been promising. The thresholds stop being copy and become code.
- [ ] **P2-25** Anomaly telemetry: every anomaly recorded with its baseline inputs, so a false positive can be replayed and the thresholds tuned from evidence — the diagnosis-prompt calibration discipline applied to statistics.

**Done when:** a seeded 20% drop on a weekday fires; a normal weekend dip does not; both assertions are tests.

---

## Phase 2 is done when

A business connects Stripe and one commerce source with provably read-only scopes, twelve months backfill, and daily unattended sync for two weeks straight; its report's revenue, orders, spend and per-offer numbers carry "measured" source lines with the owner's original estimates visible in history; the stated-vs-measured deltas render; and one genuine anomaly has been caught, shown with its arithmetic, without a single false alarm on a weekend.

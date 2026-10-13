# TASKS-PHASE2.md — Measurement

Commit-sized tasks in strict order. Work top to bottom. Reference the task ID in each commit message.

**Scope: Phase 2 only** — read-only connectors that replace what the owner estimated with what actually happened, without ever losing the estimate or its provenance. The landing's own words are the contract: _"Read-only connections to the places your numbers already live. What actually happened replaces what you estimated — and your original stays in the history, with your name on it."_

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

- [x] **P2-01** `connections` table: account_id, provider, status (connected/paused/failed/disconnected), encrypted_secret, granted_scopes[], cursor, last_sync_at, created_at. Disconnecting revokes locally and stops sync; rows are kept, not deleted.
- [x] **P2-02** `metric_observations` table, append-only: provider, metric key ("revenue.daily", "orders.daily", "ad_spend.daily", "sessions.daily"), dimensions jsonb (offer_id, channel_id, currency), period_date, value_minor/value_num, observed_at. One row per provider-metric-dimension-day; re-ingestion upserts idempotently by that natural key.
- [x] **P2-03** Secret encryption: AES-256-GCM helpers keyed from `CONNECTOR_KEY` env, with tests proving a row read without the key is noise and that secrets never appear in logs or API responses.
- [x] **P2-04** The scope audit (rule 9): per-provider scope registry in code, a test that fails on any write-capable scope, and granted_scopes verified against the registry at connect time — a provider granting MORE than asked is a connect failure, not a shrug.
- [x] **P2-05** Derived-fact writer: `metric_observations` → profile facts (`revenue.monthly_revenue`, `revenue.order_count_monthly`, `marketing.monthly_ad_spend`) written as `inferred` with `derived_from` naming the observation window and method (rule 6), superseding owner estimates (rule 3). Unit tests: estimate survives in history with owner's name; current fact is measured; currencies never blend.
- [x] **P2-06** Sync runner: a daily Vercel cron route (CRON_SECRET pattern from P1-46) walking connected accounts with a per-connection advisory lock, hard attempt caps, and cost/duration telemetry per sync into the structured log + llm_calls-style table. **Job-queue decision recorded, not assumed:** stay on cron routes until a real sync exceeds serverless limits; the BullMQ criterion is written down here, not improvised later.

**Done when:** a fake in-repo provider ("fixture connector") can connect, backfill from fixtures, sync incrementally, produce derived facts that supersede estimates, and pass the scope audit — all without any real external account.

---

## Session B — Stripe, the first truth _(~20h)_

_"Payments are the most reliable truth about revenue."_

- [x] **P2-07** Connect flow: the owner creates a **restricted, read-only** Stripe key themselves (guided UI listing exactly which read scopes to grant and why — the guide IS the scope registry rendered). ~~We validate the key's scopes against the registry on save.~~ **Amended 2026-09-14, owner decision:** Stripe has no API that lists a restricted key's permissions, so the key cannot be validated against the registry as first written. Instead, full-access `sk_` keys are refused before any request is sent; every read the connector needs is proven at connect time, with a missing permission surfacing Stripe's own 403 message; and the connector can only issue GETs to registered paths, enforced by a build-failing test. The screen states plainly that the key's other permissions cannot be checked (`scopeVerification: "probed"`). No OAuth app dependency, and no Stripe App planned.
- [x] **P2-08** Backfill: twelve months of balance transactions → daily `revenue.daily` and `orders.daily` observations, refunds netted, currency preserved per row, resumable by cursor so a killed backfill continues instead of restarting.
- [x] **P2-09** Daily incremental sync from the stored cursor; idempotent under re-runs and Stripe's eventual consistency.
- [x] **P2-10** Derived facts live: measured monthly revenue and order count supersede the intake estimates via P2-05. The Beardbrand-class refusals ("average order value — order count missing") start resolving from measurement.
- [x] **P2-11** Report integration (rule 11): economics prefers measured values; where a stated figure was superseded, the report shows stated-vs-measured with both sources. The `stated_vs_computed_margin` pattern generalises.
- [x] **P2-12** Connections screen: provider, read-only badge, granted scopes listed verbatim, last sync, backfill progress, disconnect. In the Ember language; no new design system.
- [x] **P2-13** Watching integration: sync writes honest `watch_activity` entries ("Read 34 days of Stripe payments") — the ux-spec §6 example becomes literally true.

**Done when:** a real Stripe test-mode account connects read-only, backfills 12 months of fixture-seeded data, the profile's revenue facts flip to measured with the estimate preserved in history, and the report shows the stated-vs-measured delta.

**Status 2026-09-14:** P2-07..13 built and tested against a recorded-shape Stripe (482 tests passing). The done-when is **not yet met**: it needs one run against a real Stripe test-mode restricted key, which also confirms the PROVISIONAL permission name in `SCOPE_GUIDE` ("Balance: Read").

---

## Session C — Commerce: Shopify first _(~18h)_

- [x] **P2-14** Shopify read-only connect (~~custom app token~~, scope-audited: read_orders, read_products only). **Amended 2026-09-14:** Shopify stopped allowing new admin-created custom apps on 2026-01-01, so there is no custom app token for a new store. The owner creates an app in Shopify's Dev Dashboard, installs it on their own store, and gives us its store address, client ID and client secret; we exchange those for a 24-hour token with the client credentials grant, which only works when app and store share a Shopify organization. Shopify reports a token's scopes, so the audit here is a real check (`scopeVerification: "reported"`). `read_all_orders` is an optional third scope: orders older than 60 days need it and Shopify must approve it, so history is a year with it and 60 days without, stated on screen.
- [x] **P2-15** Product mapping: Shopify products ↔ the profile's `offers` entities — suggested automatically, confirmed by the owner, stored as facts with provenance. Unmapped products are a gap, not a guess.
- [x] **P2-16** Backfill + daily sync of orders by offer → `revenue.daily` and `orders.daily` with offer_id dimensions; per-offer volume feeds the economics engine's per-offer margins at last.
- [x] **P2-17** WooCommerce variant of P2-14..16 behind the same interface — proves the connector contract generalises before the ads providers multiply it.

**Done when:** per-offer measured volume renders in the report's numbers table with "measured" source lines.

**Status 2026-09-14:** P2-14..17 built and tested against recorded-shape Shopify and WooCommerce (539 tests passing). Per-offer measured **units** feed each matched offer's monthly volume, the economics and the stated-vs-measured comparison; per-offer revenue was deliberately not split out, because the economics engine uses price × volume and nothing reads it yet. The done-when is **not yet met**: it needs one run against a real Shopify development store (and, for P2-17, a real WooCommerce site) to confirm the Dev Dashboard flow and whether `read_all_orders` is grantable to an owner-created app.

---

## Session D — Traffic and spend: GA4, Meta Ads, Google Ads _(~22h)_

- [x] **P2-18** GA4 read-only: sessions/users by channel per day → channel-dimension observations mapped to the profile's `channels` entities (same confirm-the-mapping pattern as P2-15).
- [x] **P2-19** Meta Ads read-only: daily spend + attributed purchases → `ad_spend.daily`; measured spend supersedes `marketing.monthly_ad_spend`, and the 8-week watch rule (Session H) starts firing on measured truth.
- [ ] **P2-20** Google Ads read-only, same shape. **⏸ Blocked, owner decision 2026-09-15 (deferred until approved):** Google Ads needs Ledgerline's own developer token and Google OAuth app verification of the `adwords` scope, and it has no read-only scope at all; read-only would rest on the owner connecting with a Read-only user in their Ads account. Nothing can be tested for real until both approvals exist. Ad spend is measured from Meta until then.
- [x] **P2-21** CAC and ROAS computed (not asserted) when spend and orders are both measured — with the economics engine's existing refusal discipline when either side is missing.

**Done when:** the FTGU-class finding "you advertise but can't measure if it pays off" can be answered by the system itself for a connected business.

**Status 2026-09-15:** P2-18, P2-19 and P2-21 built and tested against recorded-shape Google Analytics and Meta (576 tests passing); P2-20 blocked as above. With Stripe or a store measuring revenue and orders, and Meta measuring spend, the economics engine computes cost per acquisition and a blended return on ad spend, and refuses when either side is missing. **Not yet met for real**: needs one run with a real GA4 property (service account as Viewer) and a real Meta ad account (system user token with ads_read). Meta's developer docs could not be reached from the build environment, so its field and error details are PROVISIONAL and marked so in `providers/meta-ads.ts`.

---

## Session E — Anomaly detection _(~14h)_

_"Knows a weekend dip from a real 20% drop."_ Deterministic statistics — no model calls; this is arithmetic on observations (CLAUDE.md cost rule).

- [x] **P2-22** Baseline model per metric: rolling 28-day mean with weekday seasonality factors, computed nightly from observations.
- [x] **P2-23** Anomaly rule: deviation beyond k·MAD from the weekday-adjusted baseline for N consecutive days → an anomaly record with the arithmetic shown. Thresholds in code with tests at the boundaries, both directions (drops AND spikes).
- [x] **P2-24** Watching integration: anomalies write `watch_activity` and, when they cross the Session H interrupt thresholds, surface as the interruption the status screen has been promising. The thresholds stop being copy and become code.
- [x] **P2-25** Anomaly telemetry: every anomaly recorded with its baseline inputs, so a false positive can be replayed and the thresholds tuned from evidence — the diagnosis-prompt calibration discipline applied to statistics.

**Done when:** a seeded 20% drop on a weekday fires; a normal weekend dip does not; both assertions are tests.

**Status 2026-09-15:** Done. Both assertions are tests in `lib/anomaly/baseline.test.ts`, with the thresholds pinned at their boundaries in both directions (600 tests passing). The baseline is a 28-day mean with per-weekday factors; a day is beyond at more than 3× the usual variation (MAD-based, floored at 5% of the day's expected value); an anomaly is 2 consecutive beyond days one way. A revenue drop of 30% or more week over week interrupts the watch, as code; the other two interruptions the status screen promises are marked there as not yet checked automatically. Every anomaly stores its baseline inputs, so a false positive can be replayed from the row.

---

## Session F — Trading hours: when the money and the attention come _(planned 2026-10-13, owner idea)_

For businesses customers visit — bars, restaurants, cafés, salons, shops — **when** the business earns matters as much as how much. A bar open 20:00–01:00 should learn whether 20:00 is too early, too late or right, and whether the last hour pays for itself. Deterministic arithmetic on observations, no model calls (CLAUDE.md cost rule). The experiment half lives in `TASKS-PHASE3.md` Session I (P3-41).

**Honest limit, stated up front:** a closed hour records no sales, so the data can only _suggest_ demand before opening. Proof comes from a trial (P3-41) measured by the readback, never from extrapolation alone.

**What exists today, found 2026-10-13:** opening hours are one free-text answer (question 2.1.1.7, priority `deep`, so often never asked); the profile has no timezone; every metric is daily (`METRIC_KEYS` in `lib/connectors/provider.ts`, and `service.test.ts` asserts `revenue.hourly` is refused); and no point-of-sale connector exists, though most bars take cards on a POS, not Stripe.

- [x] **P2-26** Structured hours and their cost. Question 2.1.1.7 becomes a weekly schedule: per weekday an open time, a close time that may cross midnight, or closed. The business timezone and **the cost of one open hour** (staff on shift plus energy, money in minor units, rule 1) are added as questions. Priority rises for visit-based businesses through a `ConditionExpr` (rule 4), not code. Spec, bank and `lint_bank.py` change in the same commit. The support knowledge renderer (P4-05) keeps answering "what are your opening hours?" from the structured value.
- [x] **P2-27** Hourly measurement. `revenue.hourly` and `orders.hourly` join `METRIC_KEYS` deliberately (the refusal test changes in the same commit, with the reason). Buckets are in the business's local time. A **trading-day cutoff** (default 05:00) puts a 20:00–01:00 night into one evening rather than two dates. Derived from the payment and order timestamps Stripe and Shopify already return; hourly rows stay out of daily sums by the existing dimension filter.
- [ ] **P2-28** A point-of-sale connector, read-only: Square first (payments and orders read scopes, the P2-02 scope audit applied unchanged). SumUp, Zettle, Lightspeed and Toast are re-judged after. **Cash is invisible to every connector**, so the owner states a cash share and every hourly finding carries its coverage ("card sales only, about 70% of takings").
- [ ] **P2-29** Attention by hour: GA4 sessions by `dateHour`; Instagram's follower-online-by-hour insight through the existing read scopes (_verify at build_: metric name and availability). Google Business Profile's "popular times" has no official API. It is not scraped, and the screen says so.
- [ ] **P2-30** The trading-hours analysis, as report and watch findings with the arithmetic shown. Built from at least 4 measured weeks per weekday; below that, the finding is `too_early` and says how many weeks remain. Per weekday it produces:
  - a revenue-by-hour curve;
  - **an opening signal:** if the first open hour already runs at a high share of the evening's peak, demand probably starts before the doors open;
  - **a closing signal:** if the last hour's revenue sits below the cost of an open hour for most of the measured weeks, it isn't paying for itself;
  - **an attention signal:** online attention peaking well before opening.

  Thresholds are pinned in code with boundary tests both ways. Signals are per weekday: Friday may want 19:00 while Tuesday is fine at 20:00.

- [ ] **P2-31** Background check on competitors' hours. The existing competitor research (P1-15..21) also extracts stated opening hours from the pages it already reads, inside the same caps, at research confidence 0.5. A page that doesn't state hours gives `unknown`, never a guess. The finding cites them: "3 of the 4 nearby bars found open at 18:00."

**Done when:** a seeded bar with 6 weeks of hourly card sales gets a per-weekday curve, a pinned-threshold opening signal on Fridays and none on Tuesdays, and a closing signal when the last hour falls below the cost of an open hour; every finding states its coverage and its arithmetic; and a business with 3 weeks of data gets `too_early`, not a conclusion.

**Status 2026-10-13:** P2-26 and P2-27 built, P2-30 mostly built. The done-when holds in tests (`lib/hours/hours.test.ts`, 14 tests; Stripe and Shopify hourly tests). It was verified on the dev server with a seeded Budapest bar: the opening signal on Friday and Saturday, none Tuesday to Thursday, Sunday and Monday read as closed. Decisions taken at build, with the owner's go-ahead:

- **P2-26, opening hours.** Amended from "a weekly-schedule input": the owner still answers in their own words, and Haiku parses the answer once into `presence.opening_schedule` (`lib/hours/schedule.ts`). It's the hard-limits pattern (P3-03), so there's no new intake input type, no new table, and existing answers upgrade.
  - Code validates every period. A day with an impossible time goes to `unparsed`, shown and never repaired, and that day stays unknown, not closed.
  - Bank **1.3.0**: 2.1.1.7 is `important` with an example. Its existing `customers_visit` condition already restricts it to visit-based businesses, so no new `ConditionExpr` was needed. New question 2.1.1.7a, `presence.open_hour_cost`.
- **P2-26, timezone.** Amended from "a question": it's derived from `legal.country` when the country has one zone (`lib/hours/timezone.ts`, 43 countries checked against Intl). Multi-zone and unreadable countries are unknown, with the reason, and every hourly figure says so. An owner-stated `presence.timezone` always wins.
  - **Open:** there's no question that asks for it, so a US business has no hourly analysis yet.
- **P2-27, hourly measurement.** Amended to store in **UTC** (`hour_utc`), not local time: an exact instant, so the clock, daylight saving and the 05:00 trading-day cutoff are applied at read, and a timezone learned later needs no re-sync.
  - Stripe and Shopify share one helper (`lib/connectors/hourly.ts`). Only hours with sales are emitted; the daily row says the day was covered.
  - Anomaly detection and every business-wide sum skip hourly rows by the existing dimension filter.
- **P2-30, analysis** (`lib/hours/trading.ts`, `GET /api/hours`, screen `/hours`). Per weekday, from 12 weeks:
  - a revenue curve with hours after midnight numbered 24, 25…;
  - the opening signal (first hour ≥ 60% of the peak);
  - the closing signal (last hour under the cost of an open hour on ≥ 75% of days, with no verdict without the cost);
  - sales outside the stated hours;
  - `too_early` under 4 measured days.

  The coverage line ("card payments through stripe only — cash isn't seen") and the honest limit are on every result.

- **Still open in P2-30:** the attention signal needs P2-29, and the findings aren't yet written into the diagnosis report or the watch. They show on `/hours`.
- **Not started:** P2-28 (Square), P2-29 (attention by hour), P2-31 (competitor hours).

---

## Session G — What customers look for: demand and blindspots _(planned 2026-10-13, owner idea)_

Find what potential customers search for, ask about and check before they buy, then compare it with what the business actually shows them. A **blindspot** is a demand signal with no matching answer on the owner's surfaces. Examples: people search "bar with live music" and the site never mentions the Friday band; the chat is asked about vegan options thirty times and the menu page doesn't say; every nearby competitor shows prices and this business doesn't. All reads, no writes. Fixing a blindspot goes through the queues that already exist: a site change (Phase 3 Session F), a content item, or a knowledge entry (P4-05). Nothing changes on its own.

**What exists today, found 2026-10-13:**

- GA4 reads only sessions by channel (`lib/connectors/providers/ga4.ts`). The page-level evidence `specs/site-audit.md` §3 (Tier 2) promises is not built.
- **The Tier 1 site audit (§2, "walk the path" with screenshots) was specified but never scheduled in any TASKS file.** `lib/site/` holds only Phase 3's change machinery.
- Customer questions are already collected: support tickets and the unanswered-question clusters (P4-06, P4-12).
- Competitor research already reads competitors' pages (P1-15..21).

- [ ] **P2-32** The "what customers check" list as data. For each `business_type`, the things customers check before buying: for a bar, hours, prices, location and parking, photos, events, booking and reviews; for a shop, delivery cost, returns and stock. It goes in the spec and is linted, not hard-coded (rule 4). A deterministic presence check runs it against the owner's site pages, through the existing GET-only fetcher and its SSRF guard (`lib/site/fetch.ts`), and against the profile. Not the full Tier 1 audit: no screenshots, no vision.
- [ ] **P2-33** Google Search Console connector, read-only (`webmasters.readonly`, the P2-02 scope audit unchanged). It gives the real queries the site appeared for, with impressions, clicks and position per query and page. Two signals: **seen but not chosen** (high impressions, low click rate) and **wanted but not found** (queries about something the profile says the business offers, where the site ranks poorly or not at all).
- [ ] **P2-34** GA4, deeper, with the same read-only scope:
  - landing pages and exits per page, which is site-audit Tier 2 at last;
  - the site's own search box terms (`searchTerm`, when the site sends `view_search_results`), since people searching your site for something is the plainest signal there is.
- [ ] **P2-35** Customer questions as demand. Support conversations and ticket clusters (P4-06, P4-12) are counted as demand by topic. They stay content, never instructions (rule 24), and only counts and topics leave the support tables, no customer text or identity (rule 22).
- [ ] **P2-36** Competitor norms. Competitor research also records which P2-32 items each competitor's pages show, inside the existing caps, at research confidence 0.5, `unknown` when not stated. "4 of 5 competitors show prices; you don't."
- [ ] **P2-37** The blindspot finder: demand (P2-33, 34, 35) and norms (P2-36) joined against presence (P2-32), ranked by demand volume, not by severity. Haiku groups queries and questions into topics (one batched call per run, capped; nothing is grouped under a threshold count). The matching and ranking are arithmetic. Each finding names its numbers, sources and coverage, and the queue that would fix it, as report and watch findings. With no connector, it runs on the checklist and competitor norms alone and says so.

**Done when:** for a seeded bar with Search Console, GA4 and support data, the finder reports "searched or asked about, not on your site" with counts and sources; ranks a high-volume blindspot above a low-volume one; reports a competitor norm the business misses; makes no finding for an item the site does show; and states its coverage when a source isn't connected.

**Verify at build:** whether Google Business Profile's reviews and Q&A can be read without the API access application. Until it's known, reviews come only from an owner-uploaded export, never scraped.

---

## Phase 2 status, 2026-09-15

Every buildable task is built and tested against recorded-shape providers: Sessions A to E, 25 tasks, with P2-20 (Google Ads) blocked on Google's approvals by owner decision. **The phase's done-when below is not met**, because it needs real accounts: a Stripe test key, a Shopify development store, a GA4 property and a Meta ad account, plus two weeks of unattended daily sync. Those are the remaining steps, and they are the owner's to schedule.

**Amendment 2026-09-30 (owner decision):** the two-week clock no longer holds Phase 3 Session D's _build_. Phase 2 is judged **good enough to proceed** — not done — once three things are true: a Stripe test-mode restricted key is connected at `/connections`; the twelve-month backfill is verified on the report, with the owner's estimate visible in history beside the measured figure; and the connector-sync cron has fired successfully on its own at least once (a `connector_syncs` row the owner did not trigger). From that point Session D's foundations and Meta connection (D0–D1) may be built. The two-week unattended clock keeps running alongside and **must have completed before the first real publish** (Session D2's done-when). The done-when below is unchanged: a commerce source, the two weeks, and one genuine anomaly are still owed, and the phase is not called done until they land.

## Phase 2 is done when

A business connects Stripe and one commerce source with provably read-only scopes, twelve months backfill, and daily unattended sync for two weeks straight; its report's revenue, orders, spend and per-offer numbers carry "measured" source lines with the owner's original estimates visible in history; the stated-vs-measured deltas render; and one genuine anomaly has been caught, shown with its arithmetic, without a single false alarm on a weekend.

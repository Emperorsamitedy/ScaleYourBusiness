# Peer Benchmark Network: notes for the DPA and DPIA

**Status: a draft for counsel, not a legal opinion.** The v1 build spec §5.5 asks that the
legal basis and the anonymisation method are documented in the DPA, with the aggregation
thresholds stated explicitly, and §9.4 asks for a DPIA of the benchmark subsystem before
launch. This file states what the code does, so counsel can write those documents from facts.
The legal basis below is the one the spec's design assumes; counsel decides it.

## What is processed

- **Contributed:** each business's own figures for one calendar month, measured by the
  business's connected sales, booking and ad systems (`lib/peers/pool.ts`). Nothing an owner
  typed in ever contributes (§5.3; asserted in `lib/peers/cohort.test.ts`).
- **What places a business in a cohort:** its business type (mapped to a NACE code), its
  country, and a revenue band computed from the measured month. Headcount is an input to
  revenue per employee only.
- **No personal data about customers** enters the pool: only business-level monthly totals
  (revenue, order counts, ad spend, appointment counts).
- **Sole traders:** a sole trader's business figures can relate to an identifiable person.
  This is the main point for the DPIA.

## Anonymisation method (`lib/peers/cohort.ts`)

- An aggregate is served only when **at least 7 distinct businesses** are in the cohort AND
  **no single business is more than 25 %** of the cohort's revenue, or of the metric's own
  numerator or denominator (`specs/peer-cohorts-v1.json`, `floor`).
- Below either threshold **nothing** is returned: no number, no rounding, no bucket, no count.
  This is enforced in the query layer, the only code that computes over other businesses.
- What is served is a distribution: p25, p50 and p75, plus the reader's own percentile. No
  member's value, no total and no list of members ever leaves the query layer.
- Cohorts come only from a fixed ladder (NACE 4 → 3 → 2 digit, country → region group,
  revenue band → every band). No caller can pass a list of businesses or a free-form filter.
- A business never appears in its own cohort.
- An extraction-attack test narrows every parameter the query layer allows and asserts that
  no business can be isolated (`lib/peers/cohort.test.ts`).

## Choice, opt-out and erasure

- **Contribution is on by default**, with a one-tap opt-out on the benchmarks screen
  (`lib/peers/consent.ts`). The choice is recorded with who made it and when, and every
  change is kept.
- An opt-out takes effect **on the next read**. Aggregates are computed live, never stored,
  so no historical aggregate keeps an opted-out business (§5.7 requires it within 24 hours).
- A business that opts out **still receives every benchmark**. Nothing is reciprocal (§5.5).
- **Erasure:** the pool is read from the business profiles that exist at the moment of the
  query, so a deleted business is in no aggregate from then on. Its consent rows go with the
  profile (a cascading delete). Nothing is pre-aggregated, so there is no stored historical
  aggregate to recompute or expire (§9.4). What the account-level erasure flow removes besides
  the profile (connections, observations) is for the DPIA to confirm against that flow.

## For counsel to decide

1. The legal basis for default-on contribution. The spec's design assumes legitimate interest
   with an easy opt-out, for statistics that are aggregated and thresholded; confirm or
   replace it.
2. Whether sole traders need a different default, or an explicit notice at sign-up.
3. Whether the thresholds (7 businesses, 25 %) are sufficient, or the DPIA asks for more.
4. The wording of the notice shown at sign-up. The screen states the thresholds today.

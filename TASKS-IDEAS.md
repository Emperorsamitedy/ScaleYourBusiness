# TASKS — Ideas: the business before it exists

**Opened 2026-11-17 by the owner ("build and ship it")**, the same recorded
way as every phase before, with the default answers to the open questions
(D91 in `specs/architecture-v2.md`; D92–D95 are the decisions taken
building it). Part 1, the free idea check at `/idea`, and part 2 — an idea
kept on an account, its test results, the launch and the plan beside the
measured month (D96) — are built, and so is the conversational version: a
description read into the form (I-12), with the bank's own stage fact in
place of a new bank section (I-11, D97).

## What it is

Today ScaleX works on businesses that already trade: it measures them. This
adds the step before: a person with an idea (B2B, B2C, a shop, a service, an
app) answers about fifteen questions, and ScaleX sets their plan against
what the market's own figures say about that kind of business, in that
country, at that size. It returns four things:

1. **The odds for the sector, not the idea.** How many new businesses of
   this kind in this country are still trading after 1, 3 and 5 years
   (Eurostat business demography), labelled with source and year.
2. **The money.** Capital against the plan's own costs; break-even
   customers a month; months of runway before break-even; their margin
   against the sector's typical operating rate (Eurostat SBS, already held).
3. **The riskiest assumption.** The one stated number that, moved to the
   sector's typical value, breaks the plan worst. Chosen by arithmetic.
4. **The cheapest next test.** What to do before spending real money to
   check that assumption, with what counts as pass or fail written down
   before the test runs.

When the business launches, the idea profile becomes the operating profile.
Its stated assumptions become the baseline that real sales are measured
against: "you planned €8k a month; you're doing €5k; this is where it
differs."

## Why

- **Acquisition.** People with ideas outnumber people with businesses, and
  they pick their tools at launch. Meeting them before launch makes ScaleX
  the system they launch on.
- **The handover is the moat.** A business plan tool stops at the plan.
  ScaleX keeps the plan and measures reality against it, which only works
  because the measuring is already built.

## Non-negotiables (rules 36–41)

Every earlier rule still holds; rules 1–8 especially (money in minor units
with currency, no bare values, supersede never overwrite, branching in data,
"I don't know" is an answer).

**36. No verdict on an idea.** ScaleX never says an idea is good, bad,
viable or likely to succeed, and never gives a success probability for
_this_ idea. Survival rates are about the sector, and are always worded so
("of businesses like this in Hungary, 58 % were still trading after three
years"). A failing test proves the rule: no output string matches a verdict
pattern in any locale.

**37. Every idea-stage figure is stated or a labelled base rate.** The
owner's numbers are grade D, "your estimate". Market figures are grade C
with source, table and year. Nothing is grade B or A until it is measured
after launch. Base rates are never blended into the owner's numbers, and
never blended with the peer network (§5.4 holds here too).

**38. The riskiest assumption is arithmetic, not inference.** It is the
input whose move to the sector base rate shrinks break-even headroom most,
computed deterministically and tested at its boundaries. An LLM may phrase
it; it may not choose it.

**39. Recruitment-based schemes are explained, not modelled as a
business.** Where income depends mainly on recruiting others rather than
selling to end customers, ScaleX does not produce break-even figures. It
explains how the commission maths works and that pyramid promotional
schemes are banned across the EU (Unfair Commercial Practices Directive,
Annex I) and points to a lawyer. Legitimate direct selling to end customers
is modelled like any other sales business. The exact wording is checked by
counsel before launch, as with the country matrix.

**40. Nothing is committed on the person's behalf.** No incorporation, no
loan or grant application, no supplier sign-up, no domain purchase. ScaleX
prepares, the person acts. No legal or tax advice beyond naming the question
to take to a professional.

**41. The test is set before it runs.** A validation test records its pass
and fail thresholds before the result exists (the measurement-plan
discipline of §3.1). A result entered afterwards is scored against what was
written, never re-read to fit.

## Not in scope

- Local competitor density — **now built (D98, the owner's choice of
  2026-11-17)**: a dated OpenStreetMap snapshot for each country's largest
  cities, counts shown as floors.
- Countries outside Eurostat's coverage get the money maths but no sector
  base rates, and say so.
- Any write to anything external (CLAUDE.md "Do not build yet" still binds).
- Market-size estimates (TAM/SAM) from web research or an LLM. No source of
  record exists for them; a made-up market size would break rule 37.

---

## Session A — Market data (~12h)

- [x] **I-01** Eurostat business demography snapshot: survival rates at 1, 3
      and 5 years and birth rates, by NACE and country, dated, in
      `specs/business-demography-v1.json`, beside the SBS snapshot and in the
      same shape (source, retrieved, coverage, confidential cells marked).
      The exact table and indicator codes are verified against Eurostat at
      build and written into the file, not assumed here.
- [x] **I-02** Map: idea business type → NACE through the existing
      `benchmark-map-v1.json` (one mapping, not a second).
- [x] **I-03** The served base rate: one function, source and year attached,
      `unavailable` (said in words) for a confidential or missing cell.

**Gate:** every base rate shown carries its table, year and country; a
missing cell says it's missing and is never filled from another country
(a type falls back to its parent group, said so — D92).
**Passed 2026-11-17** (lib/ideas/ideas.test.ts).

## Session B — The idea profile (~16h)

- [x] **I-10** `profile_kind: "idea" | "operating"` in `data-model-v1.md`
      and the schema, in the same commit. An idea profile has no connectors
      and no execution, enforced at the data layer.
- [x] **I-11** The idea section of the question bank, branching in
      `ConditionExpr` data (rule 4), passing `lint_bank.py`. Core questions:
      what is sold; to whom (business, consumer, both); business type;
      country and city; how customers will find it; price; expected
      customers or orders a month; one-off start-up cost lines; monthly fixed
      cost lines; variable cost per sale; capital available; hours the owner
      can give; when they want to launch; experience in this sector; how
      money comes in (one-off, subscription, commission, marketplace,
      recruitment-based). "I don't know" stays a real answer and becomes a
      gap, not a zero (rule 5).
- [x] **I-12** Free-text idea description → structured fields: Haiku,
      extraction only, every extracted field shown back for confirmation
      before it counts.
- [x] **I-13** Words in all seven locales via the glossary (one term, one
      translation).

**Gate:** an idea profile can't open a connector or a proposal; the bank
lints; a skipped cost line is a gap in the report, not a zero.

## Session C — The model (~14h)

- [x] **I-20** Unit economics, pure and in integers: contribution per sale,
      break-even customers a month, monthly burn before break-even, runway
      in months, months to break even at the stated ramp. Every figure with
      `derived_from` and its formula (rule 6).
- [x] **I-21** Against the sector: stated margin vs Eurostat's gross
      operating rate; stated revenue per person vs net turnover per person
      employed, for the matching size class. Shown side by side, never
      merged (rule 37).
- [x] **I-22** The riskiest assumption (rule 38): move each input to its
      sector value where one exists, recompute break-even headroom, rank.
      Inputs with no sector value are ranked by stated uncertainty and
      marked so.
- [x] **I-23** The recruitment-scheme branch (rule 39): no break-even
      output; the explanation instead.

**Gate:** boundary tests both directions on every threshold; the verdict
scan (rule 36) passes in every locale; no float on any money path.
**Passed 2026-11-17** (lib/ideas/ideas.test.ts, components/ideas/render.test.ts).
I-22 as built ranks the estimates only (D94).

## Session D — The cheapest next test (~10h)

- [x] **I-30** A library of validation tests as data
      (`specs/idea-tests-v1.json`), keyed by which assumption is riskiest
      and by customer type: pre-sale, landing-page sign-ups, ten customer
      conversations (with the script), three B2B pilot conversations, a
      waitlist, a price test. Each has its cost, its time and the measured
      signal it produces.
- [x] **I-31** Choosing a test sets its pass and fail thresholds first
      (rule 41), derived from the break-even maths ("you need 1 in 25
      visitors to sign up; under 1 in 60 fails the assumption").
- [x] **I-32** Recording a result: owner-entered (grade D), or measured
      where a connector can see it (a landing page's analytics, grade B).
      The model reruns with the result as a superseding fact (rule 3).

**Gate:** a test can't be scored without thresholds recorded before its
result; a result supersedes the assumption, and the old one is kept.
I-30 and I-31 are built (D95; the price test was dropped with D94). I-32 is
built in part 2: owner-entered results, read against the stored lines,
append-only (lib/ideas/keep.test.ts). A measured result (a landing page's
analytics) waits for that connector to be made after launch.

## Session E — The screens (~16h)

- [x] **I-40** `/idea`: the interview, the report (four parts, in the order
      above), every figure with its grade and source, the riskiest
      assumption first.
- [x] **I-41** A free, no-account short version beside `/check`, the
      existing six-question free check: the same model on fewer inputs,
      labelled as such, shareable by token like `/e/[token]`.
- [x] **I-42** Cost discipline: arithmetic for every number; Haiku for
      extraction; Sonnet only to phrase the computed figures in plain words.
      Target under €0.05 per idea check, logged per call by workload.

**Gate:** the report fits a phone screen; every number on it has a grade
and a source; cost per check logged and under target.
**Passed 2026-11-17** for part 1: `/idea` and its share page `/i/[token]`;
no model is called (D93), so the cost per check is zero. I-40's conversational
interview is part 2.

## Session F — Launch handover (~10h)

- [x] **I-50** "I've launched": the idea profile becomes an operating
      profile. Stated assumptions keep their provenance and are superseded,
      never overwritten, as measured facts arrive.
- [x] **I-51** After 30 measured days: planned vs actual, per assumption,
      the stated-vs-measured delta shown rather than silently swapped
      (Phase 2's rule).
- [x] **I-52** The first connector suggested from what the plan rests on
      (a subscription idea → Stripe first).

**Gate:** a launched profile shows its own plan beside its measured month;
no planned figure is lost or edited.
**Passed 2026-11-17**: revenue, customers (measured orders a month) and price
(the measured average sale) each beside the plan; costs said to be unmeasured;
a subscription's orders not read as subscribers (lib/ideas/keep.test.ts).

---

## Gaps closed (owner, 2026-11-17, D99)

- [x] **G-3** Signing in from "Keep this idea" comes back to the check
- [x] **G-4** A kept idea is named in the business switcher until launch (0125)
- [x] **G-5** A ScaleX-hosted test page that measures interest, no personal data (0127)
- [x] **G-6** Eurostat's newer one-year survival rate, shown on its own line
- [x] **G-7** A town outside the snapshot, queued and counted by the daily job (0126)
- [x] **G-8** Follow-up questions for what a description left out

**Estimate: ~78 hours** across six sessions.

## Open questions for the owner

1. **Price.** Is the full idea check free, part of the €49 diagnosis, or its
   own tier? (The short version in I-41 is free either way.)
2. **Account.** Does the full version need an account (it must, to keep the
   plan for the handover), or can it start anonymous and attach later?
3. **Recruitment-based schemes.** Explain-only as in rule 39, or refuse the
   category outright?
4. **Local competition.** Worth a later phase with a paid map or
   business-register source, or leave it out?
5. **Outside the EU.** Allow ideas outside Eurostat's countries with the
   money maths only, or EU only at launch?

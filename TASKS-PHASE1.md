# TASKS-PHASE1.md — Diagnosis

Commit-sized tasks in strict order. Work top to bottom. Reference the task ID in each commit message.

**Scope: Phase 1 only** — from a validated profile to a diagnosis report a stranger has paid for. That's `build-sequence.md` steps 37–53.

**Estimate: ~210 hours.** At 30 hours a week that's about seven weeks.

**Status: PROVISIONAL.** `TASKS.md` says Phase 1 is written "informed by what the ten intakes taught you, not by what I guessed today." The ten intakes (P0-86) have not run. So this plan is split deliberately:

- **Sessions A–D are safe to build now.** They key off `field_records` and the data model, which P0-88's question rewrites cannot move.
- **Sessions E–G should wait for real profiles.** Prompts tuned against synthetic data are tuned against fiction; the findings and recommendations engines need messy, real answers to be worth anything.
- **Sessions H–I are the business wrapper**, buildable any time but pointless before there is something to sell.

Revisit this file after the tenth intake. Cross out what the owners proved wrong.

---

## Session A — Profile snapshots _(~18h · step 37)_

The foundation everything else references. A report must be reproducible from the exact state that produced it — otherwise "your margin was 23%" becomes unfalsifiable the moment a fact changes.

- [x] **P1-01** `profile_snapshots` table: id, profile_id, taken_at, content_hash, fact_count
- [x] **P1-02** Snapshot writer — freeze every current `field_records` row plus entity spines into an immutable set
- [x] **P1-03** Content addressing: identical facts always produce an identical hash; a single changed value changes it
- [x] **P1-04** Snapshot reader — rebuild the exact profile view a snapshot captured, ignoring everything written since
- [x] **P1-05** Diff two snapshots: what changed, what was added, what was superseded — the input to the watching module
- [x] **P1-06** Tests: byte-for-byte reproduction, hash stability across reorderings, diff correctness

**Done when:** a snapshot ID reproduces a report's inputs byte for byte, and re-snapshotting an unchanged profile yields the same hash.

---

## Session B — Unit economics _(~26h · steps 40–41)_

Arithmetic, not inference. Never an LLM call — CLAUDE.md's cost rule and the auditability requirement point the same way.

- [x] **P1-07** Margin per offer: `(price − cost_to_deliver) / price`, currency-safe, per offer kind
- [x] **P1-08** Blended gross margin, weighted by volume where volume is known
- [x] **P1-09** Break-even: fixed costs ÷ contribution per unit, with the volume assumption stated
- [x] **P1-10** Average order value, monthly order count, revenue per channel where derivable
- [x] **P1-11** Cost per acquisition where ad spend and new-customer count both exist; refuse to guess when either is missing
- [x] **P1-12** Every computed value writes `derived_from` + the formula string (rule 6) — no unexplainable numbers
- [x] **P1-13** Stated-vs-computed handling (§8.3): computed wins for analysis, both shown, contradiction raised, neither overwritten
- [x] **P1-14** Tests: one passing and one failing case per formula; a two-currency profile must refuse to blend

**Done when:** every figure on a report can be traced to its inputs on screen, and a wrong stated margin produces a visible discrepancy rather than a silent correction.

---

## Session C — Competitor research _(~24h · steps 38–39)_

The first write-adjacent external calls in the product. Read-scope only, forever (CLAUDE.md).

- [x] **P1-15** Search + fetch, hard-capped: N results, timeout per page, total budget per profile
- [x] **P1-16** Extract into `Competitor` records — name, URL, price points, positioning — with `source.kind = "web_research"` and confidence 0.5
- [x] **P1-17** Owner-stated and researched facts stay distinguishable everywhere they surface
- [x] **P1-18** Nothing is invented: a field the page didn't support is `unknown`, never a plausible guess
- [x] **P1-19** `researched_at` on every record; staleness feeds the `stale_financials`-style rules
- [x] **P1-20** Honest progress: real steps, real timings, **no artificial delay** — the log shows work completed, not a theatre of it
- [x] **P1-21** Cost logged per research run, tagged by workload
- [x] **P1-21a** Live providers: real web search (Anthropic `web_search` on Haiku, results parsed from tool blocks, never prose) and a real page fetcher (timeout, HTML stripped, public web only)
- [x] **P1-21b** Discovery: `discoverCompetitors` goes from the owner's own facts (1.3/1.4 + country) to 3–5 candidates with URLs — proposes only; the owner's confirmation is what creates a record
- [x] **P1-21c** `delivery_promise` in the extraction and the bank's competitor schema (bank 1.1.0) — what they promise on delivery is a field, not a footnote
- [x] **P1-21d** Routes: `POST /api/research/discover` and `POST /api/research/competitor`, intake-cookie scoped

**Done when:** a profile that has said what it does and where can ask "who competes with me?" and get back 3–5 real candidates with URLs it can confirm; confirming one produces a populated record with real URLs and nothing invented; and the progress log entries correspond to actual completed work.

_(The original "Done when" only covered enriching a competitor the owner had already named — the plan's actual claim, "the agent goes and looks", was P1-21a/b and landed later.)_

---

## Session D — First contact _(~22h · pulled forward from step 50)_

**Why this moved.** Sessions A–C were ordered to build the report. The GATE
needs something else: a stranger has to be able to arrive, understand what
this is, leave halfway through, come back on a different device, and end up
somewhere worth the fifteen minutes. Without that, P0-86 burns real owners
on a dead end. The report can wait; the ten intakes cannot.

- [x] **P1-55** Landing page: what this is, what you get, how long it takes, what happens to their answers
- [x] **P1-56** Email capture at the finish — "where should I send this?", never a password
- [x] **P1-57** Magic-link resume: a signed link reopens _their_ profile on any device, cookie or no cookie
- [x] **P1-58** Resume screen (§ mockup 6): where they left off, how far in they are, one button back in
- [x] **P1-59** Fact sheet wired to real data — every captured fact with its source, from the snapshot
- [x] **P1-60** Gaps view: what's missing and what answering it would buy, each linking back into the intake
- [x] **P1-61** Tests: link signing and expiry, resume across devices, a stranger's whole path end to end

**Done when:** a stranger can arrive cold, stop halfway, return on another device a week later, finish, and see everything they told us with its source.

---

## ⚠ Wait here for the ten intakes

Sessions E–G consume real owner answers. Building them on synthetic profiles risks tuning the system's judgement to a fiction. If P0-86 has not run, stop and go do it — the link is live.

---

## Session E — Findings _(~30h · step 42)_

- [x] **P1-22** `DiagnosisFinding` type: severity, headline, detail, evidence array, snapshot reference
- [x] **P1-23** The findings prompt (`claude-opus-4-8` — "Opus 5" does not exist; the only Opus workload in the product). **PROVISIONAL**: written ahead of the P0-86 gate at the owner's decision; recalibrate against the ten real intakes
- [x] **P1-24** **Evidence is enforced in code, not in the prompt**: a finding whose evidence array is empty or references a non-existent field is rejected, not repaired
- [x] **P1-25** Severity ordering, and the report's three-sentence plain-language summary (§7)
- [x] **P1-26** Findings are never coloured; severity is a mono label (§7)
- [x] **P1-27** Cost + token logging per diagnosis; measured live: €0.067 on an 11-fact dev profile (the €1.78 estimate assumed a full ~200-fact profile — re-measure at P0-86)

**Done when:** no finding can exist without field references, enforced in code, and the summary reads as plain language a non-technical owner recognises.

---

## Session F — Recommendations _(~30h · step 43)_

- [x] **P1-28** `ScenarioBlock`: assumptions, base / downside / upside, break-even condition, sensitivity flags
- [x] **P1-29** The recommendations prompt, constrained to findings that actually exist. **PROVISIONAL** like P1-23: recalibrate at P0-86
- [x] **P1-30** Break-even arithmetic computed in code, never by the model — the model frames it, the code proves it
- [x] **P1-31** High-sensitivity assumptions called out inline (§7): _"this depends heavily on your 22% repeat rate"_
- [x] **P1-32** Reversibility stated on every recommendation — what happens if the owner changes their mind
- [x] **P1-33** Tests: a discount recommendation must state the volume lift required to break even, with the arithmetic shown

**Done when:** a discount recommendation states its break-even condition with the arithmetic visible, and no scenario's numbers come from the model.

---

## Session G — The report screen _(~28h · steps 44–46)_

Design language is settled: `docs/DESIGN.md` + the Phase 1 mockups in `mockups/phase1/`.

- [x] **P1-34** Report route reading a snapshot, not the live profile
- [x] **P1-35** Structure per §7: summary → unit economics → findings → recommendations → what would sharpen this
- [x] **P1-36** Every figure carries its source; an estimate looks different from a connector-sourced number and says so
- [x] **P1-37** Data-gaps section — each gap one click back into the intake question that fills it
- [x] **P1-38** Recommendation responses: "Look into this" / "Not for us", equal visual weight (§8)
- [x] **P1-39** Declining opens an optional reason field, pre-filled with three chips — reasons write to the decision log
- [x] **P1-40** Reads well on a phone; prints cleanly to PDF
- [x] **P1-41** Loading, empty and error states for a report that is still generating or failed

**Done when:** it reads well on a phone, prints cleanly, and clicking a gap opens that question in the intake.

---

## Session H — Mode decision & watching _(~26h · steps 47–48)_

- [x] **P1-42** `ModeDecision` from `ModeDecisionInputs` — deterministic, auditable, not a vibe from a prompt
- [x] **P1-43** Mode decision screen (§5): reasons shown are the actual inputs that triggered it
- [x] **P1-44** Extending the watch is one click; shortening sits behind an acknowledgement
- [x] **P1-45** A low-confidence profile defers the decision instead of guessing
- [x] **P1-46** Weekly snapshot job + diff against the baseline (uses P1-05)
- [x] **P1-47** Watching status screen (§6): honest activity log, thresholds that would trigger an interruption
- [x] **P1-48** Module selection with analytics fixed on, and the UI explaining why

**Done when:** both modes render correctly, every activity entry corresponds to real work performed, and analytics cannot be disabled.

---

## Session I — Money _(~28h · steps 50–52)_

- [x] **P1-49** Signup and auth beyond the intake cookie
- [x] **P1-50** Payment for the one-off report price; a stranger pays and receives a report with nobody touching anything
- [x] **P1-51** Per-account cost telemetry — tokens and euros by workload, so one onboarding's true cost is visible
- [x] **P1-52** Funnel instrumentation: intake start → core complete → report delivered → recommendation responses
- [x] **P1-53** The abandonment point visible in a dashboard (extends the P0-87 telemetry)

**Done when:** a stranger can pay and receive a report without you touching anything, and you can compare a real onboarding's cost against the €1.78 estimate.

---

## ⚠ STOP — Gate 1: does anyone want this?

**P1-54** Sell ten diagnosis reports at full price to businesses you do not personally know.

Friends buying out of kindness is not this task. If ten strangers will not pay, the answer is not "build Phase 2" — it is to work out whether the report is worth paying for, or whether the price, the promise, or the customer is wrong.

---

## Phase 1 is done when

A stranger pays, completes an intake, and receives a report where every figure carries its source, every finding cites the answers it rests on, every recommendation states what would have to be true for it to work — and the owner can tell you, in their own words, what they are going to do differently on Monday.

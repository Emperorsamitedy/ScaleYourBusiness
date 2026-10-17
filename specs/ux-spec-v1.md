# UI/UX Specification — V1

**Scope:** intake → validated profile → mode decision → diagnosis report, plus the approval and notification patterns that later phases inherit.
**Companion:** `intake-mockup.html` is a working prototype of the signature screen described in §4.

---

## 1. The design problem

This product asks a small-business owner to hand over control of the thing that pays their rent. Everything else follows from that.

The interface is not competing for attention or trying to feel exciting. It is trying to make a stressed, non-technical person believe that something careful is paying attention to their business — and to keep them in control while it does. Delight is not the goal; **legibility of intent** is. At any moment the owner should be able to answer three questions without asking: what does it know, what is it about to do, and what will happen if I say no.

That produces one governing rule the whole system obeys:

> **Colour is reserved for decisions.** Nothing in the interface is coloured unless the owner needs to act on it or reconcile it. Everything the system merely knows or has done is rendered in ink and grey.

This is a real constraint, not a stylistic preference. In a product that will eventually surface dozens of proposals, an interface where colour means "your turn" is scannable in a second. An interface where colour means "we thought this was important" trains people to ignore it.

---

## 2. Design tokens

**The sheet system (adopted 2026-10-17, owner decision).** A diagnostic panel / lab report: content lives on eucalyptus paper sheets laid on a dark forest desk. It supersedes Ember Grid. The tokens live in `app/sheet.css`; this section is their source of truth. **Migration is surface by surface**, in this order: (a) the landing page and sample diagnosis (done), (b) the report sheet, (c) the intake, (d) the approval queue, (e) mobile approvals. Screens not yet migrated still render Ember Grid from `app/globals.css`. A screen is either fully on the sheet system or fully on Ember, never a mix.

### Surfaces

| Token | Value | Use |
|---|---|---|
| `--desk` | `#132119` | The background: the receding navigation layer |
| `--masthead` | `#0E1A13` | Ink masthead, with a 2px `--live-rule` (`#3D6BFF`) beneath. The rule is static brand structure, not machine state |
| `--paper` | `#F2F7F4` | The sheet. Content lives here |
| `--inset` | `#DFE9E3` | Evidence boxes and stamps. Only 1.15:1 against paper, so every inset also carries a 1px `--rule` |
| `--rule` / `--rule-soft` | `#71897D` / `#B9CBC1` | 1px rules: structural (3.5:1 on paper) and row hairlines |

Square corners everywhere. No shadows on sheets: separation comes from 1px rules, surface colour and whitespace. No icons: meaning is carried by words, typography, rules and position. Typographic characters such as → are allowed.

### Text and meaning

Every text token is measured on each surface it appears on (WCAG 2 ratio, APCA Lc). Smallest mono labels target Lc 75+.

| Token | Value | On paper | On inset | On desk | Use |
|---|---|---|---|---|---|
| `--sheet-ink` | `#0E1A13` | 16.5:1 · Lc 99 | 14.4:1 · Lc 90 | — | Text on sheets |
| `--sheet-ink-2` | `#3A4C42` | 8.5:1 · Lc 86 | 7.4:1 · Lc 77 | — | Secondary text on sheets |
| `--desk-ink` | `#EAF2ED` | — | — | 14.6:1 · Lc 96 | Text on the desk |
| `--desk-ink-2` | `#C3D4CA` | — | — | 10.8:1 · Lc 76 | Secondary text on the desk. Never a muted grey |
| `--live` | `#1A3DAE` | 8.4:1 · Lc 84 | 7.3:1 · Lc 75 | — | Cobalt: the machine is working right now. Nothing else |
| `--live-desk` | `#C2D4FF` | — | — | 11.2:1 · Lc 79 | The same meaning, on the desk |
| `--ok` | `#145530` | 8.2:1 · Lc 84 | 7.1:1 · Lc 75 | — | Tints IN RANGE |
| `--low` | `#36495F` | 8.5:1 · Lc 86 | 7.4:1 · Lc 77 | — | Tints BELOW RANGE and idle |
| `--drift` | `#683D00` | 8.6:1 · Lc 86 | 7.5:1 · Lc 77 | — | Tints ABOVE RANGE (slightly past) |
| `--alarm` | `#8C1713` | 8.6:1 · Lc 84 | 7.5:1 · Lc 76 | — | Tints ACT NOW. Also underlined, so alarm differs from drift in shape, not only hue |
| `--marker` | `#F7E26B` | — | — | — | Ink was just laid down. Only ever a background behind ink (13.7:1), **never text** |

Colour never carries meaning alone: every status is a worded flag, and the screen must read in grayscale.

**Cobalt is machine state only.** Interactive elements are ink on paper: a full 1px border, a verb label with a typographic arrow ("APPROVE →"), underlined links, an ink-fill inversion on hover and press within 100ms, and a 2px focus ring in the ink of the surface underneath, offset 3px. Never cobalt, never a pill, and at least 48px tall.

### Type

| Role | Face | Use |
|---|---|---|
| Display | Zilla Slab 500–600 | One primary figure or heading per sheet. Never chrome |
| Prose | Archivo | All reading text, 45–90 characters per line (`--measure: 68ch`) |
| Figures and labels | IBM Plex Mono 400–600 | Every figure and every label. Tabular numerals on the figure itself, right-aligned in columns |

The mono layer still encodes something true: every fact prints its source, date and basis as visible text, never behind a click. Caps are reserved for mono labels and flags. Scale: display 64/40/26px, prose 19/16/14px, mono 14/12.5/11.5px. Nothing below 11.5px.

### The number grammar

Every number on every surface follows one grammar, the way a lab result does:

- The value in mono, tabular, right-aligned.
- A named comparison in the column header ("vs prior 28 d"). Never a bare number.
- A reference or goal range where one exists. The owner's own targets may serve.
- A worded flag: IN RANGE / BELOW RANGE / ABOVE RANGE / ACT NOW / NOT PROVIDED.
- For findings, a text-width range bar (`components/sheet/RangeBar.tsx`): the ok band as a tint, the value as an ink tick, and a dashed hairline where drift becomes ACT NOW.
- Forecasts are ranges, never single points.
- Basis is a named class defined by what produced the fact: OBSERVED / DERIVED / ESTIMATED / ASSUMED. Never an AI-generated percentage.
- Money is integer minor units formatted by the currency's exponent (`components/sheet/num.ts`). One column, one decimal count. A space separates number and unit; the unit sits in the column header rather than in every cell.

### Space and motion

Space follows a scale (4, 8, 12, 16, 24, 32, 48, 64, 96px), not a constant. Gutters are 16px under 720px and 32px above.

Motion reports state, and is subtler the more often it plays: 100ms press, 220ms move, 280ms record, decelerating (`cubic-bezier(.16,1,.3,1)`).

- **Kept:** answers flying into the record column.
- **Allowed:** a cobalt pulse only while the AI is genuinely working.
- **Cut:** smooth or inertial scroll, scroll-jacking, cursor tilt, magnetic buttons, ambient drift, decorative loops, confetti, and padded "loading" sequences.
- **Text reveals:** at most one marketing headline, masked as a single text node.
- **Reduced motion:** under `prefers-reduced-motion` every duration is zero.

---

## 3. Screen inventory

| Screen | Purpose | Phase |
|---|---|---|
| Intake | Build the profile, one question at a time | v1 |
| Reconcile | Resolve a contradiction between two answers | v1 |
| Mode decision | Explain instant vs watching, and why | v1 |
| Watching status | Show what's being observed and when it ends | v1 |
| Diagnosis report | The first real deliverable | v1 |
| Profile | Everything known, editable, with sources | v1 |
| Approval queue | Decide on proposals | v2, patterned here |
| Module pages | Marketing, finance, support detail | v3+ |

Navigation is a single persistent left rail on desktop, collapsing to a bottom bar on mobile, with at most five entries. The rail carries exactly one badge — the approval count — because that is the only thing that is ever the owner's turn.

---

## 4. Intake — the signature screen

The layout you described, built and refined. One question in the centre; answered questions settle into two columns either side; the next question rises from below.

```
┌──────────────────────────────────────────────────────────────┐
│ Ledgerline   Setting up your business profile      6 / 12 core│
├──────────────────────────────────────────────────────────────┤
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│                                                              │
│  RECORDED          ┌────────────────────┐         RECORDED   │
│ ┌──────────┐       │ 1.4 · core         │       ┌──────────┐ │
│ │ Business │       │                    │       │ Country? │ │
│ │ name?    │       │ What does the      │       │ Hungary  │ │
│ │ Bellozo  │       │ business sell?     │       │ ● owner  │ │
│ │ ● owner  │       │                    │       └──────────┘ │
│ └──────────┘       │ [Physical] [Serv…] │                    │
│ ┌──────────┐       │ [Software] [Digi…] │                    │
│ │ What does│       │                    │       ┌──────────┐ │
│ │ it do?   │       │ Record answer      │       │ Stage?   │ │
│ │ Fast foo…│       │ I don't know       │       │ Growing  │ │
│ └──────────┘       └────────────────────┘       └──────────┘ │
│                    ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐                     │
│                    │ NEXT               │                     │
│                    │ How many people…   │                     │
│                    └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘                     │
└──────────────────────────────────────────────────────────────┘
```

### 4.1 Why this works, and where I changed your idea

Your instinct is right: one question at a time removes the dread of a 300-field form, and the accumulating columns give a sense of progress that a percentage bar can't. Three changes worth defending:

**The columns are not history, they are the profile being built.** Each settled card carries its mono provenance line. The owner is literally watching the system's knowledge accumulate, with its sourcing visible. This turns a progress indicator into a trust device at no extra cost.

**A next-question preview sits below the centre, dashed and quiet.** Your description had the next question floating up from the bottom, which implies it exists down there. Showing it — muted, one line — removes the sense of an endless queue, because the owner can always see there is exactly one more thing coming. It also lets them mentally prepare, which measurably speeds up answers to longer questions.

**Answered cards are clickable.** Any card can be reopened; the old value stays in history and the change records a reason. Without this, the interaction is a one-way conveyor belt, and the first time an owner mistypes their revenue they'll feel trapped. This is also what makes the data model's superseded-facts design visible.

### 4.2 Interaction detail

**Answering.** Single-selects submit on click after a 130ms confirm beat, so the owner sees their choice register before the card leaves. Multi-selects and text require an explicit "Record answer". Enter submits; Cmd/Ctrl-Enter submits from a textarea.

**Motion sequence,** total ~580ms:
1. Centre card fades and lifts 14px, 240ms.
2. Summary chip appears in the target column, dropping 10px into place with a slight scale-up, 340ms.
3. Next card rises 26px from below into the centre, 380ms.

Columns alternate left, right, left. Chips append downward so the newest sits at the bottom, nearest the eye's return path from the centre.

**"I don't know" is a first-class control**, styled as a visible link rather than hidden in a menu. It writes `status: unknown`, and the chip shows a hollow dot with `gap · will revisit`. This is the interface honouring the schema rule that a gap is a finding, not a failure. An owner who feels forced to guess will guess, and every downstream conclusion inherits that guess.

**Progress reads `6 / 12 core`,** not a percentage. Core count changes as branches open and close, and a percentage that jumps backwards destroys trust. A fraction that grows is honest and legible.

**Validation** is inline and specific: "Answer this, or choose I don't know to move on." It appears under the control, in signal blue, and clears on the next keystroke. Errors never block with a modal and never apologise.

### 4.3 Entity-list questions

The one place a single centred question doesn't work. "List what the business sells" needs a sub-form, not a text field.

The card expands in place into a compact repeating row — name, type, price, cost, monthly volume — with "Add another" beneath. Only `core` sub-fields show initially; a quiet "Add detail" reveals the rest per row. When submitted, the whole list settles into the column as one chip reading `4 products · 3 with costs`, which expands on click.

This keeps the metaphor intact while acknowledging that a catalogue is not a question. It also directly serves the completeness score: an owner can add five products with names and prices in ninety seconds and fill in costs later, rather than abandoning at product two.

### 4.4 Mobile

Columns are structurally impossible below ~900px. Instead: the question fills the screen, and answered items collapse into a single "Recorded (6)" strip pinned below the card, expanding to a list on tap. The settle animation becomes a short downward slide into that strip, so the causation is still visible. Everything else is identical.

### 4.5 Reconcile

When the validator finds a contradiction, both source chips take the ember hairline and a reconcile panel appears below the centre card.

The copy matters more than the layout: **"Help me reconcile these two"** followed by both statements and *"Both can be true — I'd rather ask than assume."* Two actions: "Both are right" (records a confirmation and clears the flag) or "Let me fix one" (returns both questions to the centre in sequence).

This is the tonal high-water mark for the whole product. The system has just caught the owner in an apparent inconsistency, which is exactly the moment a business tool usually makes someone feel stupid. Getting this moment right — curious, not corrective — sets the relationship for everything that follows, including the far more consequential moment when the system disagrees with a decision they've made.

---

## 5. Mode decision

One screen, no interaction beyond acknowledgement, and it must not feel like a loading state.

```
┌──────────────────────────────────────────────┐
│  Six weeks of watching first.                │
│                                              │
│  Your business is operating with real        │
│  customers. Changing things quickly could    │
│  cost you sales, so I'll spend six weeks     │
│  learning how it actually behaves before     │
│  proposing anything.                         │
│                                              │
│  WHY SIX WEEKS                               │
│  ● 2 people working in the business          │
│  ● Ads running on Meta                       │
│  ● ~120 orders per month                     │
│  ● Revenue figures given as estimates        │
│                                              │
│  During this time I'll still send you the    │
│  first read on the business, and I'll ask    │
│  questions as they come up. I just won't     │
│  change anything.                            │
│                                              │
│  [ Start watching ]   Extend to eight weeks  │
└──────────────────────────────────────────────┘
```

Three deliberate choices. The reasons are listed as the actual `ModeDecisionInputs` that triggered the decision, so the owner can see it is a rule rather than an opinion. Extending is one click while shortening is buried in settings behind an explicit acknowledgement, encoding the asymmetry from the data model spec directly into the UI. And the screen states plainly what still happens during watching, because an owner who thinks they've paid for six weeks of nothing will cancel.

For instant mode the same screen inverts: "Starting now," with the reasons that make it safe.

---

## 6. Watching status

The risk of watching mode is that it feels like nothing is happening. The status screen answers "what is it doing right now" with real activity, never fabricated delay.

A vertical log, newest first, in mono: connected sources, observations recorded, questions queued, days remaining. Entries are genuine — *"Read 34 days of Meta ad performance"*, *"Noticed orders drop on Mondays"*, *"Waiting on: supplier lead times"*.

This is where I'd push back hardest on the original brief. You wrote that processes should look like they take hours because instant work doesn't feel like good work. Don't do this. Real research and real data ingestion genuinely take time, and showing honest progress on real work satisfies the same need. Manufactured delay is a bet that the customer never notices — and when they do, it retroactively poisons every honest thing the product has told them. The credibility this interface spends five screens building is not worth trading for a progress bar.

---

## 7. Diagnosis report

The first thing the owner actually paid for. Long-form, readable, and printable.

Structure, top to bottom:

**A plain-language summary** — three sentences, no jargon, stating the single most important thing found.

**Unit economics block** — the numbers, with every figure carrying its mono source line. A margin that came from the owner's estimate looks different from one computed from Stripe data, and it says so.

**Findings**, ordered by severity. Each is a headline, two sentences of detail, and an evidence line listing the specific answers it rests on. Findings are never coloured; severity is shown as a mono label.

**Recommendations**, each with its scenario block: the assumptions stated, the base and downside cases, and the break-even condition. Where an assumption is marked high-sensitivity, it is called out inline — *"this depends heavily on your 22% repeat rate; if that's closer to 10%, the case doesn't hold."*

**What would sharpen this** — the top data gaps, each a one-click link back into the intake. This turns the report's weakest point into its best engagement loop: the owner sees exactly what their honesty would buy them.

Recommendations carry two actions — "Look into this" and "Not for us". Declining opens a short reason field, because that reason is the training data for everything the system proposes later. The field is optional but pre-filled with three common reasons as chips, since a required field here produces junk.

### 7.1 Landing page

The landing page sells the sheet itself (`components/marketing/Landing.tsx`).

- **The hero is a flat, full-width sample diagnosis page** for a fictional store, labelled as one at its top edge. It is not a device mockup. Its arithmetic is held true by `lib/marketing/sample-diagnosis.test.ts`.
- **Copy:** plain hero copy at roughly a sixth-grade reading level, with hard counts ("17 checks across 5 areas"). The counts come from `lib/marketing/checks.ts`, which a test holds to the validation rules, so the page cannot claim more checks than the product runs.
- **The body follows the report's own numbered sections**, set like a table of contents: sample page, what is checked, how the numbers are made, examiner, price, questions.
- **The price on the button is `reportPrice()`**, the same value checkout charges.
- **The "Examined by" block and the refund guarantee** render only once the owner supplies them in `lib/marketing/offer.ts`. The page never prints a stand-in name or an unagreed promise.
- **Never:** a centred gradient hero, an icon feature grid, a "1-2-3 steps" row, a row of big stats without a comparison, or a claim the code does not back.

---

## 8. Approval pattern

Not built in v1, but every v1 screen is designed so this drops in without redesign.

An approval is always: what will happen, why, what it's based on, and what happens if you decline. Two buttons of equal visual weight — approving and declining are both legitimate answers, and an interface that makes "no" feel like the small grey option is manipulating the owner.

Approvals are the only place `--signal` appears at full strength, which is what makes them findable at a glance across the whole product.

---

## 9. Notifications

Your instinct about notification fatigue is correct and it needs an enforced rule, not good intentions.

Three tiers:

**Needs you** — an approval or a blocking question. Push, badge, and it waits. Hard-capped at one push per day; further items batch into the same thread.

**Worth knowing** — a finding, a report, a completed action. In-app only, no push, collected into the three-day digest.

**Everything else** — routine activity. Visible in the log if you look, silent otherwise.

The cap is a product rule, not a preference. If the system ever needs more than one urgent push per day, that is a signal it is proposing too much, and the correct fix is upstream — batching proposals — not more notifications.

---

## 10. Voice

The interface speaks as the system, in first person, plainly. **"I'll watch for six weeks before changing anything"** — not "the analysis period has been set to 6 weeks."

Four rules held everywhere:

- **Say what will happen, in the owner's terms.** "I'll post three videos a day and check what works", not "content cadence optimisation enabled."
- **Never claim certainty the schema doesn't support.** "Based on the estimate you gave" is a sentence this product says often, and it is the reason its confident sentences land.
- **Failures explain and direct.** "I couldn't read your Meta account — the connection expired. Reconnect and I'll pick up where I left off." No apology, no vagueness.
- **Empty states invite.** The profile page before intake reads "Nothing here yet. Twelve questions and I'll have enough to start."

Buttons use the same verb from click to confirmation: "Record answer" produces a card that says recorded; "Start watching" leads to a screen that says watching.

---

## 11. Quality floor

Keyboard operable end to end, with a visible 2px focus ring in the ink of the surface underneath. `aria-live` on the centre stage so screen readers announce each new question. Colour never the sole carrier of meaning: every status is a worded flag, and every surface must read in grayscale. Contrast: every text token reaches WCAG 4.5:1 on each surface it appears on; the measured values are in §2. Reduced motion respected globally. Responsive to 360px with no horizontal page scroll; checked at 1440, 1024 and 390px.

---

## 12. Open questions

1. **Product name.** The mockup uses "Ledgerline" as a placeholder so the topbar isn't empty. Your call entirely.
2. **Intake length before the first report.** The mockup shows 12 core questions; the bank defines 25 always-asked. Twelve is a better first session and the rest can come after the mode decision — but that means the first report is thinner. Worth deciding deliberately.
3. **Does the owner see the confidence score?** I've exposed provenance per fact but kept the overall score internal. Showing it is more honest; it also invites arguing with the number.
4. **Report delivery.** In-app only, or emailed as a PDF? Emailed reports get forwarded to business partners, which is free distribution — but they leave the product, where the actions are.

---

## 13. Next step

The natural next artifact is the diagnosis report as a designed screen rather than a described one, since it's the deliverable the whole v1 is built to produce and the one that has to justify the subscription. After that, the interviewer agent spec — which is the last piece before v1 is fully designed and buildable.

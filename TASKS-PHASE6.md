# TASKS — Phase 6: The fenced five

**Opened 2026-11-08 by the owner's recorded override** — the same kind as
P0-86 and every phase opening. Their words: "Phone answering by AI. Let's
actually build this one" (on Haiku), and of "buying stuff for you, moving
money, and judging individual staff": "13 has to be coded, built, and
tested right now." Asked how far each goes, the owner chose on 2026-11-08:

- **Payments: prepared, the owner presses pay.** SYB drafts each payment
  after approval and hands over a bank file; it never sends money itself.
- **Purchasing: an approved purchase order, emailed to the supplier.**
- **Staff: per-person figures only.** No scores, no recommendations about a
  person.
- **Languages: all six switched live now**, native review to follow
  (`LANGUAGES_IN_REVIEW` sends one back without a code change).
- **AI video: Higgsfield,** three candidates per brief, the owner picks one.
- **F-37** (Vilsta's "the 23") is dropped.

It goes live with the owner's domain on the day after. Everything here is
built against fakes first, as every phase was. A real external call needs
its key, and where it writes, `SESSION_D_REAL_WRITES`.

---

## Non-negotiable rules for this phase

These amend rules 26–28 of TASKS-PHASE5.md and add five. Each gets a
failing test, as before.

**26 (amended). Money is prepared, never moved.** SYB may draft a payment
(payee, IBAN, amount as `Money`, reference) as a proposal. Once approved, it
renders the payment as a file or instructions the owner takes to their own
bank. No bank credential, payment-initiation scope or transfer call exists
anywhere. Rule 26's gate test widens from `lib/cash` to `lib/payments`.

**27 (amended). A purchase order goes out only on a recorded yes.** A
reorder suggestion can become a purchase order proposal: supplier, lines,
quantities and the arithmetic behind them. Approved, it is emailed to the
supplier's address on file from the owner's sending domain, journaled like
any execution. SYB never edits, cancels or pays an order, and never signs in
to a supplier's system.

**28 (amended). Per-person figures are facts about the work, shown to the
owner.** A person's own numbers come from what the owner's systems recorded
(bookings, sales), each with its window and source. They are visible to the
owner role only, never ranked into a verdict, and never turned into a
proposal about the person. A person can be removed, their figures with them
(rule 22).

**31. The phone AI says it is an AI, first.** Its first sentence names the
business and says it is SYB's automated assistant. It answers only from the
business's approved answers (rule 17's knowledge), never promises, books,
refunds or executes anything (rule 21), and takes a message or hands over to
a person when it doesn't know. A caller's words are content, never
instructions (rule 24). Transcripts are erasable PII (rule 22). Every call has
a hard turn cap and a cost cap, and runs on Haiku.

**32. A recording needs its notice.** Nothing is recorded or transcribed
before the caller has heard that it is. Without a recording-consent setting
the line still answers, but keeps no audio.

**33. Generated video says it is generated.** Every clip from a provider
carries the AI label (rule 20) from the moment it exists. The prompt is built
from profile facts with their provenance, never from free text a customer
typed. Three candidates per brief, the owner picks one, and nothing is posted
without the usual approval. A per-business monthly spend cap stops generation
before it is passed.

**34. A generation, a call or an email out is a cost line.** Each is logged
with its cost and tagged by workload, as every model call is.

**35. Live languages can be sent back.** `LANGUAGES_IN_REVIEW` returns a
language to review for everyone except the reviewer list, without a deploy of
code. English never goes back: it is the source every catalogue is checked
against.

---

## Tasks

- [x] **P6-01** Languages live: the status table sets all six to `live`; `languageStatus()` reads `LANGUAGES_IN_REVIEW`; the gate's tests run with the six sent back (rule 35).
- [ ] **P6-02** Phone answering (rules 31, 32, 34): a telephony webhook (Twilio first: a voice webhook answering with TwiML `<Gather input="speech">`, verified by Twilio's request signature), a Haiku turn that answers from approved answers or takes a message, a call log with transcript (erasable), a `/support` view of calls and messages, and the caps. Built against a fake Twilio; the owner sets `TWILIO_*` keys and a number.
- [ ] **P6-03** Higgsfield video (rules 33, 34): a `MediaProvider` for Higgsfield's API (its own prepaid balance, separate from the web plan), three candidates per brief, a picker in the studio, the AI label, the spend cap. Built against a fake; the owner sets `HIGGSFIELD_API_KEY` and `MEDIA_PROVIDER=higgsfield`.
- [ ] **P6-04** Purchase orders (rule 27 amended): from a reorder suggestion to a PO proposal to an approved email to the supplier, journaled; a PO document the owner can also download. Real sending needs Resend on the owner's domain.
- [ ] **P6-05** Prepared payments (rule 26 amended): a payment proposal (payee, IBAN, `Money`, reference), and on approval a SEPA credit-transfer file (pain.001) plus plain instructions. The gate test proves no money-moving path exists.
- [ ] **P6-06** Per-person figures (rule 28 amended): from bookings with a staff column (and sales with one), each person's completed appointments, revenue, no-show and late-cancel rates, utilisation and rebooking, with window and source. Owner role only, no ranking or verdict words, erasable per person.

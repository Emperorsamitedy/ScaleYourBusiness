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
- [x] **P6-02** Phone answering (rules 31, 32, 34): a telephony webhook (Twilio first: a voice webhook answering with TwiML `<Gather input="speech">`, verified by Twilio's request signature), a Haiku turn that answers from approved answers or takes a message, a call log with transcript (erasable), a `/support` view of calls and messages, and the caps. Built against a fake Twilio; the owner sets `TWILIO_*` keys and a number.
  - _Built 2026-11-08:_ `/api/phone/voice` (signed or refused; steps start, turn, message, dial, status) and `lib/phone` (the stranger tier, held by the rule-21 module gate, which now also forbids bookings, payments, cash and the owner desk). The first sentence names the business and SYB's automated assistant; the transcription notice is its own `<Say>` before the first `<Gather>`, stamped `notice_at`, and the database refuses a message without it. One Haiku call per caller turn over the widget's approved answers; an answer is spoken only when it cites one that was offered, else the line takes a message, or puts the caller through to the owner's number when they ask for a person. Caps: twelve turns and €0.03 a call (reserved before each model call), €5 a month, a hundred calls a day per business and five per caller. Speaks the business's language (seven Google voices). Migration 0083 (`phone_settings`, `phone_calls`, `phone_call_turns`); calls erasable from `/support` and with a contact's erasure. No audio is ever kept, so there is no recording-consent setting yet; Twilio's per-minute charge is on the Twilio bill, and the call's cost line carries duration and model cost.
- [x] **P6-03** Higgsfield video (rules 33, 34): a `MediaProvider` for Higgsfield's API (its own prepaid balance, separate from the web plan), three candidates per brief, a picker in the studio, the AI label, the spend cap. Built against a fake; the owner sets `HIGGSFIELD_API_KEY` and `MEDIA_PROVIDER=higgsfield`.
  - Status (2026-11-08): built against a fake HTTP layer, no live call yet. `lib/content/generate/higgsfield.ts` (submit, poll with hard caps, Kling 3.0 Pro text-to-video by default, USD cents at the published $0.112/s), `lib/content/video-prompt.ts` (rule 33: prompts from profile facts with provenance and the brief's hook only), `lib/content/candidates.ts` (three per brief, labelled in the file before storage, a cost line each tagged `ai_video`, the pick placed and offered for publishing, the others kept as `not_chosen`, the pick in the decision log), migration `0087_media_candidates`, the studio's AI video card. What Higgsfield's pages confirmed and didn't: `specs/higgsfield-api-v1.md`. The owner sets `MEDIA_PROVIDER=higgsfield`, `HIGGSFIELD_API_KEY`, `HIGGSFIELD_API_SECRET` (optional `HIGGSFIELD_MONTHLY_CAP_MINOR`, default $60).
- [ ] **P6-04** Purchase orders (rule 27 amended): from a reorder suggestion to a PO proposal to an approved email to the supplier, journaled; a PO document the owner can also download. Real sending needs Resend on the owner's domain.
- [x] **P6-05** Prepared payments (rule 26 amended): a payment proposal (payee, IBAN, `Money`, reference), and on approval a SEPA credit-transfer file (pain.001) plus plain instructions. The gate test proves no money-moving path exists.
      _Status 2026-11-08: built. Migration **0085** (`prepared_payments`, `payer_accounts`). `lib/payments/`: `iban.ts` (country length table + mod-97, BIC, the mask logs and proposals carry), `sepa.ts` (pain.001.001.03, one PmtInf per execution date, CtrlSum from integer minor units, EUR between SEPA IBANs only, refuses anything not approved), `instructions.ts` (plain steps, any currency), `store.ts` (a payment is a `payments`/`prepared_payment` proposal, a note kind the due runner leaves unrouted; "ready for your bank" = approved and not marked paid; "paid in my bank" is the owner's statement, approved → executed, logged as the owner's; the "pay from" details are a stated fact superseded never overwritten, kept out of `field_records` so no IBAN reaches a model prompt; erasure nulls the payee's name, IBAN and BIC and scrubs the name from the proposal). `/payments` (Insights, after Cash flow) and `/api/payments` (+ `/file?format=sepa|steps`). Owner only (`payments.prepare`), approving a payment included. The gate is `lib/payments/fence.test.ts`; SYB's own Stripe Checkout moved to `lib/billing` so `lib/payments` holds no provider call at all. Link to a purchase order is a plain reference until P6-04's table exists. The IBAN length table and the SEPA country list are as remembered, not fetched._
- [x] **P6-06** Per-person figures (rule 28 amended): from bookings with a staff column (and sales with one), each person's completed appointments, revenue, no-show and late-cancel rates, utilisation and rebooking, with window and source. Owner role only, no ranking or verdict words, erasable per person.
  - _Done 2026-11-08:_ `lib/people` (pure `figures.ts`, `service.ts`, `staff-key.ts`), `/api/team/people`, and a separate "People" section under the cover on `/team` (`components/team/PeopleFigures.tsx`); specs/bookings.md §6, ux-spec §3. The staff column was already mapped (every platform, `verified: false`) and stored as `staff_ref`, as was Square's `team_member_id`. Same 28-day window and minimums as the business's measures: rates "too few to say" under 20 due, rebooking under 10 clients (a client back with anyone counts); utilisation only against a capacity the owner states per person (`staff_people`, migration 0086, with who and when). Every figure shows its part and whole, the section its source and window. Owner only: new role actions `people.read` and `people.manage`; a manager or viewer gets the refusal and the section renders nothing. Same per-business team switch, still off by default; the role-level cover is unchanged. Alphabetical, no score, no verdict word (a scan of all seven catalogues), and the module can't reach proposal, watch or execution code (`lib/people/fence.test.ts`). Removing a person clears their name from every appointment and `staff_people`, keeps a keyed hash in `staff_erasures` so a re-import or sync can't write it back, leaves the business's totals unchanged, and logs one erasure entry without the name. **Sales:** no sales source keeps per-sale rows with a staff member, so there are no per-person sales figures, and the screen says so. Demo: Lumen's three stylists, two with stated capacities.

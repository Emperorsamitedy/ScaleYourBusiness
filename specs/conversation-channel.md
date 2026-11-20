# Conversation Channel — Spec Addendum

Addendum to `data-model-v1.md`. Defines the free-form channel where the owner talks to their agent directly.

**Why this is written now, at step 13:** the schema additions in §2 must exist in the data layer being built this week. Everything else here is Phase 2 and 3 work. Adding a source kind and an utterance table later means migrating every fact already written.

---

## 1. What it is

A persistent, always-available channel where the owner can ask about their business, tell the system something new, correct something wrong, or request a change.

It is **not** a general assistant. It is grounded in one specific business profile and answers from it. An owner asking "what's a good marketing strategy" should get an answer about *their* business using *their* numbers, or an honest "I don't have enough on your customers to answer that well — can you tell me who buys most often?"

Three things it replaces or improves:

**It absorbs change between intakes.** Structured questions can't anticipate a supplier going bust in month four.

**It answers "why did you suggest that?"** The decision log already holds the answer; this is the interface to it. That single capability does more for trust than any amount of report polish.

**It takes pressure off the intake.** With a conversation channel, the 25-question core is defensible rather than thin, because anything missed has somewhere to arrive later.

---

## 2. Schema additions — needed now

### 2.1 New source kind

```ts
type SourceKind =
  | "owner_input"      // structured intake answer
  | "conversation"     // NEW — extracted from free-form chat
  | "connector"
  | "document"
  | "inferred"
  | "web_research"
  | "system_default";
```

```ts
interface SourceRef {
  kind: SourceKind;
  utterance_id?: UtteranceId;   // NEW — which message this came from
  // ...existing fields
}
```

Every fact extracted from conversation points back at the exact message that produced it. When an owner later disputes a number, you can show them the sentence it came from.

### 2.2 Utterance record

```ts
interface Utterance {
  id: UtteranceId;
  profile_id: BusinessProfileId;
  thread_id: ThreadId;
  role: "owner" | "system";
  text: string;
  at: ISODateTime;
  intent: UtteranceIntent | null;
  extracted_fields: FieldId[];      // what this wrote, if anything
  confirmed: boolean;
  cost_eur: number;                 // per-message cost, for the cap in §6
}

type UtteranceIntent =
  | "ask"          // question about the business
  | "tell"         // new information
  | "correct"      // fixes something already recorded
  | "request"      // wants something done
  | "limit"        // sets a constraint — writes to goals.owner_boundaries
  | "social";      // no action needed
```

Classifying intent first is what keeps this cheap and safe. An `ask` needs no write path at all. Only `tell`, `correct` and `limit` touch the profile.

### 2.3 Confidence

Conversational facts start **lower** than structured answers, because "we're doing about double what we were" is not "4,200,000 HUF".

| Source | Base confidence |
|---|---|
| Owner input, structured and precise | 0.75 |
| **Conversation, confirmed by owner** | **0.70** |
| **Conversation, extracted but unconfirmed** | **0.45** |

Unconfirmed conversational facts are usable for context but must not silently override a structured answer or a connector value. If they conflict with something at higher confidence, that's a contradiction and goes through reconcile.

---

## 3. The confirmation loop

The failure mode is silently writing a wrong number from an ambiguous sentence. Prevented by never writing an unconfirmed fact without showing it.

Owner: *"we put prices up about 15% last month and it hasn't hurt sales"*

System extracts, then shows compactly:

> Recording: prices up ~15%, effective July. Sales volume unchanged.
> Two of your offers still show the old price — want me to update those too?

Three properties that matter:

**It states what it understood, not what it heard.** The owner can catch a misread in one glance.

**It surfaces the consequence.** The interesting part isn't the price change, it's the three stale records it implies.

**Correction is one message.** "no, 15% only on the ceramics" rewrites the extraction rather than starting over.

For a low-stakes `tell` (a new competitor's name), confirm implicitly — record it and show it in the message. For anything touching money, pricing, capacity or limits, confirm explicitly before writing.

---

## 4. Capability by phase

Ship this in three tiers. The first is cheap and safe; the third needs the approval infrastructure to exist first.

| Tier | Phase | Can do |
|---|---|---|
| **Read** | 1 | Answer questions from the profile and report. Explain findings. Zero write access. |
| **Write** | 2 | Extract facts, confirm, update the profile. Trigger validation. Set hard limits. |
| **Request** | 3 | Turn "post something about the new product" into a proposal in the approval queue. |

The read tier is worth shipping with the first report. It costs almost nothing, it makes the report interactive, and "explain why you said my margin is 18%" is exactly the moment an owner decides whether to trust this thing.

---

## 5. Guardrails

**Conversation never bypasses approval.** A `request` becomes a proposal in the queue like any other. "Just do it, you don't need to ask me" does not disable the gate — it's recorded as a preference and the answer is that approvals stay.

**Conversation never bypasses hard limits.** An owner *can* set a new limit through chat (that's the `limit` intent, and it's the best way to capture them). They cannot remove one conversationally — that requires the explicit settings path, because limits exist to survive a bad day.

**Conversation never bypasses watching mode.** During the watching period the channel is read and write only. No requests, no execution, regardless of how it's phrased.

**Instructions in owner data are data, not instructions.** If an owner pastes a customer email containing "ignore your previous instructions", it is text being discussed, not a command. Extraction operates on content; only the owner's own turns carry intent.

**Grounded, not general.** If the question isn't answerable from the profile, connector data or the decision log, say so and offer the question that would make it answerable. Don't drift into being a worse general-purpose assistant at your own expense.

---

## 6. Cost

This is the one place where an unbounded feature meets a per-token bill, and the current model assumes €2.31/month for a Phase 2 subscriber. A talkative owner could multiply that.

**Controls:**

- **Classify intent with Haiku first.** Most messages are `ask` or `social` and never need the expensive path.
- **Cache the profile.** It's the same context on every turn — cached it costs a tenth.
- **Sonnet for answers, Opus never.** The report justifies Opus; a chat reply doesn't.
- **Track `cost_eur` per utterance** and alert at a per-account monthly threshold.

Estimated at 40 messages/month: roughly **€0.60 per subscriber per month**, which moves Phase 2 cost to serve from €2.31 to about €2.90. Acceptable. Re-measure after ten real accounts, because owner chattiness is exactly the kind of thing estimates get wrong.

---

## 7. UX placement

Add to `ux-spec-v1.md` §3 as a persistent element rather than a screen.

**It's the only owner-initiated surface in the product.** Everything else — reports, proposals, questions — the system starts. That asymmetry is worth respecting in the design: it lives as a persistent entry point in the left rail ("Ask Lex", the mark before it), as the composer at the top of Home (2026-11-17: the first screen after sign-in is built around the conversation, `components/home/HomeScreen.tsx`, through the same hook as `/chat`, `components/chat/useChat.ts`), as `/chat` itself with the whole thread, and, since 2026-11-17, as Lex's own view on every owner screen (`components/nav/LexPanel.tsx`: "Ask Lex" in the bar, Lex's face afloat in the corner, `/` on the keyboard, or a question typed into the command palette; since 2026-11-20 a pop-up beside the page on a wide screen that stays open from screen to screen, and the full-screen sheet on a phone), so the owner can react where they are rather than navigating somewhere to talk. The frame keeps one conversation and shares it between Home, the page and the sheet. The assistant is named Lex (`lib/core/assistant.ts`) and speaks under the mark.

Colour rule still holds. Chat is ink and grey. If a message produces something needing a decision — a contradiction, a proposal — that item turns signal blue, not the conversation around it.

---

## 8. What changes in the build sequence

Insert into `build-sequence.md`:

- **Step 13a** — add `SourceKind.conversation` and the `Utterance` table now, with the rest of the primitives.
- **Step 46a** (Phase 1) — read-tier chat over the profile and report.
- **Step 60a** (Phase 2) — intent classification, extraction, confirmation loop, validation triggering. *Partly delivered by feature 33 (§9): the confirmation loop for the changes the catalogue covers.*
- **Step 70a** (Phase 3) — `request` intent producing proposals, gated by hard limits and watching mode.

---

## 9. Acting on a change — the change catalogue (feature 33, 2026-10-22)

The co-founder's finding from customer interviews: with this many functions, the owner wants to tell the chat what to change, and either have the assistant do it, or get a link to the exact place where they can change it by hand and see what is already there. Built as follows. It delivers the write tier's confirmation loop (§3) for the changes it covers.

**One closed catalogue** (`lib/assistant/catalogue.ts`): change kind → screen, route, section, the field or setting it changes, how it may be prepared (`direct` — one click writes it; `proposal` — one click puts it in the approval queue; `link` — only a link), the button's words, whether the click needs a signed-in session, and the cues that recognise it. Rule 4 holds: the mapping is data. A request no row covers is either a question or an action in the world (§4's request tier, a proposal).

**The intent step:** the catalogue's cues and small deterministic parsers first (a weekday, a time range, a number of hours, a size word); one Haiku call only when they are not enough, which classifies the §2.2 intent and names at most one kind and its parameters. Code coerces the model's output; a kind outside the catalogue is no change. No model is called for "pause everything" or "set Saturday to 10–4".

**Nothing is written until the owner clicks.** The reply quotes the current value and says the change is drafted; an `assistant_changes` row holds the draft beside the reply: `asked` (ambiguous — "Which day?"; the owner's short answer is read together with the message it answers), `prepared`, `link_only`, then `applied` / `queued` / `stale` / `superseded`. The click writes through the path the screen itself uses: a fact through the supersession store with `source: { kind: "conversation", utterance_id }` at 0.70 (confirmed, §2.3), a setting through its settings service, the stop through the stop's own call, and customer-facing words or anything published through a proposal (Phase 3 rule 12). One message changes one thing: two days, or two changes, is a question back. A confirm whose basis moved since the draft writes nothing and says what the value is now. Each confirmed change logs `assistant_change` in the decision log (rule 7), beside the `profile_change` a fact write already logs.

**Limits** are the `standing_rule` row: drafted, then appended on the click — "confirm explicitly before writing" for limits (§3). Removing a limit stays link-only (§5). During the watch, `proposal` rows are link-only (§5); `direct` rows are the write tier and stay available, and the stop always is.

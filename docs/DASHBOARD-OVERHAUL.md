# The owner app overhaul: the working list

Started 2026-11-17 on the owner's instruction, and corrected by him the same day. This file is the rigorous list he asked for; items are done one at a time and ticked only after they have been used in the browser at desktop and phone width.

## What the owner asked for

- The dashboard is "nowhere near as good" as Foundable's or Secuno's, and he then said what he meant: **not the looks**. "I just wanted you to improve the technicality of it and sort of make it interactive."
- The theme stays **similar to the landing page**. No tiles on the dashboard and no generated imagery as a background.
- Text is small and plain: "very small descriptor text is fine with not a lot of jazz". His example of what must go: the microphone's privacy sentence.
- Graphs are welcome when they are few, uncrowded and as simple as possible.
- The yes may happen inside the conversation, as long as it stays an Approve.

So the look stays the sheet system as it is (`specs/ux-spec-v1.md` §2: the dark forest desk, paper sheets, 1px rules, slab headings, mono labels, cobalt for "the machine is working", the yellow marker for "ink just laid down"). What changes is how much the app _does_ under the owner's hands.

## What was studied

- **Foundable's demo video (28 frames).** What makes it feel alive is not its styling: the assistant's status is always visible with one Stop button; an activity feed ticks as work happens; "Needs your OK" is reviewed and answered in place, without leaving the page; tabs separate activity, what was made and runs; suggested tasks are one click; charts carry a period switch; a message box is always one click away.
- **Secuno (`DESIGN-SYSTEM.md`, `docs/ui-patterns.md`, read only).** A global search on Ctrl+K; notifications with a count; stat cards that are buttons; a rail that never loses your place; shared primitives (modal with focus trap, toasts, empty states) instead of one-off code; "a card that renders nothing when its data is absent looks like a missing feature"; "an empty state must not assert".
- **ScaleX as it stood.** Every card is a dead end: text, then a link to another page. Nothing refreshes unless the page reloads. A decision can be answered on Home, but not read there. The conversation exists on one page only. There is no search, no shortcut, no notice of anything new.

Legend: `[ ]` open · `[x]` done and used in the browser · `[~]` done in part, the note says what is left · `[later]` parked on purpose, with the reason.

## A. Shared interactive pieces (`components/ui/`)

- [x] A1. One side sheet (`Sheet`): slides in over a scrim, traps focus, closes on Escape or the scrim, gives focus back, locks the page scroll, is full-screen on a phone. The Why sheet runs on it.
- [x] A2. Toasts (`ToastProvider`, `useToast`): a polite live region; a recorded action says so in one line; five seconds, paused while pointed at; three at most; an optional single action.
- [x] A3. Tabs (`Tabs`): arrow keys move, the open tab is the only tab stop, counts beside labels, the choice kept in the address (`?tab=`).
- [x] A4. A menu (`Menu`): opens under its button, closes on Escape or a click outside, arrow keys move through it, the button says whether it is open.
- [x] A5. Skeletons while a card reads; never a spinner over the page.
- [x] A6. Icon buttons always carry a name; icons (`lucide-react`) appear only on controls that would otherwise need a sentence: search, notifications, close, the microphone, expand.

## B. The shell (every owner screen)

- [x] B1. A command palette on Ctrl+K (and a search button): jump to any screen the menu holds, run the few global actions (ask Lex, switch business, sign out, show shortcuts), or type a question and send it to Lex. Arrow keys, Enter, Escape. Recent screens first when the box is empty.
- [x] B2. Lex everywhere: "Ask Lex" opens the conversation as a side sheet on any screen, with the same thread, composer, change cards and decisions as the conversation page. On Home it focuses Home's own composer. On a phone it is a button above the dock.
- [x] B3. Notifications: a bell with a count; its menu lists what needs the owner (decisions waiting, connections paused, support tickets open), each a link.
- [x] B4. Counts stay live: the menu's counts refresh every minute while the tab is visible and when the window regains focus, and at once after a decision.
- [x] B5. Keyboard: `/` asks Lex, `g` then a letter goes to a main screen, `?` lists the shortcuts, Escape closes whatever is open. Nothing fires while typing in a field.
- [x] B6. The strip's tabs sit in one row that scrolls sideways with the open tab in view, instead of wrapping into two rows.
- [x] B7. A thin cobalt bar at the top while the next screen loads.

## C. Home as a workspace

- [x] C1. Reads that behave: what was read last shows at once on return and refreshes behind it; reads repeat while the tab is visible; a failed read shows one sentence and a Retry button instead of a missing card.
- [x] C2. Lex's status card: one line that is always true (stopped, watching day N of M, or working with approvals) and "Read now", which reads every connection again and says what it read. The emergency stop stays in the strip, the same place on every screen (review, round 1).
- [x] C3. Side tabs: **Needs you** (with its count), **Activity**, **Made**.
- [x] C4. Needs you: each decision can be answered in place (two equal buttons, a reason on decline) or opened for a full read; paused connections and a tight cash week sit in the same list; when nothing waits it says so and offers the next steps.
- [x] C5. The review sheet: a decision opened in place, with what changes, what is expected, the worst case, how to undo it, what it was checked against, then Approve and Decline. The address carries it (`?review=`), so Back closes it and a link opens it.
- [x] C6. Activity: one live feed of what Lex read, noticed, drafted and ran and what the owner answered, newest first, with relative times; a row opens to its detail; new rows arrive on their own and are marked for a moment.
- [x] C7. Made: everything Lex drafted, each with a one-line preview of the thing itself and its state; a row opens the review sheet.
- [~] C8. Next steps: up to three suggestions worked out from what is already known (nothing connected, no buffer stated, no goal set, a report unread), each one click. _Built and under test; not yet seen in the browser, because the demo business has no gap to suggest._
- [x] C9. The composer: three suggestion chips that ask the question; `/` puts the cursor in it.
- [~] C10. A request that became a proposal is answered or opened right under Lex's reply. _Seen in Lex’s sheet and on the conversation page with the model’s reply stood in for in the browser; not seen on Home itself, because the local model key is invalid._
- [x] C11. Readings are buttons: the whole tile opens its working-out or its screen.
- [x] C12. "Your sales" has a period switch (7, 30 or 90 days, as far as the measured days reach), remembered between visits.
- [x] C13. A decision answered here updates the count, the lists and the menu at once, and a toast says it was recorded.
- [x] C14. On a phone: the tabs and their lists come straight after the composer; the review sheet and Lex's sheet are full-screen.

## D. The conversation page

- [x] D1. A request that became a proposal is answered in place there too, not behind a link.
- [x] D2. The same three chips when the thread is empty.

## E. Speaking

- [x] E1. No first-press notice: one press listens. The privacy page keeps the sentence (`legal.privacy.speaking`). Code, tests, the seven catalogues and the spec agree.
- [x] E2. Inside a composer the microphone is an icon button; "Listening…" is the only line while it listens; each failure is one short sentence.

## F. Words

- [x] F1. Home, the conversation and the microphone say less: no paragraph under a composer, no instruction a button already gives, no dash where a full stop does.
- [x] F2. New pieces carry no arrow glyphs; buttons say one or two words.
- [x] F3. Every new sentence exists in seven languages in each language's formal register (the glossary's), and the strings added on 2026-11-17 that slipped into the informal register are corrected.

## G. Access

- [x] G1. Every overlay traps focus and returns it; every live change is announced politely; every new control works from the keyboard.
- [x] G2. Touch targets are 40px or more on a phone.

## H. Tests and the record

- [x] H1. Pure logic is under test with a passing and a failing case: the palette's filter, the shortcut keys, what needs attention, the read policy, the activity merge, the next steps, the microphone session.
- [x] H2. The catalogue test passes in seven languages.
- [x] H3. `specs/ux-spec-v1.md` says what the app now does: §2 (icons on controls), §3 (the shell's palette, Lex's sheet, the bell, shortcuts; Home's tabs, review sheet, activity, next steps), §8 (the review sheet), §4.2 and §10 (speaking); `specs/conversation-channel.md` §7 (Lex on every screen).
- [x] H4. `docs/DESIGN-DASHBOARD.md` lists the shared interactive pieces and the rules for using them.

## The independent review, round 1 (2026-11-18)

An evaluator on another model read the captures against the owner's words and Foundable's frames, and returned "needs revision": the direction is right and it feels alive, with a short list of interaction defects. What was done about each:

- [x] R1. The command palette has its own close button (a phone has no Escape and no scrim).
- [x] R2. "Needs you" has one definition, shared by the bell and Home's tab (`components/nav/attention.ts`): decisions waiting, connections paused, support tickets open. The cash week is a warning in the list and is not counted.
- [x] R3. One emergency stop per screen. It stays in the strip everywhere; Home's status card reports the stopped state and carries no second button.
- [x] R4. The rail's head and foot are pinned and only its groups scroll, so "Ask Lex" is always in reach.
- [x] R5. Home says each thing once: the waiting and watching tiles left the readings.
- [x] R6. The review sheet says less: nothing under "What changes" when the title is the change; an estimate in whole units; "Why not?" without "one tap is enough"; a tall decline panel scrolls in the sheet's foot.
- [x] R7. Toasts sit at the foot of the page's own column, never over the side column; a card answered in the list shows its own receipt and only the sheet's answer is toasted.
- [x] R8. The shortcuts sheet lists the queue's keys under the queue's own name.
- [x] R9. A phone's header is two rows: search and the bell on the wordmark's row, the tabs with the stop. The chips' row fades at its right edge.
- [x] R10. Smaller: one link style ("Read now" like the others); "Open" wherever a decision is opened; the status card keeps its height; the feed shows eight rows first; the palette lists places before actions; the rail's watching line stays on one line.
- [later] A paused measurement connection (Google Analytics) is said on Home's live line but not counted: the menu's counts know only write connections that paused themselves. It needs one more count in `/api/nav`.
- [later] A failed reply from Lex has no "Try again".
- [later] In Lex's sheet and on the conversation page "Open" still goes to the decision's own page; a sheet over a sheet was not attempted.
- [later] The note under Approve ("With no set time, it doesn't run by itself") is the queue's own sentence and reads unclear out of context; it wants a rewrite in seven languages.

## Later rounds (parked on purpose)

- [later] The rail folding to icons, with an icon per screen. The palette and shortcuts cover fast movement first.
- [later] A Home the owner can rearrange or trim.
- [later] The same treatment screen by screen, where a list or a table would gain from it: the queue (already keyboard-driven), Watching (a signal opened in place), the fact sheet (search and filter), Connections (a read's progress shown live), Customers and Support (rows opened in place), History (filters).
- [later] The sign-up reel's screenshots and the landing page's drawn screens, once the owner has seen the app.

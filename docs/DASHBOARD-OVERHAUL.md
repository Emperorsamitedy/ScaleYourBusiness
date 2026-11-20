# The owner app overhaul: the working list

Started 2026-11-17 on the owner's instruction, and corrected by him the same day. This file is the rigorous list he asked for; items are done one at a time and ticked only after they have been used in the browser at desktop and phone width.

## What the owner asked for

- The dashboard is "nowhere near as good" as Foundable's or Secuno's, and he then said what he meant: **not the looks**. "I just wanted you to improve the technicality of it and sort of make it interactive."
- The theme stays **similar to the landing page**. No tiles on the dashboard and no generated imagery as a background.
- Text is small and plain: "very small descriptor text is fine with not a lot of jazz". His example of what must go: the microphone's privacy sentence.
- Graphs are welcome when they are few, uncrowded and as simple as possible.
- The yes may happen inside the conversation, as long as it stays an Approve.

So the look stays the sheet system as it is (`specs/ux-spec-v1.md` §2: the dark forest desk, paper sheets, 1px rules, slab headings, mono labels, cobalt for "the machine is working", the yellow marker for "ink just laid down"). What changes is how much the app _does_ under the owner's hands.

**Amended 2026-11-18.** After seeing the interactive pass the owner opened the look as well: see "The owner's third round" below. The theme and the identity stay; the type, the navigation and the presentation are being reshaped, from mockups he picks.

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

## The independent review, round 2 (2026-11-18)

The same evaluator read the fixes and returned "pass": all of round 1 confirmed, with small leftovers. What was done about each:

- [x] S1. On a phone the strip's stop says one word ("Stop", seven languages), so the open tab's neighbours show and the row reads as a row that scrolls. The queue's own masthead keeps the full name.
- [x] S2. While a decline's reasons are open, the note about approving is not shown.
- [x] S3. One link style inside a sheet: "See the whole queue" and "Open the full conversation" are the app's mono links.
- [x] S4. The status card ends closer to its last line (one line stays reserved for what "Read now" read, so the card never jumps).
- [x] S5. The rail's groups fade at the pinned foot where there is more to scroll to.
- [x] S6. The conversation page names its box once: the sheet's title says it and the label is only spoken.
- [x] S7. Found while checking, not by the review: the queue and the conversation still printed an estimate to the cent while Home and the sheet rounded it. One function words the range now (`rangeWords`, `components/proposals/queue-model.ts`), used by all four.
- [later] On a phone, a group with one screen (Home) still gives the strip's row to the stop alone.
- [later] Activity's "Checked" rows are many and alike; they want grouping by day or by connection.
- [later] "Cash today" beside a higher "Lowest point ahead" is correct (the lowest point is the lowest of the weeks ahead, and today is not one of them) but reads oddly when today is the low; the tile wants a second look at its words.

## The owner's third round (2026-11-18): the look, from mockups he picks

What he said after using the app, in his words where they matter:

- The results "aren't too bad" and the technical side was learned, but it is "nowhere near where I want it to be just yet".
- It "almost should kinda resemble Foundable's UI/UX but in our own unique ways on buttons and animations and transitions and hover effects and coloring and fonts". Foundable is the closest competitor. "I don't absolutely want ScaleX to be similar to that. I just want us to have our own identity preserved but reshaped in a way that is more appealing just as much as Foundable's."
- Secuno is a different project for a different purpose: its technique was worth learning, its look is not the target.
- How to work: "step by step". The font first. Then mockups made with Claude's design feature that "retain our current identity in terms of overall theme and a bit of fonts", so there is "some sort of set expectation to be followed". The UI and UX design is finalised first, then everything else.

The list. Nothing here is ticked until he has seen it.

- [x] L1. **The font.** "Reformed into something a bit more simplistic", as on Foundable's video: one plain sans, sentence case, calm weights. He saw it and said it was what he wanted: see "L1, as built" below.
- [x] L2. **Mockups to pick from.** Published on 2026-11-18. His pick, the same day: Home is "a mix between A and B" ("you can discard C"); for Lex's face "I like none of them", it should have "an almost 3D feel", and "I trust you on what to pick and how to design that"; yes to the four points of the navigation. He would rather say what he wants here than brief Claude Desktop. The pick is the expectation every later item is built to.
- [~] L3. **Navigation.** Built and waiting for his look: see "L3 to L6, as built" below.
  - [~] a. The rail's contents are "a bit messy here and there".
  - [~] b. Some of it can sit at the top, "up to 4 max just as on Foundable's".
  - [~] c. A clear way back. The queue and the report were focused views with their own masthead and no rail: they filled the screen and "there's no clear way to go back", which "confuses the user's eye".
  - [~] d. The rail expands and retracts, and every item has its own icon.
  - [~] e. The tabs across the top of a screen are "not bad": tidy them the same way, and never let the top navigation and those tabs overlap or say the same thing twice.
- [~] L4. **Lex.**
  - [~] a. A face, as Foundable's Ted has one. Ours, not theirs. Built: see below.
  - [~] b. A side panel for now (Lex's sheet, opened from "Ask Lex" on every screen and from the face on a phone). [later] An interactive pop-up, and present in more places than one.
- [~] L5. **The microphone.** He sees no browser pop-up when he presses it. Found and fixed: see below. A blocked or missing microphone was already said on the screen (`lib/voice/session.ts`).
- [~] L6. **Less to read at once.** Cash flow is built (see below); the other screens follow. "There's still a lot of text on some pages like the cash flow", and "a few overlaps here and there". The content may stay ("I absolutely don't mind you keeping it") but "no one will probably sit down and read that much text": present it "as concise and accurate and small as possible". Cash flow first, then screen by screen.
- [~] L7. **No long dashes.** Built for everything a screen prints: see "L7, as built" below. "No em and en dashes throughout the app"; underscores "only to a very certain limit". This reaches the seven catalogues and the range's wording ("+€136 – +€1,213" becomes "+€136 to +€1,213").
- [~] L8. **Straight into the app.** Built on the branch `straight-in` and waiting for his look: see "L8, as built" below. After signing in or signing up a person lands in the app, with no interview first. The dashboard reminds them to do it, and Lex offers to do it in conversation for those who would rather talk (the conversation is already a fact source: `specs/conversation-channel.md`).
- [ ] L9. **What was already left for later** in this file (the two review rounds and "Later rounds") stays on the list behind these.

Order: L1, L2, his pick, then L3, L4 and L6 built to the pick, then L7, L5, L8, then L9.

### L8, as built (2026-11-19 and 20, branch `straight-in`)

"After signing in or signing up a person lands in the app, with no interview first."

- **A sign-in makes the business.** A proven sign-in (the emailed link, its code, or Google, Microsoft and Apple) gives an account that has no business an empty one, in its shadow month from that moment (the v1 spec §4.2), and lands on Home. Signing in again finds the same business; two sign-ins at the same moment make one (the database's unique account, and an insert that gives way).
- **The one sign-in that makes none** is on its way to an idea check (`isIdeaReturn` of the return cookie): keeping an idea makes its own business, so an empty operating one beside it would be clutter. That person goes back to the check, which a new person never reached before (TASKS-IDEAS G-3).
- **Home says it.** For a business with no facts yet, Lex's headline reads "I don't know your business yet.", one line says what the interview is for and how long it takes, and one button starts it. It is offered once on the screen: the list of next steps does not repeat it, and the three suggested questions wait until there is something to answer them from.
- **Lex offers it in conversation.** On the chat page and in the Ask Lex sheet, where the suggested questions would be, the same words and the same button (`components/chat/InterviewOffer.tsx`). The interview itself held inside the conversation is the later step.
- **Adding a business** lands on Home too, and "interview started" is counted when the interview is first opened, once per business, not when the business is made.
- **Held by tests**: where a sign-in lands (`lib/auth/landing.test.ts`), a new person's own business and its shadow month, the idea exception, and a stranger never landing in someone else's business (`switch`, `access`, `service`, `oauth` against the database).
- **Seen in a browser** with a brand-new address: the sign-in lands on Home, Home and both conversations make the offer, and the button opens the interview.
- **Where it lives.** Completing a sign-in (spending the link or the code, and the first business) is its own module, `lib/auth/sign-in.ts`, which only the three routes that complete a sign-in import. `lib/auth/service.ts` reads the session for every route in the app, so it must not pull in the intake and the ladder: the first version did, and the guard on the push send path (`lib/push/no-connector.test.ts`: it reaches no connector and no execution code) failed on GitHub for it on 2026-11-20. That run was read only after the branch had been called ready: a branch is checked when its whole run is green, not its type check.
- It changes what a sign-in does on the live site (a business is made at once), so it sits on its own branch on top of `dashboard-v2` and is merged after it.

### L7, as built (2026-11-18)

"No em and en dashes throughout the app", and the range's wording.

- **The seven catalogues.** About 2,900 strings were rewritten. English was decided string by string (419 of them): a full stop where a new sentence starts ("I couldn't reach the server. Try again."), a colon before an explanation, a comma before a trailing clause, brackets around an aside, a middle dot in a page's title ("Cash flow · ScaleX"), a hyphen where a dash stood for "no value". Fifteen were rewritten by hand where a rule read badly. Every other language follows English's choice at the same dash with its own punctuation; the few strings where a language had a dash and English had none were read one by one (German, French, Hungarian) and eleven were written by hand.
- **Russian keeps 307 dashes**, on purpose. Russian has no "is": "Запуск — отдельное «да»" needs its dash, and a comma or a colon there is a mistake a Russian reader sees at once. Where the Russian dash stood where the English one did, it went the same way (410 strings). No language keeps an en dash.
- **Ranges** say the language's own word: "+€136 to +€1,213", "bis", "a", "à", "至"; Hungarian and Russian take a spaced hyphen, because "from X to Y" in those languages would need the nouns around it in another case. One function, `rangeOf` in `lib/i18n/range.ts`, for every range a screen builds in code (the queue, Home, the report, Cash flow, the charts, the simulator, the pipeline, content, carts).
- **In code**: the lone dash that meant "no value" is a hyphen (74 places in 37 files a screen prints from), the sentences a screen or a route joined with a dash got the same punctuation as the catalogue (about 60 lines), and a decline's reason reads "Wrong data: the stock is off" (a reason recorded with the old dash is still read).
- **Arrows.** Buttons and links carry none, as in the mockups: 36 labels lost a trailing "→" in every language, and the arrow a screen drew as a hidden span is not shown inside the app (one rule in `app/sheet.css`). Before → after, a formula's result and ↗ stay.
- **Held by tests**: `messages/catalogue.test.ts` fails on an en dash anywhere, on an em dash outside Russian, on any dash in English, and on a label ending in an arrow. `lib/i18n/range.test.ts` holds the range.
- **Left as they are, on purpose**: the landing page ("can stay as it is") and the legal texts; and what is not a screen's words in `lib/`: prompts sent to a model, patterns that parse text, lines that are hashed (the case file), legal citations, operator tools, and sentences that have no twin in the catalogue.
- **Old records keep their dashes.** The decision log and the watch log are append-only (rule 7): an entry written before today still reads as it was written. The demo business shows fresh wording after `npm run db:seed-demo -- --fresh`.
- **The backend's twins follow (2026-11-19).** The English catalogue is also a contract: the backend writes a sentence, stores or returns it, and a screen matches it against the catalogue's English to say it again in the reader's language and to format its figures (`lib/i18n/stored.ts`, `lib/site/say.ts`, `lib/crm/say.ts`). Rewriting the catalogue alone broke that: History printed a stored outcome raw, and other languages lost their translation of refusals, reasons and log lines. The guard tests ("English is what lib/x always said") showed it once CI could run them. So the 105 backend sentences that have a twin now say what the catalogue says: 52 files in `lib/`, the carts rule of thumb, and the size words in `specs/benchmark-map-v1.json` ("2 to 9 people"). Change a `...Words` message and its twin in the same commit from now on.
- **The weekly summary email** no longer writes a long dash after the list's own mark: a waiting proposal is a nested line, indented in the text email and inset in the HTML one.
- **The demo shop's own words** (product names, the owner's answers, drafts, canned replies) hold no long dash either, so a demo shows none. Its fake website's HTML is left as an outside site's content.
- [later] Captions that start in lower case because they were written to sit inside a line ("buffer €10,900", "easy to undo", "after", "always") start with a capital where this round touched them (`.cap1`); the rest are still to do, screen by screen.

### L6 and the overlaps, continued (2026-11-19)

- **Stock** folds its working: the reorder note keeps the warning, the cost and what approving does, and puts the sum, the sources and the assumptions under "Why?"; how cover is counted and the season it counts sit under "How this works"; each clearing option keeps its headline figure and the five sums sit under one fold. The cover column reads "3 to 4".
- **Overlaps.** Rounded cards stacked in a screen always have air between them: Payments had three touching, because cards that shared a square edge in the classic look were never given a gap. One rule of zero specificity in `app/sheet.css`, so a screen's own spacing still wins. A card with nothing to list shows no empty band between its head and its foot.
- **The queue's two approve buttons** lost the arrow the style rule could not reach (it sat one element deeper).
- [x] Seen in a browser on 2026-11-19 and 20, once the local database was back: see "What the browser showed" below.

### What the browser showed (2026-11-19 and 20)

Every owner screen was opened in a browser again, signed in as the demo shop, with a script that also measures what an eye misses: anything hanging off the right edge, the words around any long dash, any control that still ends in an arrow, and any text too faint against what is behind it.

- **Watching** runs in two stacks while a watch is on, so a short card no longer leaves a hole beside a tall one; one column in reading order under 1100px.
- **Connections** logged "two children with the same key" on every render: a consent or a guide can name one scope on two lines (Shopify's `write_products`). The place in the list is part of the key now.
- **Arrows.** The Connect buttons kept theirs because words for a screen reader follow the arrow, and the report's fold drew one after its label. Neither shows in the app; that fold opens with the same plus as every other.
- **Faint text.** A fold that is a screen's own child sits on the dark desk and takes desk ink (Similar businesses and Abandoned carts had theirs in paper ink, near invisible); the same on Patterns for its section name and the two lines under its cards.
- **A capability with no name.** Shopify store changes joined the execution registry on 2026-11-16 without `ladder.capability.shopify_write`, so the Trust ladder printed the key and logged MISSING_MESSAGE, on `main` too. It has a name in seven languages, and `components/ladder/ladder-view.test.ts` fails for any capability without one.
- **A reader left behind.** `lib/competitors/view.ts` still looked for yesterday's wording of "doesn't resolve", so a stored read problem was never said in the reader's language.

### The plain pages (2026-11-20)

Nine pages were never brought into the frame: Plan and billing, the monthly statement, the growth studio, erasing the business, firms with access, the shadow summary, the Partner Console with its three sub-pages, and the NAV guide. They were lone square cards on the sign-in stage, which inside the frame left a small box in the middle of an empty screen. They open like every other screen now: the page head (where it sits, in the menu's own words, then the headline) and paper cards on the sheet system's tokens. `app/plain.css` holds what they share, scoped under `.pg`; the sign-in stage and the public pages do not move.

- The headline is the answer where there is one: "No plan yet.", the tier and its price, the month, "No firm has access to your business.", when erasure was asked for.
- The growth studio is two stacks of cards, and each of its five forms is folded until it is wanted.
- The Partner Console's sign-in link was a lone arrow with no words. It says "Sign in".
- The shadow summary is drawn by the component the public shared page uses as it is, so that card keeps its markup and takes the sheet card's shape here.
- **A page with no frame.** The shadow summary (`/shadow`) is opened from "What I may do", but no menu item's address starts it, so it had no bar, no rail and the classic look. A menu item can now name pages of its own that live at another address (`pages` on the item, `onItem` in `components/nav/AppFrame.tsx`, held by a test); the shadow summary is the first.
- **Seen in a browser** after a fresh seed of the demo shop: the report, History, the creative studio, the fact sheet and Support print no long dash, and the nine pages report nothing off the edge, no arrow on a control and no faint text.

### L7, the sentences with no twin (2026-11-20)

"No em and en dashes throughout the app" reached the catalogues on 2026-11-18 and the backend's twins on the 19th. What was left were the sentences the backend writes that no catalogue message mirrors: English only, printed as written. The browser found them on the report (break-even lines), on Patterns (a ratio's range), in the creative studio (a brief's sources). They were then read file by file, not replaced blind: a colon before an explanation, a full stop where a new sentence starts, brackets around an aside, "to" in a range.

- **What changed.** Proposals of every kind (ads, trading-hours trials, stock, bundles, follow-ups, seasons, customers, content), the report's and the trading hours' evidence, forecasts' claims, the ledger's reasons for not scoring, what Lex says when a change is asked for in chat, what the execution engine, the trust ladder and each provider answer when they refuse or fail, import refusals, the support chat's own lines to a customer, and the benchmark and NAV sentences that live in code in more than one language.
- **Ranges** in code go through `rangeOf` where a language is known: a ratio's spread, the site audit's, the price simulator's, the team's coverage, and the week in the summary email's heading (the platform's own date range draws a long dash, so the two days are joined by the language's word).
- **Readers that took text apart by its dash** read both forms, since rows written before keep theirs: a shot list's and a film's title (`lib/content/media-item.ts`, `generation.ts`), and a shot list's summary (`produce.ts`). `lib/content/video-title.test.ts` holds both.
- **Left as they are, on purpose:** prompts sent to a model, text parsers and character tables, lines that are hashed (the case file), legal citations, operator tools, invariant errors no person reads, the landing page.
- **How to find what is left:** the list tool reads only what sits inside a string or a template, never a comment. About 700 such lines before, under 200 after, none of them a sentence a screen prints.

### L6, Connections (2026-11-20)

Connections was the longest screen in the app, more than 6,000 px once everything on it had loaded: the patch panel, two import forms, and six permissions each listing everything it allows. Nothing was taken away; it is in three parts now (`components/ui/Tabs`).

- **What I read**: the patch panel alone (1,042 px at 1440 wide).
- **Your own files**: the bookings and bank statement imports, side by side (1,148 px).
- **What I may change**: the six permissions (1,781 px, from 5,418). What each one allows is in front of the person while they grant it (rule 13: a separate consent is given knowing what it covers) and folded under "What this allows" at any other time (`components/connections/ConsentFold.tsx`); the four with no note beside them sit two to a row.
- A part stays in the page while another is open, so a file half pasted is not lost and each permission still reads the result of its sign-in once. The address can name a part (`?tab=`), and a sign-in that comes back for a permission opens the third part. On a narrow screen the row of tabs scrolls sideways and brings the open tab into view.
- Held by tests in `components/connections/patch.test.ts`: which part an address opens, and each part's count. Seen in a browser at 1440 and 390 wide.

- **Customers** opens on fifteen rows where fifty stood (4,716 px to 2,301); each press adds thirty. Search and the filters read every customer, never only the rows on screen.
- **Customers, tidied (2026-11-20).** He looked at it and said "some cards are all over the place and i don't like the current look of it": five cards of five sizes shared one screen. It is three parts now, as Connections is: the list (1,678 px at 1440 wide), segments with campaigns, and bringing customers in. A business with no customers opens on the third. A row is its own control (the whole row presses, with a ring for the keyboard; the "Open" column is gone), the record stays beside the list while the list scrolls, and on a phone a row is two lines: the name with its pattern, then the figures.
- **Similar businesses**: the live comparison card keeps what it says about the comparison and the button to stop contributing (a consent stays in view); where the figures come from and what is not measured yet sit under "How this works".

- [ ] Not yet done on the list: L6 on the fact sheet and the report's own cards, captions still set in capitals inside the settings forms, Lex as a pop-up, and L9.

### The branch (2026-11-19)

`dashboard-v2` is pushed and passes every check on GitHub at `348c8c3`: type check, lint, format, migrations, tests, the bank lint and the production build. `main` (`e2eae45`) is merged in. The format step had failed on `main` since 2026-11-09 and hidden the tests and the build; fixing it showed two red tests nobody had seen (five public routes missing from the route door's list; a float on a money path in the estimate's rounding, which now uses `roundMinorTo`). Nothing is on `main`: merging is the deploy and is the owner's word.

**Merged and live (2026-11-20).** He said "push and merge and if you are capable of it deploy too". `dashboard-v2` at `b38f185` passed every check and went into `main` as pull request #1 (merge commit `ec2daf5`). Vercel built it for production within five minutes, which also answers an open question: a merge made by a collaborator who is not on the Vercel account does deploy on this public repo. The live site was then read: the new landing headline, Home sending a signed-out visitor to sign-in, the frame on the queue, the report, Connections and Customers, and the microphone allowed in the policy header. `straight-in` follows as its own pull request once its checks are green.

### L3 to L6, as built (2026-11-18)

Built to his pick and checked in a browser at 1440 and 390 wide. Nothing was pushed.

- **The frame** (`components/nav/AppFrame.tsx`, `app/shell.css`). A bar across the top: the wordmark, the business's name (a menu of the "Your business" screens, the switcher, who is signed in and Sign out), four places (Home, Decisions with its count, Insights, Grow), then Search, the bell, Ask Lex and the emergency stop. A rail under it lists only the open place's screens, an icon on each (`nav-icons.tsx`, 37 screens), the main ones first and the rest behind "N more"; it folds to 64px of icons that name themselves on hover and focus, and remembers the choice. The tab strip, the six-group rail and the phone's dock are gone. On a phone: the places along the bottom with "More", the screens as one row of chips with the open one brought into view. The menu's data (`GROUPS`) did not change; `PLACES` groups it, with tests.
- **A way back.** The queue and the report sit inside the frame with the rail folded. Their own mastheads keep only the line that says where you are; the wordmark and the stop are the bar's.
- **Lex's face** (`components/brand/LexFace.tsx`, `app/lex.css`): a rounded tile in the mark's green lit from the upper left, a darker side under it, a shadow on the ground, eyes with a point of light, a smile rising to the right. States: idle (blinks; floats on Home), working (a cobalt halo while Lex answers), listening, speaking, stopped (grey). `lexState()` decides, under test. It is in the bar, on Home, in "Lex now", beside Lex's turns and as the phone's button.
- **Home** to the merged mockup: Lex in the middle (face, day, the headline, the box to ask as one pill, three chips, the latest exchange), then three named columns: Needs you (each decision a card), Your numbers today (two tiles, sales with the period switch, visitors, where money slips), Lex now (the dark status card, then Activity and Made).
- **The shape**, one switch: 18px cards without a border, 12 and 10px controls, pills; a lift only on what opens; a small press. The classic look is the fallback of every rule, so the landing, the free check, sign-in and the interview did not move.
- **Cash flow** to its mockup: "Money could get tight this week." with one line under it; a "Why?" fold; three figures (cash today opens its source); the chart with the figures at its right edge; the four what-ifs as cards with their sizes in a side sheet; three weeks with "Show all 13 weeks"; sources folded. A range says "to" here now. Every figure and sentence that was on the page is still reachable.
- **The microphone.** The site's own `Permissions-Policy` header said `microphone=()`, left from the security review of 2026-10-17, eleven days before the microphone was built. A browser refuses the microphone under that header before it can ask, so no prompt ever came and the screen said "blocked". It is `microphone=(self)` now; the browser's permission state on the app went from refused to "prompt" (checked), and a test holds the header. He needs to try it once on his own machine: a real prompt cannot be pressed from here.
- **Found on the way.** The stop arrived late and pushed the bar's other buttons; it keeps its place now. The activity list's "Show more" was pale on paper. The report ran 32px wide on a phone (a chart label hanging off its line), from before this round. The local dev server, restarted after it ran out of memory, told every page to reload forever until its cache was cleared; nothing in the code.
- [later] The queue's and the report's own cards, tables and buttons still have the classic square look inside the new frame.
- [later] The other screens' own cards (the fact sheet, Connections, Stock and the rest) screen by screen, and less to read on each.

### L2, as built (2026-11-18)

Both are private artifacts on the claude.ai account he shares with Tedi, made from this repository so the design feature in Claude Desktop has our identity to work from. Its own picture of ScaleX stops at about 16 November (the landing, sign-in, the logo): the nine commits of `dashboard-v2` were never pushed, so nothing there knew about Lex, the interactive pass or the new type.

- **The ScaleX design system**: https://claude.ai/artifact/9kzHEw5awTkDUB2jvtjpjp. 33 colours and 13 text styles with a usage note each, the spacing scale, the mark exported from `components/brand/Mark.tsx`, a brand book of rules (voice, colour, type, shape, the screen, icons) and a Direction section that is the brief for new designs, in his words. It was an empty system before.
- **The canvas "ScaleX owner app: directions"**: https://claude.ai/artifact/HaqQt8HcP3YoPAbRD5H72k. Seven artboards:
  - Home A, Desk: the dark desk refined, two columns, Lex's side dark.
  - Home B, Paper: light, the conversation centred, three columns under it.
  - Home C, Split: a light workspace under the dark bar, Lex as a pop-up that holds the conversation and a decision inside it.
  - Cash flow: a headline, three figures, one chart, four what-if cards and three weeks, with the rest behind "Show all 13 weeks"; the rail unfolded, an icon on every item.
  - A decision: opened as a page with "Back to Home" and previous and next; the rail folded to icons with a tooltip.
  - Lex: three faces (A bars, B sheet, C mark) and face A in six states.
  - Home on a phone: the four top places as the bottom bar.
- What the mockups propose, all of it his to accept or change:
  - **Four places across the top**: Home, Decisions, Insights, Grow. Customers sits inside Grow; Your business (fact sheet, connections, statement, history, settings) sits under the business's name.
  - **The rail lists only the open place's screens**, with icons, and folds. The tab strip goes, so the top and the rail never say the same thing twice. Home has no rail.
  - **Every screen has a way back**: the queue and the report come inside the frame; a page opened from another says where it came from.
  - **Lex has a face** built from the mark (its two bars are the eyes, the smile rises to the right) with states for idle, listening, working, speaking, needs you and stopped.
  - **A small curve** (10 to 18px) and pill-shaped places and chips, where today every corner is square; hover, press and open have their own motion.
- Not checked in the canvas's own viewer: each artboard was drawn in a plain browser here before it was sent. The two interactive ones (Home A's tabs and first decision; the decision's Approve and Decline) use the canvas's own state and events, which could not be run locally.

### L1, as built (2026-11-18)

He saw the first capture mid-work and said it was what he wanted; he then added that the landing page "can stay as it is".

- One sans, Archivo, for headings, labels, controls and prose on the owner's screens; sentence case; a heading at weight 650. The mono stays for figures, keys, formulas and addresses. Stamps written in capitals in the catalogue stay stamps.
- Scope: the frame, the queue and the report (and so every sheet, the palette and toasts opened from them). The landing, the free check, sign-in and the interview are untouched: checked in the browser, the landing's headline is still Zilla Slab.
- A mechanical change: 128 capitals rules, 60 figure rules and 27 heading weights now read tokens whose fallback is the old value, and one block in `app/sheet.css` switches the owner's screens. Changing the face later is one line (`--f-ui`) and one font import.
- Checked on 21 screens at 1440 and on Home at 390: no text wider than its box, and no sideways scroll once the report was fixed (below).
- Found on the way, his own example: the Cash flow what-if table ran its sentences across the neighbouring columns. They wrap now. And the report scrolled sideways at desktop width (1587px in 1440) because a fact written as a sentence was held on one line; it was so before this change, and it wraps now.
- Five other faces were rendered on the real Home for him to compare (Geist, Manrope, Hanken Grotesk, Onest, IBM Plex Sans). Archivo has no Russian letters of its own, so the Russian screens fall back to the system's sans; Geist, Manrope, Onest and Plex Sans cover them.
- [later] Captions written in lower case for the old look ("buffer €10,900", "week of 18 Nov", "easy to undo") still start small. They belong to the copy pass (L7), which rewrites the catalogues anyway.
- [later] The arrows on Tedi's queue buttons ("Approve →") and the interview's type.

## Later rounds (parked on purpose)

- [later] A Home the owner can rearrange or trim.
- [later] The same treatment screen by screen, where a list or a table would gain from it: the queue (already keyboard-driven), Watching (a signal opened in place), the fact sheet (search and filter), Connections (a read's progress shown live), Customers and Support (rows opened in place), History (filters).
- [later] The sign-up reel's screenshots and the landing page's drawn screens, once the owner has seen the app.

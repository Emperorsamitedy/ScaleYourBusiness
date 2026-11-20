# ScaleX owner screens: design guide

Working guide for everything behind sign-in: the rail, Home and the owner screens. The spec of record is `specs/ux-spec-v1.md` §2 (the sheet system) and the screen sections that follow it; this guide points at tokens in code and lists the rules the coming redesign keeps. Written 2026-11-17, before the dashboard pass, so it ends with the decisions that pass will make.

What came from the Secuno review, and only this: tokens with a stated duty, one source of truth, a short list of non-negotiables, one standard for loading, empty and error states, one data-layer convention, and a ratchet against new UI debt. The look stays ScaleX's own, paper on a forest desk, not Secuno's.

## 1. The look in one paragraph

Paper sheets (`--paper`) on a dark forest desk (`--desk`). Since the owner's third round (2026-11-18) the owner app's frame is one ink bar across the top with the wordmark, the business's name and four places (Home, Decisions, Insights, Grow), then search, the bell, Ask Lex and the emergency stop; under it a rail of the open place's screens, an icon on each, that folds to icons; on a phone the places are a bar along the bottom. One plain sans (Archivo) sets headings, labels, controls and prose in sentence case, with IBM Plex Mono kept for figures. Corners take a small curve (18px on a card, 12 and 10px on controls, pills for places, counts and chips), and hover, press and open each have a short motion. The landing and the entrance keep the classic look: Zilla Slab headings, mono labels, square corners. The owner talks to Lex (`lib/core/assistant.ts`), who has a face (`components/brand/LexFace.tsx`); Home is built around that conversation. Colour is used only to mean something: green for ok, amber for drift, red for alarm, cobalt for live, a yellow marker behind fresh ink. The one accent is the brand green. The wordmark is `components/brand/Mark.tsx`, matched to the owner's final logo system on 2026-11-17.

## 2. Tokens: read `app/sheet.css`, don't copy it

| Group    | Variables                                                                                                                                                            | Duty                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Surfaces | `--desk`, `--masthead`, `--paper`, `--inset`                                                                                                                         | the page, the top bar, a sheet, an inset panel                                                |
| Rules    | `--rule`, `--rule-soft`, `--desk-rule`; `--hair`, `--line`, `--line-ink`                                                                                             | the three line weights                                                                        |
| Ink      | `--sheet-ink`, `--sheet-ink-2`, `--desk-ink`, `--desk-ink-2` (aliases `--ink`, `--mut`)                                                                              | text on paper, text on the desk                                                               |
| Meaning  | `--ok`, `--drift`, `--alarm`, `--low` and their `-band` fills; `--live`; `--marker`                                                                                  | verdicts, live state, fresh ink; never decoration                                             |
| Brand    | `--accent`, `--accent-desk`                                                                                                                                          | the one accent                                                                                |
| Type     | `--f-ui` (the app's face), `--f-fig` (figures), `--f-display`, `--f-prose`, `--f-mono`; `--caps*`, `--w-display`; `--t-display-1` to `-3`, `--t-prose*`, `--t-mono*` | the whole scale; a new size is a design bug. The app's switch is one block in `app/sheet.css` |
| Space    | `--s-1` (4px) to `--s-9` (64px), `--gutter`, `--measure` (68ch)                                                                                                      | every gap sits on the scale                                                                   |
| Motion   | `--d-press` 100ms, `--d-move` 220ms, `--d-record` 280ms, `--ease-out`; all zero under reduced motion                                                                 | the three durations                                                                           |
| Shape    | `--r-card` 18px, `--r-ctl` 12px, `--r-s` 10px, `--r-pill`; `--card-border`, `--card-head-rule`, `--menu-border`, `--menu-shadow`                                     | the owner app's curve; a rule reads them with the square look as its fallback                 |

Rule: a new colour gets a variable and a duty comment. A raw hex value in a component is a bug.

## 3. Primitives: look here before writing a class string

`components/sheet/`: `PageHead` (kicker, title, aside), `Fold` (a closed "How this works"), `WhySheet` (the working-out behind a figure), `RangeBar`, `DeepLinkMark` (the marker a deep link lands on), `AppIcon`, `num.ts` (every figure through the owner's locale) and `useTr`. The conversation's pieces live in `components/chat/`: `useChat` (the thread, one message at a time, the cards and the proposal a request became), `Composer` (label, box, Ask, the microphone, the rule under a fold) and `ChatTurn` (one turn, Lex under the mark). A decision decided where it stands is `components/home/DecisionCard.tsx`; a screen's icon is `components/nav/nav-icons.tsx` (one per screen, held by a test); Lex's face is `components/brand/LexFace.tsx`, and `lexState()` says which state it shows. The bar and the rail live in `components/nav/AppFrame.tsx` and `app/shell.css`: `GROUPS` are Today, To approve, Insights, Grow, Customers and Your business, and `PLACES` says which groups make each of the four places; every item's label comes from the catalogue, and a test holds the English equal. `.cap1` (in `app/sheet.css`) starts a caption with a capital when it stands alone; `.ph-lede` and `.ph-pill` are the page head's one line under the title and its one note on the right.

**The interactive pieces (`components/ui/`, 2026-11-17).** Use these before writing an overlay, a list of tabs or a notice of your own:

- `Sheet`: the one side sheet (modal, focus trapped and returned, Escape and the scrim close it, full screen on a phone). The Why sheet, Lex's sheet, the review of a decision and the shortcuts list run on it. Its focus and scroll rules are `overlay.ts`, under test.
- `ToastProvider` and `useToast()`: one line after a recorded action or a failure. A toast repeats what the page shows; it never asks for a decision.
- `Tabs`: arrow keys move, one tab stop, counts beside labels; keep the choice in the address with `components/home/useAddressParam.ts`.
- `Menu`: a short list under its button (the bell). `IconButton`: always with a `label`. `Kbd`: a key in a hint. `Skeleton`: lines while a card reads.
- `components/nav/NavContext.tsx`: `useNavRefresh()` reads the menu's counts again now (call it after anything that changes them) and `useLex().open(question?)` opens Lex's sheet. Both do nothing outside the frame.
- `components/home/useRead.ts`: the read hook to copy on a screen that should stay fresh (cached for the page's life, repeated while visible, retried on demand).

Rules for them: an icon only on a control that would otherwise need a sentence; cobalt only while something is genuinely running; the marker only behind what has just arrived; nothing fires from the keyboard while the focus is in a field.

## 4. States: one standard

- Loading: the headline says "Reading…" and each card shows skeleton lines (`components/ui/Skeleton.tsx`) until it lands. Never a spinner over the whole page.
- Empty is a claim. Say "Nothing is waiting" only on a counted zero (Home, fixed 2026-11-16). A read that failed says it could not read and asks for a refresh; it never looks like an empty success.
- Signed out: the server sends the visitor to sign in before the screen renders, and a read refused mid-visit does the same from the client.
- Error: one shared shape, a plain sentence and the next step. On Home a card that could not be read says so with **Try again** (`components/home/FailedRead.tsx`); a failed refresh keeps what was on screen. No stack traces, no ids.

## 5. Non-negotiables

- Every figure carries its source and basis (the Why sheet). No number without provenance (CLAUDE.md rule 2).
- Approve and Decline are equal buttons, and a decline takes a reason (ux-spec §8).
- Money is integer minor units plus a currency, formatted in the owner's locale. Never a float, never a digit typed into a message.
- Icon-only buttons carry `aria-label`, toggles are `role="switch"`, and the keyboard reaches everything the pointer does.
- Destructive or irreversible actions say so before the click and sit apart from the main action.
- Nothing moves without a scroll, a click or a settled fact, and reduced motion turns it all off.

## 6. Data layer convention

Screens read their own JSON routes (`/api/nav`, `/api/proposals`, `/api/cash`, `/api/charts` and the rest) from the client with `cache: "no-store"`. The pattern to copy is `useRead` in `components/home/HomeScreen.tsx` with the `Read<T>` states in `components/home/home-model.ts`: reading, read, signed_out, failed, decided by status code, with pure helpers under test.

## 7. Decisions taken in the dashboard pass (2026-11-17)

The owner's brief came in two parts. First: a chat-centred dashboard in the manner of Foundable's Ted, the yes allowed as an exchange with the assistant as long as it stays an approval, graphs few and simple, a name for the assistant. Then, after the first version: it was "nowhere near as good" as Foundable's or Secuno's, and he said what he meant: **not the looks**. "I just wanted you to improve the technicality of it and sort of make it interactive." The theme stays like the landing page, with no tiles and no generated imagery in the app, and text stays small ("not a lot of jazz"). The working list of that second part is `docs/DASHBOARD-OVERHAUL.md`.

1. **The assistant is Lex** (`lib/core/assistant.ts`): the three letters that end ScaleX, and Latin for law. It speaks under the mark on an ink tile, in the first person the app already used. The name is never translated.
2. **The look does not change.** The sheet system stays as §1 describes it. New pieces are drawn with its tokens and classes. A restyle to a light canvas and rounded cards was started and withdrawn the same day.
3. **Home is a workspace around the conversation** (`components/home/`): Lex's head, the composer with three question chips and the latest exchange, readings as buttons, the sales lines with a period switch; on Lex's side a status card with "Read now", then tabs for Needs you, Activity and Made. The emergency stop is one control in one place: the strip, on every screen. The spec paragraph is ux-spec §3 "Home".
4. **Things open in place.** A decision is read and answered in a side sheet (`components/proposals/ReviewSheet.tsx`, the same body as the phone page); a figure's working-out in the Why sheet; the conversation in Lex's sheet on any screen. The address carries what is open (`?tab=`, `?review=`).
5. **The yes stays an approval.** Wherever a decision is answered (a card on Home, the review sheet, under Lex's reply) the consequence verb and Decline are equal buttons, a decline takes a reason, and it goes through `PUT /api/proposals` with the signed-in name (rule 12). Nothing runs on a sentence.
6. **The app stays fresh on its own.** Home's reads are cached for the page's life, repeated while the tab is visible and retried on demand; the menu's counts refresh every minute and after a decision; new rows in the feed are marked for a moment.
7. **The shell answers back**: a command palette on Ctrl+K, the bell, keyboard shortcuts, one row of tabs, a cobalt bar while a screen loads, toasts. ux-spec §3 lists them. "Needs you" has one definition (`components/nav/attention.ts`) shared by the bell and Home's tab, so two counts under one name never disagree.
8. **Fewer words.** No paragraph under a composer; the conversation page's box is named once, by its sheet's title (the label is only spoken); the microphone listens on one press and its privacy sentence lives on the privacy page; a failure is one short sentence.
9. **Graphs.** The stock-chart metaphor stays on Watching and the report. Home draws printed lines only, with a period switch, and the month's parts as bars behind a fold.
10. **Later rounds** (the foot of the working list): the rail folding to icons, a Home the owner can rearrange, the same in-place treatment on the other screens, the sign-up reel's screenshots.

## 8. Decisions taken in the third round (2026-11-18)

The owner used the interactive pass and said the look was "nowhere near where I want it to be just yet": it should reach Foundable's level of appeal "in our own unique ways on buttons and animations and transitions and hover effects and coloring and fonts", our identity preserved. That supersedes decision 2 above ("The look does not change"). He picked from mockups (`docs/DASHBOARD-OVERHAUL.md`, L2): Home as "a mix between A and B", yes to the navigation, a face for Lex with "an almost 3D feel", and he said the landing page "can stay as it is".

1. **The palette and the surfaces stay; the shape and the type change.** One switch in `app/sheet.css` (`:root:has(.app-frame, .q-app, .rq)`) sets the type and shape tokens for the owner's screens. Rules read them with the classic value as the fallback, so nothing outside the app moved.
2. **Four places at the top, a rail per place.** The tab strip is gone. The queue and the report are inside the frame, the rail folded. ux-spec §3 has the whole of it.
3. **Lex has a face** with real states only: it never looks busy when nothing is running.
4. **Home**: Lex in the middle, then three named columns (needs you, your numbers, Lex now).
5. **A lift means it opens.** Only a card or tile that opens something lifts on hover. A press scales a control slightly. Fills and colours ease. All of it is off under reduced motion.
6. **Less to read at once**, Cash flow first: a short title and one line under it, three figures, the chart, cards instead of a wide table, three rows with the rest one press away, the working-out folded or in a sheet. Nothing is deleted; provenance stays one press away.
7. **The microphone** was refused by the site's own `Permissions-Policy` before the browser could ask. It names `microphone=(self)` now (`lib/voice/policy.test.ts`).

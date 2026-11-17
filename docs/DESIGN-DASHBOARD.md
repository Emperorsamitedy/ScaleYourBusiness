# ScaleX owner screens: design guide

Working guide for everything behind sign-in: the rail, Home and the owner screens. The spec of record is `specs/ux-spec-v1.md` §2 (the sheet system) and the screen sections that follow it; this guide points at tokens in code and lists the rules the coming redesign keeps. Written 2026-11-17, before the dashboard pass, so it ends with the decisions that pass will make.

What came from the Secuno review, and only this: tokens with a stated duty, one source of truth, a short list of non-negotiables, one standard for loading, empty and error states, one data-layer convention, and a ratchet against new UI debt. The look stays ScaleX's own, paper on a forest desk, not Secuno's.

## 1. The look in one paragraph

A lab-report look. Paper sheets (`--paper`) on a dark forest desk (`--desk`); one ink masthead with the wordmark; a rail of six labelled groups, one glyph each, a dock on a phone; headings in Zilla Slab, body in Archivo, machine truth in IBM Plex Mono; square corners and 1px rules. The owner talks to Lex (`lib/core/assistant.ts`), who speaks under the mark on an ink tile; Home is built around that conversation. Colour is used only to mean something: green for ok, amber for drift, red for alarm, cobalt for live, a yellow marker behind fresh ink. The one accent is the brand green. The wordmark is `components/brand/Mark.tsx`, matched to the owner's final logo system on 2026-11-17.

## 2. Tokens: read `app/sheet.css`, don't copy it

| Group    | Variables                                                                                            | Duty                                              |
| -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Surfaces | `--desk`, `--masthead`, `--paper`, `--inset`                                                         | the page, the top bar, a sheet, an inset panel    |
| Rules    | `--rule`, `--rule-soft`, `--desk-rule`; `--hair`, `--line`, `--line-ink`                             | the three line weights                            |
| Ink      | `--sheet-ink`, `--sheet-ink-2`, `--desk-ink`, `--desk-ink-2` (aliases `--ink`, `--mut`)              | text on paper, text on the desk                   |
| Meaning  | `--ok`, `--drift`, `--alarm`, `--low` and their `-band` fills; `--live`; `--marker`                  | verdicts, live state, fresh ink; never decoration |
| Brand    | `--accent`, `--accent-desk`                                                                          | the one accent                                    |
| Type     | `--f-display`, `--f-prose`, `--f-mono`; `--t-display-1` to `-3`, `--t-prose*`, `--t-mono*`           | the whole scale; a new size is a design bug       |
| Space    | `--s-1` (4px) to `--s-9` (64px), `--gutter`, `--measure` (68ch)                                      | every gap sits on the scale                       |
| Motion   | `--d-press` 100ms, `--d-move` 220ms, `--d-record` 280ms, `--ease-out`; all zero under reduced motion | the three durations                               |

Rule: a new colour gets a variable and a duty comment. A raw hex value in a component is a bug.

## 3. Primitives: look here before writing a class string

`components/sheet/`: `PageHead` (kicker, title, aside), `Fold` (a closed "How this works"), `WhySheet` (the working-out behind a figure), `RangeBar`, `DeepLinkMark` (the marker a deep link lands on), `AppIcon`, `num.ts` (every figure through the owner's locale) and `useTr`. The conversation's pieces live in `components/chat/`: `useChat` (the thread, one message at a time, the cards and the proposal a request became), `Composer` (label, box, Ask, the microphone, the rule under a fold) and `ChatTurn` (one turn, Lex under the mark). A decision decided where it stands is `components/home/DecisionCard.tsx`; the rail's glyphs are `components/nav/GroupGlyph.tsx`. The rail and masthead live in `components/nav/AppFrame.tsx`, whose `GROUPS` are Today, To approve, Insights, Grow, Customers and Your business; every item's label comes from the catalogue, and a test holds the English equal.

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
8. **Fewer words.** No paragraph under a composer; the microphone listens on one press and its privacy sentence lives on the privacy page; a failure is one short sentence.
9. **Graphs.** The stock-chart metaphor stays on Watching and the report. Home draws printed lines only, with a period switch, and the month's parts as bars behind a fold.
10. **Later rounds** (the foot of the working list): the rail folding to icons, a Home the owner can rearrange, the same in-place treatment on the other screens, the sign-up reel's screenshots.

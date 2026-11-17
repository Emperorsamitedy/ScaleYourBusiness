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

## 4. States: one standard

- Loading: the headline says "Reading…" and parts appear as they land. Never a spinner over the whole page.
- Empty is a claim. Say "Nothing is waiting" only on a counted zero (Home, fixed 2026-11-16). A read that failed says it could not read and asks for a refresh; it never looks like an empty success.
- Signed out: the server sends the visitor to sign in before the screen renders, and a read refused mid-visit does the same from the client.
- Error: one shared shape, a plain sentence, the next step. No stack traces, no ids.

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

The owner's brief: a chat-centred dashboard in the manner of Foundable's Ted, the yes allowed as an exchange with the assistant as long as it stays an approval, graphs few and simple, a name for the assistant (not Ted), and the organisation, placement and cosmetics left to the pass. What was decided, and where it lives:

1. **The assistant is Lex** (`lib/core/assistant.ts`): the three letters that end ScaleX, and Latin for law. It speaks under the mark on an ink tile, in the first person the app already used. The name is never translated.
2. **Home is the conversation** (`components/home/HomeScreen.tsx`, `app/home.css`). Lex's head on the desk (mark, name, day, the answer as the headline), the composer sheet with the latest exchange under it, then the readings, the sales line and, folded, where the money slips. Lex's side on the right: Needs your yes, Doing now, Done. One column under 1100px, the decisions straight after the composer. The spec paragraph is ux-spec §3 "Home".
3. **The yes stays an approval.** A proposal is decided where it stands (`components/home/DecisionCard.tsx`): the consequence verb and Decline as equal buttons, a reason on decline, through `PUT /api/proposals` exactly as the queue does, recorded with the signed-in name (rule 12). A request typed to Lex becomes a proposal and its card appears under the reply; nothing runs on the sentence.
4. **Density.** Home carries two columns on a desk; every other screen stays one sheet with folds.
5. **The rail keeps its six groups**, each with one glyph (`components/nav/GroupGlyph.tsx`). On a phone they are a dock along the bottom (`.app-dock`), each opening the group's first main screen, with the strip across the top listing the rest. "Ask Lex" with the mark sits at the rail's foot.
6. **Big monitors.** The frame grows a step at 1800px and again at 2400px (`app/globals.css`), and Home's columns widen first.
7. **Graphs.** The stock-chart metaphor stays on Watching and the Report. Home draws the last 30 days as printed lines only (takings, orders), the month's parts as bars behind a fold, and the live line at the head of the readings. Nothing else is charted on Home.
8. **Still to do.** The reply cards for proposals on `/chat` itself (today a line and a link), a composer at the foot of the report and fact sheet (conversation channel §7), the pass over the remaining owner screens to the same standard, and the debt ratchet (a failing test for raw hex and typed pixel sizes) once those settle.

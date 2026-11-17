# ScaleX owner screens: design guide

Working guide for everything behind sign-in: the rail, Home and the owner screens. The spec of record is `specs/ux-spec-v1.md` §2 (the sheet system) and the screen sections that follow it; this guide points at tokens in code and lists the rules the coming redesign keeps. Written 2026-11-17, before the dashboard pass, so it ends with the decisions that pass will make.

What came from the Secuno review, and only this: tokens with a stated duty, one source of truth, a short list of non-negotiables, one standard for loading, empty and error states, one data-layer convention, and a ratchet against new UI debt. The look stays ScaleX's own, paper on a forest desk, not Secuno's.

## 1. The look in one paragraph

A lab-report look. Paper sheets (`--paper`) on a dark forest desk (`--desk`); one ink masthead with the wordmark; a rail of six labelled groups; headings in Zilla Slab, body in Archivo, machine truth in IBM Plex Mono; square corners and 1px rules. Colour is used only to mean something: green for ok, amber for drift, red for alarm, cobalt for live, a yellow marker behind fresh ink. The one accent is the brand green. The wordmark is `components/brand/Mark.tsx`, matched to the owner's final logo system on 2026-11-17.

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

`components/sheet/`: `PageHead` (kicker, title, aside), `Fold` (a closed "How this works"), `WhySheet` (the working-out behind a figure), `RangeBar`, `DeepLinkMark` (the marker a deep link lands on), `AppIcon`, `num.ts` (every figure through the owner's locale) and `useTr`. The rail and masthead live in `components/nav/AppFrame.tsx`, whose `GROUPS` are Today, To approve, Insights, Grow, Customers and Your business; every item's label comes from the catalogue, and a test holds the English equal.

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

## 7. What the dashboard pass will decide

1. The order of Home: what the owner sees first (decisions, cash, the watch) and what folds away.
2. Density: one sheet per screen with folds, or more on the desk at once.
3. Whether the rail keeps six groups, or collapses to four on narrower screens.
4. Size tiers for large monitors, as the landing page now has.
5. Which screens keep the "read like a stock" metaphor and which read as plain sheets.
6. A ratchet script against new UI debt (raw hex, pixel font sizes, hand-written tables) once the primitives are settled.

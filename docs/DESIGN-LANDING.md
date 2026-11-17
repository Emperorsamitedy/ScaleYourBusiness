# ScaleX landing page: design guide

Working guide for the front page: `app/page.tsx`, `components/marketing/LandingV2.tsx`, `components/marketing/landing-v2-motion.ts`, `app/landing-v2.css` and the media in `public/landing-v2/`. The spec of record is `specs/ux-spec-v1.md` §7.1b; where the two disagree, the spec wins and is fixed in the same commit. Tokens live in code, and this guide points at them instead of copying their values, because copied values go stale.

Adopted 2026-11-17 from the owner's review of the page and from a review of the Secuno design system, taking only its generic practices: tokens with a stated duty, one source of truth, a short list of non-negotiables, one standard for states, and a list of traps that have cost time.

## 1. Who reads the page, and how we write

Owners of small and medium businesses, often on a phone, in a hurry, not always in their first language. They know their numbers. They do not know us.

- Short sentences, one idea each, about six to fifteen words.
- "You" and "ScaleX". Never "we" on the landing page.
- The benefit before the feature: "Nothing changes until you press Approve" before any word about workflows.
- Numbered steps where there is an order. The section kickers say "Step 1: connect and answer" through "Step 4: results".
- Questions get the answer first: "No. Nothing changes until you press Approve."
- Buttons say what happens: "Check my business for free", "See how it works". No arrows, no "Learn more".
- No em dashes, en dashes or underscores in copy. A colon or a full stop does the work. A middle dot separates short facts on one line.
- No figure typed into a message. Amounts, counts, minutes and percentages are formatted in code (`lib/marketing/landing-v2.ts`, `components/sheet/num.ts`) and passed in. The catalogue test fails on a typed digit (rule 3 of `TASKS-LANGUAGES.md`).
- Every word exists in all seven languages (`messages/*.json`, the `landingV2` namespace) and uses the glossary's term (`specs/glossary-v1.json`) for "business", "website", "account", "fact sheet", "forecast", "owner" and the rest. `messages/catalogue.test.ts` holds all of this.
- The headline is the owner's promise, "Manage your business's online presence with ScaleX.", at the top and again at the bottom; the lede says what that means ("Your marketing, ads and website, run for you."); "Nothing happens until you say yes." belongs to the decision section only. The pricing section says plainly that every plan starts with a free month that changes nothing.

## 2. Brand

- The wordmark is `Wordmark` in `components/brand/Mark.tsx`: "Scale" in Archivo 800 and the mark standing as the X, as tall as the capitals with its tip a touch above (`.brand-word`, `.brand-x` in `app/globals.css`). On a dark ground `onDark` turns the bars white. The header shows the wordmark alone; the mark on its own appears only in app screens' mastheads and in the icons. The reference is the owner's sheet "ScaleX, final logo system".
- Colours: Ink `#0D1321`, Accent `#00A86B`, Paper `#FFFFFF` (`BRAND` in Mark.tsx). The landing's own palette is the set of custom properties at the top of `app/landing-v2.css` under `.lx`: the stage (`--ink-0`), text on the stage (`--fg`, `--fg-2`, `--fg-3`), the button fill (`--acc`), the green turn in headlines and the rail (`--hi`), the leak colour (`--amb`), and the paper set (`--paper`, `--p-ink`, `--p-line`, the flag bands) for app screens. A new colour gets a property there with a role name, never an inline value.

## 3. Type

Three families, inherited from `app/sheet.css`: `--f-display` (Zilla Slab) for headlines, `--f-prose` (Archivo) for everything readable, `--f-mono` (IBM Plex Mono) for machine truth: sources, dates, figures and labels in capitals. Sizes are `clamp()` on the viewport. In the base frame the hero headline tops out at 60px and section headings at 58px; the two wide tiers below raise them. Body on the stage is 16px and the lede 19px; nothing is under 12.5px except mono labels.

## 4. Layout and breakpoints

One content frame, `.lx .s .in`, holds two columns, the copy and one app screen, which swap sides every section (`.s.right`). Text columns stay under about 40em at every width.

| Width         | What changes                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| up to 480px   | one column; the hero button fills the width and its promise drops under the label; the header's free-check button hides |
| up to 900px   | one column, the nav hides, nothing leans, sections lose their minimum height                                            |
| up to 1379px  | the section rail on the left hides                                                                                      |
| 901 to 1599px | the 1240px frame, 64px gap, screens 540px wide                                                                          |
| from 1600px   | a 1500px frame, 84px gap, larger type, screens scaled with `zoom` (1.08 for the hero tour, 1.12 for the sections)       |
| from 2200px   | a 1900px frame, 110px gap, larger again (zoom 1.22 and 1.3), bigger buttons, nav and footer                             |

The wide tiers exist so a large monitor shows a full page rather than a narrow island with background on both sides. `zoom` is used for the screens because their insides are fixed pixels on purpose; scaling them with font size would break their proportions.

## 5. Backgrounds

The theme, chosen by the owner on 2026-11-17: glazed diamond tiles in the manner of Budapest's Zsolnay roofs, teal and emerald on near-black, with a thread of green light along the tile edges. The tiles are a texture behind the page, the way secuno.nl folds a Dutch painting into its background: no roofs, no buildings, no people, no text in a frame.

Nine scenes, one per section (`SCENES` in `LandingV2.tsx`). Scenes 0 to 4 are 8-second films that start and end on their own still, so the loop never cuts; scene 5 pans sideways with the scroll; scenes 6 to 8 drift slowly. Each scene is dimmed by its `shade` (0.12 for the hero up to 0.38) through the `.shade` layer, and the copy sits on the scene's dark side (left for a section, right for `.s.right`).

Files in `public/landing-v2/`: `gN.jpg` at 1600px and `gN-2x.jpg` at 2560px as a `srcset` pair (the pan scene is one 3024px still served as plain `src`), and `gN.mp4` and `gN.webm` for the films (1920×1080, silent, H.264 at CRF 23 and VP9 at CRF 34, about 0.3 to 1.4 MB each).

To make a new scene: generate the still at 16:9 (21:9 for a pan) with the dark side where the copy will sit; make the film from that still with it as both first and last frame, 8 seconds, no audio; crop to 1920×1080 and encode as above; export the still at 1600 and 2560. Flip a still horizontally when its dark side lands on the wrong side rather than regenerating it.

## 6. Components

- Buttons (`.btn`): 50px tall, a 4px radius (a slight curve, never a pill), the label only. `.btn.go` is the accent fill for the one main action; the ghost is the second. At most two in any section.
- App screens (`.win`): the masthead (mark, business, screen name, a note) over white paper with 1px rules, square corners, one shadow for depth over film. The in-screen action (`.lx-act`) has a 3px radius.
- Flags (`.flag`): a word in uppercase mono with a border, in the four tones ok, drift, alarm and low. Never a bare colour.
- The Trust Ladder (`.ladder`): four columns rising to the right; the lit column carries "Your step" above it, with 32px reserved so the label never meets the masthead in a longer language.
- Questions (`.faq`): native `details` elements, the question in 18px prose, the answer first.

## 7. Motion

The rules are in the spec §7.1b and in `landing-v2-motion.ts`: scenes mix by scroll and cross-fade; a screen prints behind a line of light and leans by its distance from the middle; only the hero tour and the interview demo loop on their own; `prefers-reduced-motion` turns all of it off and shows finished states. The owner likes these transitions; keep them, and add nothing that moves without a scroll or a click.

## 8. Do and don't

- Do keep the dark stage, the green turn, the white paper screens and the app's own vocabulary ("Approve", "Trust Ladder").
- Don't add arrows, chevrons or dashes to buttons or lines. Don't add a third call to action. Don't put people in the footage.
- Don't hard-code a colour, a size tier or a figure. Don't change a glossary word in one language only.
- Don't widen a text column past about 40em at any size.

## 9. Before shipping a change

1. Run the seven-language rules and the landing words test (about a minute): `node node_modules/vitest/vitest.mjs run messages/catalogue.test.ts components/marketing/words.test.ts --testTimeout=900000`.
2. Lint and format the touched files. When the full typecheck will not finish on this machine, use a targeted config that includes only the touched files and their imports.
3. Screenshot the hero at 500, 1440 and 2560 wide, then a `.s.right` section, the ladder and the questions in a real browser session.
4. The pull request's CI must be green.

## 10. Traps that have cost time

- Headless Chrome will not open a window narrower than about 500px; a "390px" screenshot is a cropped 500px page. Use device emulation for phones.
- Anchor screenshots (`/#s6`) come out black in headless mode because the reveal classes never fire. Scroll in a real session instead.
- `srcset` with `sizes` makes an image's natural width equal to the viewport, which stops the pan scene from panning. The pan still is served as plain `src` at its full width.
- A glossary stem must appear in the translation exactly. Russian "карточку фактов" (the accusative) fails the "карточка фактов" stem; rephrase around the nominative.
- Chrome's `--virtual-time-budget` is needed to capture the top of the page; `--timeout` alone captures before the scenes paint.

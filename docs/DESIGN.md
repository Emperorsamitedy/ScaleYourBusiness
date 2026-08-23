---
version: alpha
name: Ember Grid
description: A dark-first design system for SYB's intake and future modules — near-black stage, amber ember accent, hairline-glow depth, and Vignelli grid discipline. Derived from the LSTEAK Protocol reference imagery, disciplined by the Vignelli Canon.
colors:
  primary: "#F59B4B"
  primary-bright: "#FFB25C"
  primary-deep: "#E1560F"
  primary-strong: "#C2410C"
  on-primary: "#1C1006"
  secondary: "#4C7DF0"
  success: "#34D399"
  error: "#FF7A72"
  error-container: "#3A1512"
  on-error-container: "#FFC7C2"
  surface: "#0A0B0D"
  surface-container: "#131418"
  surface-container-high: "#1A1C21"
  on-surface: "#F2F3F5"
  on-surface-variant: "#9BA1AB"
  outline: "#2A2C33"
  outline-variant: "#1E2026"
  surface-light: "#EFF0F2"
  surface-container-light: "#FFFFFF"
  surface-container-high-light: "#F5F6F8"
  on-surface-light: "#141519"
  on-surface-variant-light: "#5B616C"
  outline-light: "#D9DCE1"
  outline-variant-light: "#E8EAEE"
typography:
  display-lg:
    fontFamily: Schibsted Grotesk
    fontSize: 56px
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Schibsted Grotesk
    fontSize: 36px
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: -0.01em
  headline-md:
    fontFamily: Schibsted Grotesk
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.25
  body-lg:
    fontFamily: Schibsted Grotesk
    fontSize: 18px
    fontWeight: 400
    lineHeight: 1.55
  body-md:
    fontFamily: Schibsted Grotesk
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.55
  body-sm:
    fontFamily: Schibsted Grotesk
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.5
  label-md:
    fontFamily: Schibsted Grotesk
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0.02em
  label-sm:
    fontFamily: Schibsted Grotesk
    fontSize: 11px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0.08em
  data-lg:
    fontFamily: Schibsted Grotesk
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.1
  mono-sm:
    fontFamily: IBM Plex Mono
    fontSize: 11px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0.06em
rounded:
  none: 0
  sm: 6px
  md: 12px
  lg: 16px
  xl: 24px
  full: 9999px
spacing:
  xs: 4px
  sm: 8px
  md: 16px
  lg: 24px
  xl: 48px
  gutter: 24px
  margin: 64px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: 12px 24px
    height: 44px
  button-primary-hover:
    backgroundColor: "{colors.primary-bright}"
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.on-surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: 12px 20px
    height: 44px
  button-ghost-hover:
    backgroundColor: "{colors.surface-container-high}"
  input-field:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-lg}"
    rounded: "{rounded.md}"
    padding: 12px 16px
    height: 48px
  input-field-focus:
    backgroundColor: "{colors.surface-container}"
  card:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.lg}"
    padding: 24px
  card-focal:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.on-surface}"
    rounded: "{rounded.xl}"
    padding: 32px
  chip:
    backgroundColor: "{colors.surface-container}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.md}"
    padding: 12px 16px
  status-pill:
    backgroundColor: "{colors.surface-container-high}"
    textColor: "{colors.on-surface-variant}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.full}"
    padding: 4px 10px
---

# Ember Grid

## Brand & Style

Ember Grid is "expensive fintech at night, run by a Swiss modernist." The stage is near-black; warmth comes from a single amber ember that carries every action, every live data line, every focal edge. The reference imagery (LSTEAK Protocol) supplies the atmosphere — glowing hairlines, dark glass surfaces, temperature contrast between warm amber and cool blue — while the Vignelli Canon supplies the discipline: one grid, ten type styles, restraint everywhere the ember isn't. The product underneath is SYB, an AI business operating system that interviews an owner and builds an evidence-first profile of their business; the UI must feel calm, precise, and provenance-obsessed — a considered instrument, never a hype machine. The one anti-pattern that overrides all others: this must never read as crypto-casino. No 3D coins, no confetti, no pulsing glow spam, no decorative renders — the glow is architecture, not fireworks.

## Colors

Dark is the primary and canonical mode; the light tokens (`*-light`) are a derived variant for user preference, not a second brand. On the dark stage, `surface` is the near-black canvas, `surface-container` the card layer, and `surface-container-high` the raised interior layer (segmented controls, hover fills). `primary` (#F59B4B) is the ember — actions, focus rings, live chart lines — with `primary-bright` for hover and `primary-deep` as the low end of the one permitted gradient (`primary-deep → primary`). `secondary` (#4C7DF0) is the blue whisper: ambient glows and the cool end of the focal CTA gradient only — never text on dark below headline sizes (it fails AA for body). `success` (#34D399) exists solely as the settled-fact dot; `error` is a warm coral tuned to 7.7:1 on `surface`. In light mode, actions and accents switch from `primary` to `primary-strong` (#C2410C), because raw amber fails contrast on white. All body text pairs meet WCAG AA: `on-surface` on `surface` is ~17:1, `on-surface-variant` is ~7.5:1, `on-primary` on `primary` is ~8.6:1.

## Typography

One family plus one mono — the Vignelli position. **Schibsted Grotesk** (free, Google Fonts; the Helvetica-adjacent grotesk closest to the reference's headline character) sets everything from display to labels; **IBM Plex Mono** is reserved for provenance and machine-truth: field keys, source lines ("1.4 · owner · stated"), timestamps, token costs. `display-lg` and `headline-lg` run tight (-0.02/-0.01em) for the reference's gravitational headlines. `data-lg` is the stat numeral — always with `font-variant-numeric: tabular-nums`. `label-sm` is rendered uppercase and carries the 0.08em tracking; it is the eyebrow/metadata voice. Ten styles exist; no eleventh may be invented — if a size feels missing, the layout is wrong, not the scale.

## Layout & Spacing

An 8px base unit governs everything; the named sequence is xs 4 → sm 8 → md 16 → lg 24 → xl 48, with `gutter` 24 between grid columns and `margin` 64 for section breaks. The intake keeps its three-column theatre: recorded answers alternate into the side columns, one focal card holds the centre, max content frame ~1200px. Vignelli's rule applies at every altitude: elements sit on the grid or they don't ship — no optical nudging, no half-gutters. Density is generous; a screen with more than one focal card has failed. Motion is part of the layout contract: the depart → settle → rise sequence (~240/340/380ms, cubic-bezier(.2,.7,.3,1)) survives the restyle unchanged, and `prefers-reduced-motion` disables all of it.

## Elevation & Depth

Depth is light, not shadow. Four devices, in order of preference: (1) tonal layering — `surface` → `surface-container` → `surface-container-high`; (2) 1px hairline borders in `outline` / `outline-variant`; (3) the ember edge — a 1px border whose color blends toward `primary-deep` on one flank, reserved for the single focal element on screen; (4) ambient glow — large, very-low-opacity radial gradients of `primary-deep` and `secondary` bleeding from the stage corners, fixed to the page background, never attached to components. Drop shadows do not exist in this system. In light mode, the glows drop out entirely and hairlines carry all depth.

## Shapes

Cards are soft (`md` 12px for standard, `lg` 16px for content cards, `xl` 24px for the focal question card); every button, status element, and toggle is a full pill (`full`). That split is the reference's signature: rectangles hold information, pills are things you press or read as state. Inputs use `md` to sit visually inside cards. `sm` (6px) is for small interior elements — code spans, keycaps, select options. Sharp corners (`none`) are reserved for full-bleed rules and the progress hairline.

## Components

**Buttons.** `button-primary` is the amber pill — dark text on ember, one per screen, for the advancing action ("Record answer"). Hover brightens to `primary-bright`; the focal CTA (final submit, "start diagnosis"-class moments) may use the one permitted gradient, `secondary → primary`, as in the reference's Mint button. `button-ghost` is a transparent pill with a 1px `outline` border and `on-surface` text for secondary actions ("Skip for now", "Reopen"); hover fills `surface-container-high`. Both are 44px for touch targets. **Inputs.** Fields sit on `surface-container` with an `outline-variant` hairline; focus swaps the border to `primary` and adds a soft ember outer ring — never a browser-default ring. Labels above in `label-sm` uppercase; help text below in `body-sm` `on-surface-variant`. Errors swap the border to `error` with the message in `error` (in a `error-container` panel when persistent). **Cards.** `card` is the workhorse (chips' container, stat blocks); `card-focal` is the centre question card — `xl` radius, 32px padding, the only element allowed the ember edge. **Chips.** The recorded-answer chip keeps its anatomy — question in `body-sm` `on-surface-variant`, answer in `body-md` `on-surface`, provenance line in `mono-sm` with the status dot (`success` solid = recorded fact, hollow `outline` ring = gap). Chips expand on press to reveal detail and the reopen form. **Status pills.** `status-pill` is the reference's tiny state row — uppercase `label-sm` with a 5px leading dot in `success`, `primary`, or `on-surface-variant` — used for system state ("32 / 37 core", "estimate", "gap").

## Do's and Don'ts

- **Do** keep the ember singular: one amber focal element per screen — the current action or the live data line, never both plus decoration.
- **Don't** ever ship crypto-casino artifacts: 3D coins, mascots, confetti, pulsing glows, or animated gradients. The reference's illustrations are explicitly excluded from this system.
- **Do** put every machine-truth string (provenance, field keys, costs, timestamps) in IBM Plex Mono `mono-sm` — it is the system's honesty channel.
- **Don't** use `secondary` blue for body-size text on dark or as a second action color; it lives in glows and the single gradient CTA only.
- **Do** respect the grid and the ten type styles absolutely — a new size or an off-grid nudge is a design bug, not a tweak.
- **Don't** use drop shadows anywhere; depth is tonal layers, hairlines, and light.
- **Do** keep gradients to exactly two uses: the focal CTA fill and the focal card's ember edge.
- **Don't** let the light variant become its own brand: it is the same system with glows removed and `primary-strong` substituted for raw amber.

// Idea 50: the microphone as drawn — absent where unsupported, a labelled
// toggle with aria-pressed, one aria-live line, never a submit button, and
// (2026-11-17) no sentence about who hears the audio: one press listens.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { MicButtonView, liveLine } from "./MicButton";

const base = {
  supported: true,
  phase: "idle" as const,
  message: null,
  label: "Speak your answer",
  onToggle: () => {},
};

const html = (props: Partial<Parameters<typeof MicButtonView>[0]>) =>
  renderToStaticMarkup(createElement(MicButtonView, { ...base, ...props }));

describe("MicButtonView", () => {
  it("draws nothing where the browser cannot recognise speech", () => {
    expect(html({ supported: false })).toBe("");
    expect(html({ supported: false, variant: "icon" })).toBe("");
  });

  it("is a labelled toggle that can never submit a form", () => {
    const out = html({});
    expect(out).toContain('type="button"');
    expect(out).toContain('aria-label="Speak your answer"');
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain("Speak</button>");
  });

  it("says Listening… while pressed, and nothing more", () => {
    const out = html({ phase: "listening" });
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain("Listening…");
    expect(out).not.toMatch(/Press Speak/);
  });

  // The owner, 2026-11-17: "the user doesn't necessarily need to know that".
  it("never prints who hears the audio: the privacy page says it", () => {
    for (const phase of ["idle", "checking", "listening"] as const) {
      for (const variant of ["icon", "button"] as const) {
        expect(html({ phase, variant })).not.toMatch(/Google|browser turns|never receives/);
      }
    }
    expect(Object.keys(en.voice)).not.toContain("notice");
    expect(Object.keys(en.voice)).not.toContain("noticeStart");
    expect(en.legal.privacy.speaking).toMatch(/never receives the audio/);
  });

  it("inside a composer it is an icon with a spoken name, and the live line stays", () => {
    const out = html({ variant: "icon" });
    expect(out).toContain('type="button"');
    expect(out).toContain('aria-label="Speak your answer"');
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain('aria-live="polite"');
    expect(out).not.toContain("Speak</button>"); // no word on the button itself
    expect(html({ variant: "icon", phase: "listening" })).toContain("Listening…");
  });

  it("is disabled while the box is busy", () => {
    expect(html({ disabled: true })).toContain("disabled");
    expect(html({ disabled: true, variant: "icon" })).toContain("disabled");
  });
});

describe("liveLine", () => {
  it("is silent while checking and repeats the last words when idle", () => {
    expect(liveLine({ phase: "checking", message: "x" })).toBeNull();
    expect(liveLine({ phase: "idle", message: "Stopped." })).toBe("Stopped.");
    expect(liveLine({ phase: "idle", message: null })).toBeNull();
  });
});

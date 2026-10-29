// Idea 50: the microphone as drawn — absent where unsupported, a labelled
// toggle with aria-pressed, one aria-live line, never a submit button.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NOTICE } from "../../lib/voice/session";
import { MicButtonView, liveLine } from "./MicButton";

const base = {
  supported: true,
  phase: "idle" as const,
  notice: null,
  message: null,
  label: "Speak your answer",
  onToggle: () => {},
};

const html = (props: Partial<Parameters<typeof MicButtonView>[0]>) =>
  renderToStaticMarkup(createElement(MicButtonView, { ...base, ...props }));

describe("MicButtonView", () => {
  it("draws nothing where the browser cannot recognise speech", () => {
    expect(html({ supported: false })).toBe("");
  });

  it("is a labelled toggle that can never submit a form", () => {
    const out = html({});
    expect(out).toContain('type="button"');
    expect(out).toContain('aria-label="Speak your answer"');
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain(">Speak</button>");
  });

  it("says Listening… while pressed", () => {
    const out = html({ phase: "listening" });
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain("Listening…");
  });

  it("shows the notice in the live line before the first listen, then as a fine line", () => {
    const first = html({ phase: "notice", notice: NOTICE });
    expect(first).toContain("SYB never receives the audio. Press Speak again to start.");
    const after = html({ phase: "listening", notice: NOTICE });
    expect(after).toContain('class="vx-notice"');
  });

  it("is disabled while the box is busy", () => {
    expect(html({ disabled: true })).toContain("disabled");
  });
});

describe("liveLine", () => {
  it("is silent while checking and repeats the last words when idle", () => {
    expect(liveLine({ phase: "checking", notice: null, message: "x" })).toBeNull();
    expect(liveLine({ phase: "idle", notice: null, message: "Stopped." })).toBe("Stopped.");
    expect(liveLine({ phase: "idle", notice: null, message: null })).toBeNull();
  });
});

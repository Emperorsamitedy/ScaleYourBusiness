import { describe, expect, it } from "vitest";
import type { KeyPress, KeyState } from "./shortcuts-model";
import { GO_KEYS, IDLE_KEYS, SEQUENCE_MS, isTyping, keyStep } from "./shortcuts-model";

const press = (key: string, over: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrl: false,
  meta: false,
  alt: false,
  typing: false,
  overlay: false,
  now: 1000,
  ...over,
});

describe("the keyboard's rules", () => {
  it("opens the palette on Ctrl+K and ⌘K from anywhere, even from a field", () => {
    expect(keyStep(IDLE_KEYS, press("k", { ctrl: true })).action).toEqual({ kind: "palette" });
    expect(keyStep(IDLE_KEYS, press("K", { meta: true, typing: true })).action).toEqual({
      kind: "palette",
    });
    expect(keyStep(IDLE_KEYS, press("k", { ctrl: true, overlay: true })).action).toEqual({
      kind: "palette",
    });
    expect(keyStep(IDLE_KEYS, press("k")).action).toBeNull(); // a bare k is just a letter
  });

  it("asks Lex on / and lists the shortcuts on ?", () => {
    expect(keyStep(IDLE_KEYS, press("/")).action).toEqual({ kind: "ask" });
    expect(keyStep(IDLE_KEYS, press("?")).action).toEqual({ kind: "help" });
  });

  it("goes to a main screen on g then its letter", () => {
    const g = keyStep(IDLE_KEYS, press("g"));
    expect(g.action).toBeNull();
    expect(g.state.pending).toBe(true);
    expect(keyStep(g.state, press("h", { now: 1400 }))).toEqual({
      state: IDLE_KEYS,
      action: { kind: "go", href: "/home" },
    });
    for (const [key, href] of Object.entries(GO_KEYS)) {
      expect(keyStep(g.state, press(key, { now: 1200 })).action).toEqual({ kind: "go", href });
    }
  });

  it("forgets g after a moment, and on a letter that goes nowhere", () => {
    const g: KeyState = { pending: true, at: 1000 };
    expect(keyStep(g, press("h", { now: 1000 + SEQUENCE_MS + 1 })).action).toBeNull();
    const miss = keyStep(g, press("z", { now: 1100 }));
    expect(miss).toEqual({ state: IDLE_KEYS, action: null });
  });

  it("never fires while typing, with a modifier held, or under an overlay", () => {
    expect(keyStep(IDLE_KEYS, press("/", { typing: true })).action).toBeNull();
    expect(keyStep(IDLE_KEYS, press("?", { overlay: true })).action).toBeNull();
    expect(keyStep(IDLE_KEYS, press("g", { alt: true })).state.pending).toBe(false);
    expect(keyStep({ pending: true, at: 1000 }, press("h", { ctrl: true })).action).toBeNull();
  });

  it("knows a field from the rest of the page", () => {
    expect(isTyping({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTyping({ tagName: "input" })).toBe(true);
    expect(isTyping({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTyping({ tagName: "BUTTON" })).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

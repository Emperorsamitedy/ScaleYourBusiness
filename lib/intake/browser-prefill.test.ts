// The sign-up's optional website, offered back in the intake as a draft.

import { describe, expect, it } from "vitest";
import { BROWSER_PREFILL, clearPrefill, prefillFor } from "./browser-prefill";

function fakeStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    removeItem: (k: string) => void m.delete(k),
    has: (k: string) => m.has(k),
  };
}

describe("browser prefill — the sign-up's website reaches the intake as a draft", () => {
  it("offers the waiting website for the website field, trimmed", () => {
    const s = fakeStore({ "syb.pending_store": "  fernhill.example  " });
    expect(prefillFor("presence.website_url", s)).toBe("fernhill.example");
  });

  it("offers nothing for any other field, an empty value, or no storage", () => {
    const s = fakeStore({ "syb.pending_store": "fernhill.example" });
    expect(prefillFor("identity.legal_name", s)).toBeNull();
    expect(prefillFor("presence.website_url", fakeStore({ "syb.pending_store": "  " }))).toBeNull();
    expect(prefillFor("presence.website_url", null)).toBeNull();
  });

  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(prefillFor("presence.website_url", broken)).toBeNull();
    expect(() => clearPrefill("presence.website_url", broken)).not.toThrow();
  });

  it("clears the draft once its question is answered", () => {
    const s = fakeStore({ "syb.pending_store": "fernhill.example" });
    clearPrefill("presence.website_url", s);
    expect(s.has("syb.pending_store")).toBe(false);
  });

  it("names only fields the bank actually has", async () => {
    const { readFileSync } = await import("node:fs");
    const bank = JSON.parse(readFileSync("specs/question-bank-v1.json", "utf8")) as {
      questions: { writes_to: string }[];
    };
    const keys = new Set(bank.questions.map((q) => q.writes_to));
    for (const field of Object.keys(BROWSER_PREFILL)) expect(keys.has(field), field).toBe(true);
  });
});

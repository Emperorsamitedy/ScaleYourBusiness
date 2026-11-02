// L-3b — the competitors screen's head, from the "competitors" catalogue:
// English word for word as the screen said it before, and the other
// languages' plural forms in place.

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import type { CompetitorsView } from "../../lib/competitors/view";
import { headline } from "./CompetitorsScreen";

function view(states: string[], matched: number, below: number): CompetitorsView {
  return {
    competitors: states.map((state) => ({ read: { state } })),
    summary: { matched, below },
  } as unknown as CompetitorsView;
}

describe("the competitors head (English unchanged)", () => {
  it("says each case as the screen always has", () => {
    expect(headline(view([], 0, 0))).toBe("You haven't listed any competitors yet.");
    expect(headline(view(["unread"], 0, 0))).toBe(
      "I'm watching 1 competitor, and haven't read their prices yet.",
    );
    expect(headline(view(["unread", "failed"], 0, 0))).toBe(
      "I'm watching 2 competitors, and haven't read their prices yet.",
    );
    expect(headline(view(["read", "unread", "partial"], 0, 0))).toBe(
      "I've read 2 of 3 competitors; none of their prices match an offer of yours yet.",
    );
    expect(headline(view(["read"], 1, 0))).toBe("None of 1 matched price is below yours.");
    expect(headline(view(["read"], 4, 0))).toBe("None of 4 matched prices is below yours.");
    expect(headline(view(["read"], 1, 1))).toBe("1 of 1 matched price is below yours.");
    expect(headline(view(["read"], 5, 2))).toBe("2 of 5 matched prices are below yours.");
  });

  it("takes another language's translator and locale", () => {
    // A translator passed in is the one used; the figures follow the locale.
    const t = createTranslator({ locale: "en", messages: en, namespace: "competitors" });
    const tr = (k: string, v?: Record<string, string | number>) =>
      (t as unknown as (k: string, v?: Record<string, string | number>) => string)(k, v);
    expect(headline(view(["read"], 5, 2), tr, "de-DE")).toBe(
      "2 of 5 matched prices are below yours.",
    );
  });
});

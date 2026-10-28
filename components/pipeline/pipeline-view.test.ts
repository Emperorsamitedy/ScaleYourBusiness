// P5-17 — the pipeline screen's words, pure.

import { describe, expect, it } from "vitest";
import { money as m } from "../../lib/core/money";
import type { Weighted, WinRate } from "../../lib/pipeline/maths";
import {
  followUpWord,
  pipelineHeadline,
  quietSentence,
  rateWords,
  staleWhy,
} from "./pipeline-view";

const closed = { won: 2, lost: 3, from: "2025-10-27", to: "2026-10-27" };

describe("P5-17 — the pipeline in words", () => {
  it("says how long a deal has been quiet, and from what", () => {
    expect(
      quietSentence("Café Nua", { days_in_stage: 30, days_quiet: 23, quiet_from: "last_contact" }),
    ).toBe("Nobody has spoken to Café Nua in 23 days");
    expect(
      quietSentence("Café Nua", { days_in_stage: 1, days_quiet: 1, quiet_from: "added" }),
    ).toBe("Nothing recorded with Café Nua since you added it, 1 day ago");
    expect(
      quietSentence("Café Nua", { days_in_stage: 0, days_quiet: 0, quiet_from: "last_contact" }),
    ).toBe("You spoke to Café Nua today");
  });

  it("says why a deal is stale", () => {
    expect(staleWhy({ why: "no_next_step" })).toBe("No next step");
    expect(staleWhy({ why: "overdue", due: "2026-10-20", days_over: 7 })).toBe(
      "Next step was due 20 Oct, 7 days ago",
    );
  });

  it("states the headline from the weighted range, or says it can't weigh yet", () => {
    const ok: Weighted = {
      ok: true,
      lines: [
        {
          currency: "EUR",
          deals: 3,
          open_total: m(4_200_000, "EUR"),
          low: m(840_000, "EUR"),
          high: m(1_680_000, "EUR"),
        },
      ],
      unvalued: 0,
      estimated: 0,
      basis: "stated",
      window: { from: closed.from, to: closed.to },
      sources: [],
      assumed: [],
    };
    expect(pipelineHeadline(3, ok)).toBe("€8,400–€16,800 of your €42,000 open is likely to close.");
    expect(
      pipelineHeadline(4, {
        ...ok,
        lines: [...ok.lines, { ...ok.lines[0]!, currency: "GBP" }],
      }),
    ).toMatch(/and more in 1 other currency\.$/);
    expect(
      pipelineHeadline(2, {
        ok: false,
        reason: "",
        can: [],
        cant: [],
        ready_when: "",
        unvalued: 0,
        open_totals: [m(900_000, "EUR")],
      }),
    ).toBe("2 open deals worth €9,000. I can't weigh them yet.");
    expect(pipelineHeadline(0, ok)).toBe("No open deals yet.");
  });

  it("puts the win rate in words with its basis", () => {
    const measured: WinRate = {
      basis: "measured",
      point: 0.4,
      low: 0.14,
      high: 0.73,
      closed,
      stated: null,
      assumed: [],
    };
    expect(rateWords(measured)).toBe("40% measured: 2 won of 5 closed, likely 14%–73%");
    expect(
      rateWords({
        basis: "stated",
        point: 0.25,
        low: 0.15,
        high: 0.35,
        closed,
        stated: 25,
        needed: 1,
        assumed: [],
      }),
    ).toBe("25% as you stated it, read as 15%–35%");
    expect(rateWords({ basis: "none", closed, needed: 5, reason: "" })).toBe("Not known yet");
  });

  it("words the follow-up's state", () => {
    expect(followUpWord({ status: "pending", draft: null, blocked_by_limit: null }).word).toBe(
      "waiting for you",
    );
    expect(followUpWord({ status: "approved", draft: null, blocked_by_limit: null }).word).toBe(
      "approved",
    );
    expect(followUpWord({ status: "approved", draft: {}, blocked_by_limit: null }).word).toBe(
      "drafted",
    );
    expect(followUpWord({ status: "blocked", draft: null, blocked_by_limit: "x" }).tone).toBe(
      "alarm",
    );
  });
});

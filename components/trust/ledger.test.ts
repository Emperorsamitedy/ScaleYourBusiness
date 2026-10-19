import { describe, expect, it } from "vitest";
import type { LedgerProposal } from "./ledger";
import { byDay, factRow, filterRows, parseTs, proposalRows, toCsv } from "./ledger";

const NOW = Date.parse("2026-10-17T14:00:00Z");

const proposal = (over: Partial<LedgerProposal> = {}): LedgerProposal => ({
  id: "f2333b52-29ec-40c2-849c-f56ddba2e4ca",
  status: "pending",
  module: "ads",
  created_at: "2026-10-17 10:20:35.419862+00",
  decided_at: null,
  expires_at: "2026-10-31 15:20:35.229+00",
  execute_not_before: null,
  rejection_reason: null,
  blocked_by_limit: null,
  action: { summary: "Pause the autumn campaign" },
  ...over,
});

describe("parseTs", () => {
  it("reads Postgres's space-and-short-offset form", () => {
    expect(parseTs("2026-10-17 15:20:35.268016+00")).toBe(Date.parse("2026-10-17T15:20:35.268Z"));
  });
  it("still reads ISO", () => {
    expect(parseTs("2026-10-17T15:20:35Z")).toBe(Date.parse("2026-10-17T15:20:35Z"));
  });
});

describe("proposalRows", () => {
  it("a pending proposal is one line, waiting for the owner", () => {
    const rows = proposalRows(proposal(), null, NOW);
    expect(rows.map((r) => r.kind)).toEqual(["proposed"]);
    expect(rows[0]?.note).toBe("waiting for you");
    expect(rows[0]?.ref).toBe("ads · f2333b52");
  });

  it("a declined proposal adds the owner's decision with their reason", () => {
    const rows = proposalRows(
      proposal({
        status: "rejected",
        decided_at: "2026-10-17 11:40:00+00",
        rejection_reason: "wrong timing",
      }),
      null,
      NOW,
    );
    expect(rows.map((r) => r.kind)).toEqual(["proposed", "declined"]);
    expect(rows[1]?.actor).toBe("you");
    expect(rows[1]?.detail).toBe("reason: wrong timing");
  });

  it("an expired proposal is not a decline — nobody answered and it never ran", () => {
    const rows = proposalRows(proposal({ status: "expired" }), null, NOW);
    expect(rows.map((r) => r.kind)).toEqual(["proposed", "expired"]);
    expect(rows[1]?.note).toBe("lapsed · never ran");
  });

  it("an executed one carries approval, the run (to the day) and the measured verdict", () => {
    const rows = proposalRows(
      proposal({ status: "executed", decided_at: "2026-10-01 18:31:00+00" }),
      {
        verdict: "backfired",
        arithmetic: "mean 90 vs 100",
        delta_pct: -10,
        executed_on: "2026-10-02",
      },
      NOW,
    );
    expect(rows.map((r) => r.kind)).toEqual(["proposed", "approved", "ran", "measured"]);
    expect(rows[2]?.timed).toBe(false);
    expect(rows[3]?.note).toBe("-10% · backfired");
    expect(rows[3]?.tone).toBe("alarm");
  });

  it("P3-23b: a post or campaign verdict says what it was judged on; a revenue one reads as before", () => {
    const executed = proposal({ status: "executed", decided_at: "2026-10-01 18:31:00+00" });
    const post = proposalRows(
      executed,
      {
        verdict: "helped",
        judged_on: "post",
        arithmetic: "on day 7 after posting: reach 150 against a median of 115 (+30.4%)",
        delta_pct: 30.4,
        executed_on: "2026-10-02",
      },
      NOW,
    ).find((r) => r.kind === "measured");
    expect(post?.note).toBe("+30.4% · helped");
    expect(post?.tone).toBe("ok");
    expect(post?.detail).toBe(
      "Judged on the post's own figures against your earlier posts: on day 7 after posting: reach 150 against a median of 115 (+30.4%)",
    );
    const campaign = proposalRows(
      executed,
      {
        verdict: "too_early",
        judged_on: "campaign",
        arithmetic: "3 measured day(s)",
        delta_pct: null,
        executed_on: "2026-10-02",
      },
      NOW,
    ).find((r) => r.kind === "measured");
    expect(campaign?.detail).toBe(
      "Judged on the campaign's own return on ad spend: 3 measured day(s)",
    );
    expect(campaign?.note).toBe("too early to say");
    const revenue = proposalRows(
      executed,
      {
        verdict: "did_nothing",
        judged_on: "revenue",
        arithmetic: "mean 100 vs 100",
        delta_pct: 0,
        executed_on: "2026-10-02",
      },
      NOW,
    ).find((r) => r.kind === "measured");
    expect(revenue?.detail).toBe("mean 100 vs 100");
  });

  it("an unmeasured outcome adds no measured line", () => {
    const rows = proposalRows(
      proposal({ status: "executed", decided_at: "2026-10-01 18:31:00+00" }),
      { verdict: "unmeasured", arithmetic: "", delta_pct: null, executed_on: null },
      NOW,
    );
    expect(rows.some((r) => r.kind === "measured")).toBe(false);
    expect(rows.some((r) => r.kind === "ran")).toBe(false);
  });

  it("a withheld proposal is only the withholding, with the limit it hit", () => {
    const rows = proposalRows(
      proposal({ status: "blocked", blocked_by_limit: "13.5: never discount below cost" }),
      null,
      NOW,
    );
    expect(rows.map((r) => r.kind)).toEqual(["withheld"]);
    expect(rows[0]?.detail).toBe("never discount below cost");
  });
});

describe("filters, grouping and CSV", () => {
  const rows = [
    ...proposalRows(
      proposal({ status: "rejected", decided_at: "2026-10-17 11:40:00+00" }),
      null,
      NOW,
    ),
    factRow({
      id: "0c1d2e3f-0000-0000-0000-000000000000",
      key: "operations.shipping_cost",
      label: "shipping cost",
      from: "8.9 EUR",
      to: "9.38 EUR",
      at: "2026-10-14 09:00:00+00",
      by: "connector",
    }),
  ];

  it("each tab holds only its kinds, newest first", () => {
    expect(filterRows(rows, "everything").map((r) => r.kind)).toEqual([
      "declined",
      "proposed",
      "superseded",
    ]);
    expect(filterRows(rows, "facts").map((r) => r.kind)).toEqual(["superseded"]);
    expect(filterRows(rows, "ran")).toEqual([]);
  });

  it("a superseded fact reads old → new and names its source", () => {
    const f = filterRows(rows, "facts")[0];
    expect(f?.title).toBe("shipping cost: 8.9 EUR → 9.38 EUR");
    expect(f?.actor).toBe("measured");
  });

  it("a structured value says it was updated rather than printing raw JSON", () => {
    const base = {
      id: "x",
      key: "presence.opening_schedule",
      label: "opening schedule",
      at: "2026-10-15 12:02:00+00",
      by: "inferred",
    };
    expect(factRow({ ...base, from: '{"days":{}}', to: '{"days":{"mon":[]}}' }).title).toBe(
      "opening schedule: updated",
    );
    expect(factRow({ ...base, from: "12", to: "12" }).title).toBe(
      "opening schedule: re-recorded, same value",
    );
    expect(factRow({ ...base, from: null, to: "12" }).title).toBe(
      "opening schedule: not known → 12",
    );
  });

  it("groups by day", () => {
    expect(byDay(filterRows(rows, "everything")).map((g) => g.rows.length)).toEqual([2, 1]);
  });

  it("exports exactly the rows given, quoting commas", () => {
    const csv = toCsv(filterRows(rows, "facts"));
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("when,kind,entry,reference,detail,by,note");
    expect(lines[1]).toContain("superseded,shipping cost: 8.9 EUR → 9.38 EUR");
    expect(toCsv([{ ...rows[0]!, title: 'a, "b"' }])).toContain('"a, ""b"""');
  });
});

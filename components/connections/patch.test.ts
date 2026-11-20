import { describe, expect, it } from "vitest";
import { CN_TABS, gives, headline, lastRead, tabCounts, tabFromSearch } from "./patch";

describe("gives", () => {
  it("takes each scope's subject from the registry's own words", () => {
    expect(
      gives([
        { why: "Your orders, which is where daily revenue, order count and units sold come from." },
        { why: "Your product list, so each product can be matched to what you sell." },
        { why: "Orders older than 60 days, for a full year of history. Without it I read 60." },
      ]),
    ).toBe("Your orders, your product list, orders older than 60 days");
  });
  it("drops repeats and empty lines", () => {
    expect(gives([{ why: "Your orders." }, { why: "your orders, again" }, { why: "" }])).toBe(
      "Your orders",
    );
  });
});

describe("headline", () => {
  it("counts only sources that are actually reading", () => {
    expect(
      headline([{ status: "connected" }, { status: "connected" }, { status: "failed" }], []),
    ).toBe("2 sources read. Nothing can be written.");
    expect(headline([{ status: "connected" }], [])).toBe("1 source read. Nothing can be written.");
  });
  it("says when nothing is reading, and when nothing is plugged in", () => {
    expect(headline([{ status: "failed" }], [])).toBe(
      "Nothing is reading right now. Nothing can be written.",
    );
    expect(headline([], [])).toBe("Nothing is plugged in yet. Nothing can be written.");
  });
  it("never hides a write connection", () => {
    expect(
      headline([{ status: "connected" }], [{ status: "failed", label: "Meta publishing" }]),
    ).toBe("1 source read. Meta publishing can write: only what you approve.");
    expect(
      headline([{ status: "connected" }], [{ status: "disconnected", label: "Meta publishing" }]),
    ).toBe("1 source read. Nothing can be written.");
  });
  it("I-45a: a consent held only to read says so, and never hides a real write beside it", () => {
    const google = {
      status: "connected" as const,
      label: "Google Business Profile reviews",
      provider: "google_business_reviews",
    };
    expect(headline([], [google])).toBe(
      "Nothing is plugged in yet. Google Business Profile reviews holds a permission that could write; ScaleX only reads with it.",
    );
    expect(
      headline(
        [],
        [google, { status: "connected", label: "Meta publishing", provider: "meta_publish" }],
      ),
    ).toBe(
      "Nothing is plugged in yet. Meta publishing can write: only what you approve. Google Business Profile reviews holds a permission that could write; ScaleX only reads with it.",
    );
    expect(headline([], [{ ...google, status: "disconnected" }])).toBe(
      "Nothing is plugged in yet. Nothing can be written.",
    );
  });
  it("doesn't claim nothing can write when the write side is unknown", () => {
    expect(headline([{ status: "connected" }], null)).toBe(
      "1 source read. Write access couldn't be read.",
    );
  });
});

describe("lastRead", () => {
  it("prints the time today, the day before, a dash for never", () => {
    const at = "2026-10-17T12:00:00Z";
    expect(lastRead(at, Date.parse(at))).toMatch(/^\d\d:\d\d$/);
    expect(lastRead("2026-10-09 12:00:00+00", Date.parse(at))).toBe("9 Oct");
    expect(lastRead(null, Date.parse(at))).toBe("-");
  });
});

// L6: the screen in three parts (what is read, the owner's own files, what may be changed).
describe("the part of the screen an address opens on", () => {
  it("is the first when the address says nothing", () => {
    expect(tabFromSearch("")).toBeNull();
    expect(tabFromSearch("?connected=shopify")).toBeNull(); // a source being read is the first part
  });

  it("is the one the address names, and only one of the three", () => {
    for (const tab of CN_TABS) expect(tabFromSearch(`?tab=${tab}`)).toBe(tab);
    expect(tabFromSearch("?tab=everything")).toBeNull();
    expect(tabFromSearch("?tab=")).toBeNull();
  });

  it("is the last when a sign-in for a permission to change comes back", () => {
    expect(tabFromSearch("?meta=pick&provider=meta_publish")).toBe("write");
    expect(tabFromSearch("?google=connected")).toBe("write");
    expect(tabFromSearch("?gads=error&reason=denied")).toBe("write");
    expect(tabFromSearch("?tiktok=cancelled")).toBe("write");
    expect(tabFromSearch("?tiktokads=connected")).toBe("write");
    // The address's own word wins over a return it also carries.
    expect(tabFromSearch("?tab=read&meta=pick")).toBe("read");
    // A reason alone is nobody's return.
    expect(tabFromSearch("?reason=denied")).toBeNull();
  });
});

describe("the counts on the parts", () => {
  it("counts what is being read now, never what is stalled or gone", () => {
    expect(
      tabCounts(
        [
          { status: "connected" },
          { status: "connected" },
          { status: "failed" },
          { status: "paused" },
        ],
        [],
      ),
    ).toEqual({ read: 2, write: 0 });
  });

  it("counts a permission to change that is held, and not one held only to read", () => {
    const meta = {
      status: "connected" as const,
      label: "Meta publishing",
      provider: "meta_publish",
    };
    const reviews = {
      status: "connected" as const,
      label: "Google Business Profile reviews",
      provider: "google_business_reviews",
    };
    expect(tabCounts([], [meta, reviews])).toEqual({ read: 0, write: 1 });
    expect(tabCounts([], [{ ...meta, status: "failed" }])).toEqual({ read: 0, write: 1 }); // the token is still held
    expect(tabCounts([], [{ ...meta, status: "disconnected" }])).toEqual({ read: 0, write: 0 });
  });

  it("says nothing it does not know: an unread write side counts as none", () => {
    expect(tabCounts([{ status: "connected" }], null)).toEqual({ read: 1, write: 0 });
  });
});

import { describe, expect, it } from "vitest";
import { gives, headline, lastRead } from "./patch";

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
    ).toBe("1 source read. Meta publishing can write — only what you approve.");
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
      "Nothing is plugged in yet. Google Business Profile reviews holds a permission that could write; SYB only reads with it.",
    );
    expect(
      headline(
        [],
        [google, { status: "connected", label: "Meta publishing", provider: "meta_publish" }],
      ),
    ).toBe(
      "Nothing is plugged in yet. Meta publishing can write — only what you approve. Google Business Profile reviews holds a permission that could write; SYB only reads with it.",
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
    expect(lastRead(null, Date.parse(at))).toBe("—");
  });
});

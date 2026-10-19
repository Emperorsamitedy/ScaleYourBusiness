// P4-15 — the law review, recorded. The table's identity is a canonical
// hash, so any edit voids the review; a review is a row plus a no-PII
// decision-log entry; and a review can only vouch for the table its
// reviewer was shown.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { decisionLog, jurisdictionReviews } from "../../db/schema";
import { REGIMES } from "./jurisdiction";
import {
  SYSTEM_PROFILE_ID,
  canonicalTable,
  hashLawReview,
  jurisdictionTableHash,
  latestLawReview,
  lawReviewVerdict,
  recordLawReview,
} from "./law-review";

const recorded: string[] = [];

afterAll(async () => {
  // The decision-log rows stay (rule 7); the review rows were the test's own.
  if (recorded.length > 0) {
    await db.delete(jurisdictionReviews).where(inArray(jurisdictionReviews.id, recorded));
  }
});

describe("P4-15 — the table's identity", () => {
  it("is a stable sha256, independent of key order", () => {
    const hash = jurisdictionTableHash();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(jurisdictionTableHash()).toBe(hash);
    // The same table with its keys in another order is the same table.
    const reordered = Object.fromEntries(
      Object.entries(REGIMES)
        .reverse()
        .map(([id, r]) => [id, Object.fromEntries(Object.entries(r).reverse())]),
    ) as typeof REGIMES;
    expect(jurisdictionTableHash(reordered)).toBe(hash);
    expect(canonicalTable(reordered)).toBe(canonicalTable());
  });

  it("any edit — a deadline, a country, a source — is a different table", () => {
    const hash = jurisdictionTableHash();
    const deadline = {
      ...REGIMES,
      au_spam_act: { ...REGIMES.au_spam_act, honour_unsubscribe_business_days: 10 },
    };
    const country = { ...REGIMES, uk_pecr: { ...REGIMES.uk_pecr, countries: ["GB", "IM"] } };
    const source = { ...REGIMES, us_can_spam: { ...REGIMES.us_can_spam, source: "edited" } };
    for (const t of [deadline, country, source]) expect(jurisdictionTableHash(t)).not.toBe(hash);
  });
});

describe("P4-15 — the verdict", () => {
  const now = jurisdictionTableHash();
  it("missing, stale and current, in words", () => {
    expect(lawReviewVerdict(null, now)).toMatchObject({ state: "missing", reviewed_on: null });
    expect(lawReviewVerdict(null, now).words).toMatch(/^Nobody has reviewed/);
    const stale = lawReviewVerdict(
      { table_sha256: "0".repeat(64), reviewed_on: "2026-10-01" },
      now,
    );
    expect(stale).toMatchObject({ state: "stale", reviewed_on: "2026-10-01" });
    expect(stale.words).toMatch(/changed after their last review \(2026-10-01\)/);
    expect(lawReviewVerdict({ table_sha256: now, reviewed_on: "2026-10-18" }, now)).toMatchObject({
      state: "current",
      words: "The email-law rules were reviewed against current law on 2026-10-18.",
    });
  });
});

describe("P4-15 — recording a review", () => {
  it("stores the row and a decision-log entry holding the hash only; it becomes the latest", async () => {
    const row = await recordLawReview({
      reviewer: "Dr. Test Reviewer",
      reviewedOn: "2026-10-18",
      tableSha256: jurisdictionTableHash(),
      note: "checked against the four statutes' current texts",
    });
    recorded.push(row.id);
    expect(row).toMatchObject({
      reviewer: "Dr. Test Reviewer",
      table_sha256: jurisdictionTableHash(),
    });
    expect((await latestLawReview())?.id).toBe(row.id);
    const [entry] = await db.select().from(decisionLog).where(eq(decisionLog.ref_id, row.id));
    expect(entry).toMatchObject({
      profile_id: SYSTEM_PROFILE_ID,
      actor: "system",
      kind: "law_review",
      payload_hash: hashLawReview(row),
    });
    expect(JSON.stringify(entry)).not.toContain("Reviewer");
  });

  it("refuses a hash that isn't the table as it is now — nobody read that table", async () => {
    await expect(
      recordLawReview({
        reviewer: "A Person",
        reviewedOn: "2026-10-18",
        tableSha256: "a".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a nameless reviewer, a malformed day and a future day", async () => {
    const tableSha256 = jurisdictionTableHash();
    await expect(
      recordLawReview({ reviewer: "  ", reviewedOn: "2026-10-18", tableSha256 }),
    ).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      recordLawReview({ reviewer: "A", reviewedOn: "18/10/2026", tableSha256 }),
    ).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      recordLawReview({
        reviewer: "A",
        reviewedOn: "2026-10-20",
        tableSha256,
        now: new Date("2026-10-19T12:00:00Z"),
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("P4-15 — the /ops door", () => {
  const post = async (fields: Record<string, string>) => {
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../../app/api/ops/law-review/route");
    const body = new URLSearchParams(fields);
    return POST(
      new NextRequest("https://syb.test/api/ops/law-review", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      }),
    );
  };

  it("a wrong key answers like a missing route and records nothing", async () => {
    const saved = process.env.OPS_KEY;
    process.env.OPS_KEY = "ops-test-key";
    try {
      const before = await latestLawReview();
      const res = await post({
        key: "wrong",
        reviewer: "A Person",
        reviewed_on: "2026-10-18",
        table_sha256: jurisdictionTableHash(),
      });
      expect(res.status).toBe(404);
      expect((await latestLawReview())?.id).toBe(before?.id);
    } finally {
      if (saved === undefined) delete process.env.OPS_KEY;
      else process.env.OPS_KEY = saved;
    }
  });

  it("the right key records it and goes back to /ops, saying so", async () => {
    const saved = process.env.OPS_KEY;
    process.env.OPS_KEY = "ops-test-key";
    try {
      const res = await post({
        key: "ops-test-key",
        reviewer: "Ops Door Reviewer",
        reviewed_on: "2026-10-18",
        table_sha256: jurisdictionTableHash(),
      });
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toContain("law_review=recorded");
      const latest = await latestLawReview();
      expect(latest?.reviewer).toBe("Ops Door Reviewer");
      if (latest) recorded.push(latest.id);
      const stale = await post({
        key: "ops-test-key",
        reviewer: "Ops Door Reviewer",
        reviewed_on: "2026-10-18",
        table_sha256: "b".repeat(64),
      });
      expect(stale.headers.get("location")).toContain("law_review=the+email-law+table+changed");
    } finally {
      if (saved === undefined) delete process.env.OPS_KEY;
      else process.env.OPS_KEY = saved;
    }
  });
});

// A suppression must match for ever (rule 23), so its key can't move when
// someone sets the "optional" COOKIE_SECRET later. These tests hold the
// stable key to that, and prove a suppression written while COOKIE_SECRET
// was set — or as a plain sha256 before 2026-10-17 — still matches on both
// sides of the rule-21 line.

import "dotenv/config";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, contactSuppressions } from "../../db/schema";
import { cookieEraKey, stableKey } from "../core/derived-key";
import { suppressionFor, suppressionHash } from "../support/support-contact";
import { emailHash, emailHashCandidates, isSuppressed } from "./contacts";

const LABEL = "syb-suppression-v1";
const savedCookie = process.env.COOKIE_SECRET;
const createdAccounts: string[] = [];

afterEach(() => {
  if (savedCookie === undefined) delete process.env.COOKIE_SECRET;
  else process.env.COOKIE_SECRET = savedCookie;
});

afterAll(async () => {
  for (const id of createdAccounts) {
    await db.delete(contactSuppressions).where(eq(contactSuppressions.account_id, id));
    await db.delete(accounts).where(eq(accounts.id, id));
  }
});

function hmacUnder(material: string, email: string): string {
  const key = Buffer.from(
    hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.alloc(0), LABEL, 32),
  );
  return `h1:${createHmac("sha256", key).update(email.trim().toLowerCase()).digest("hex")}`;
}

async function freshAccount(): Promise<string> {
  const [row] = await db
    .insert(accounts)
    .values({ reporting_currency: "EUR", locale: "en-IE" })
    .returning({ id: accounts.id });
  createdAccounts.push(row!.id);
  return row!.id;
}

describe("the suppression key never moves", () => {
  it("is byte-for-byte what rows were written with while COOKIE_SECRET is unset", () => {
    delete process.env.COOKIE_SECRET;
    const connector = process.env.CONNECTOR_KEY!;
    expect(emailHash(" Ann@Example.com ")).toBe(hmacUnder(connector, "ann@example.com"));
    expect(cookieEraKey(LABEL)).toBeNull();
  });

  it("doesn't change when COOKIE_SECRET is set later", () => {
    delete process.env.COOKIE_SECRET;
    const before = emailHash("ann@example.com");
    process.env.COOKIE_SECRET = "a-later-cookie-secret-that-is-long-enough-0001";
    expect(emailHash("ann@example.com")).toBe(before);
    expect(stableKey(LABEL).equals(stableKey(LABEL))).toBe(true);
  });

  it("matches every stored form: current, COOKIE_SECRET-era, and pre-2026-10-17 sha256", () => {
    process.env.COOKIE_SECRET = "a-later-cookie-secret-that-is-long-enough-0002";
    const forms = emailHashCandidates("Ann@Example.com");
    expect(forms).toEqual([
      emailHash("ann@example.com"),
      hmacUnder(process.env.COOKIE_SECRET, "ann@example.com"),
      createHash("sha256").update("ann@example.com").digest("hex"),
    ]);
    delete process.env.COOKIE_SECRET;
    expect(emailHashCandidates("ann@example.com")).toHaveLength(2);
  });

  it("keeps the support tier's hash identical to lib/crm's", () => {
    process.env.COOKIE_SECRET = "a-later-cookie-secret-that-is-long-enough-0003";
    expect(suppressionHash("Ann@Example.com")).toBe(emailHash("ann@example.com"));
  });
});

describe("a suppression written while COOKIE_SECRET was set still holds", () => {
  it("is found by the CRM gate and by the support tier", async () => {
    const accountId = await freshAccount();
    const cookie = "the-cookie-secret-in-force-back-then-0000000004";
    await db.insert(contactSuppressions).values({
      account_id: accountId,
      email_hash: hmacUnder(cookie, "gone@example.com"),
      reason: "unsubscribed",
    });

    process.env.COOKIE_SECRET = cookie;
    expect(await isSuppressed(accountId, "Gone@Example.com")).toBe("unsubscribed");
    expect(await suppressionFor(accountId, "gone@example.com")).toBe("unsubscribed");

    // And the negative: with no COOKIE_SECRET that era's key can't be rebuilt,
    // so only current and pre-2026-10-17 forms are tried.
    delete process.env.COOKIE_SECRET;
    expect(await isSuppressed(accountId, "gone@example.com")).toBeNull();
  });

  it("still matches a plain sha256 from before 2026-10-17", async () => {
    const accountId = await freshAccount();
    await db.insert(contactSuppressions).values({
      account_id: accountId,
      email_hash: createHash("sha256").update("old@example.com").digest("hex"),
      reason: "erasure",
    });
    expect(await isSuppressed(accountId, "OLD@example.com")).toBe("erasure");
    expect(await suppressionFor(accountId, "old@example.com")).toBe("erasure");
  });
});

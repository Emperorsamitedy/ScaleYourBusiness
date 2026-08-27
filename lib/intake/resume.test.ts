// Phase 1 Session D — P1-61. A resume link is the only thing standing
// between an owner who stops halfway and twenty minutes of lost answers,
// so its failure modes get tested harder than its happy path.

import "dotenv/config";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, resumeTokens } from "../../db/schema";
import {
  emailForProfile,
  issueResumeLink,
  normaliseEmail,
  RESUME_TTL_DAYS,
  ResumeError,
  resolveResumeToken,
  resumeUrl,
  revokeResumeToken,
} from "./resume";

const accountIds: string[] = [];
const profileIds: string[] = [];
let profileId: string;

async function freshProfile(): Promise<string> {
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "HUF", locale: "hu-HU" })
    .returning();
  if (!account) throw new Error("account insert failed");
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account.id, schema_version: "1.0.0" })
    .returning();
  if (!profile) throw new Error("profile insert failed");
  accountIds.push(account.id);
  profileIds.push(profile.id);
  return profile.id;
}

beforeEach(async () => {
  profileId = await freshProfile();
});

afterAll(async () => {
  for (const id of profileIds) {
    await db.delete(resumeTokens).where(eq(resumeTokens.profile_id, id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, id));
  }
  for (const id of accountIds) await db.delete(accounts).where(eq(accounts.id, id));
});

describe("email handling", () => {
  it("normalises case and whitespace", () => {
    expect(normaliseEmail("  Eszter@Szorp.HU ")).toBe("eszter@szorp.hu");
  });

  it("rejects what is plainly not an address", () => {
    for (const bad of ["", "eszter", "eszter@", "@szorp.hu", "a b@c.hu"]) {
      expect(() => normaliseEmail(bad)).toThrow(ResumeError);
    }
  });
});

describe("P1-57 — the link opens the right profile, anywhere", () => {
  it("round-trips a token back to its profile", async () => {
    const link = await issueResumeLink(profileId, "Eszter@Szorp.hu");
    const resolved = await resolveResumeToken(link.token);

    expect(resolved.profile_id).toBe(profileId);
    expect(resolved.email).toBe("eszter@szorp.hu");
    expect(Date.parse(link.expires_at)).toBeGreaterThan(Date.now());
  });

  it("stores only the hash — a leaked row cannot be replayed", async () => {
    const link = await issueResumeLink(profileId, "eszter@szorp.hu");
    const [row] = await db
      .select()
      .from(resumeTokens)
      .where(eq(resumeTokens.profile_id, profileId));

    expect(row?.token_hash).not.toBe(link.token);
    expect(row?.token_hash).toBe(createHash("sha256").update(link.token).digest("hex"));
    // Nothing in the row equals the secret.
    expect(JSON.stringify(row)).not.toContain(link.token);
  });

  it("records when it was last used, without breaking the link", async () => {
    const link = await issueResumeLink(profileId, "eszter@szorp.hu");
    await resolveResumeToken(link.token);
    const [first] = await db
      .select()
      .from(resumeTokens)
      .where(eq(resumeTokens.profile_id, profileId));
    expect(first?.last_used_at).not.toBeNull();

    // Reusable — an owner may open it on the phone and again on a laptop.
    const again = await resolveResumeToken(link.token);
    expect(again.profile_id).toBe(profileId);
  });

  it("issues a second link without breaking the first", async () => {
    const a = await issueResumeLink(profileId, "eszter@szorp.hu");
    const b = await issueResumeLink(profileId, "eszter@szorp.hu");
    expect(a.token).not.toBe(b.token);
    expect((await resolveResumeToken(a.token)).profile_id).toBe(profileId);
    expect((await resolveResumeToken(b.token)).profile_id).toBe(profileId);
  });

  it("keeps two owners' links apart", async () => {
    const mine = await issueResumeLink(profileId, "eszter@szorp.hu");
    const otherProfile = await freshProfile();
    const theirs = await issueResumeLink(otherProfile, "marton@fenyes.hu");

    expect((await resolveResumeToken(mine.token)).profile_id).toBe(profileId);
    expect((await resolveResumeToken(theirs.token)).profile_id).toBe(otherProfile);
  });
});

describe("P1-61 — the ways a link stops working", () => {
  it("refuses an unknown token, a short one, and junk — all the same answer", async () => {
    for (const bad of ["", "abc", "x".repeat(43)]) {
      await expect(resolveResumeToken(bad)).rejects.toThrow(ResumeError);
    }
  });

  it("refuses an expired link", async () => {
    const link = await issueResumeLink(profileId, "eszter@szorp.hu");
    await db
      .update(resumeTokens)
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where(eq(resumeTokens.profile_id, profileId));

    await expect(resolveResumeToken(link.token)).rejects.toThrow(/expired|no longer valid/);
  });

  it("refuses a revoked link but keeps the row", async () => {
    const link = await issueResumeLink(profileId, "eszter@szorp.hu");
    await revokeResumeToken(link.token);

    await expect(resolveResumeToken(link.token)).rejects.toThrow(ResumeError);
    const rows = await db
      .select()
      .from(resumeTokens)
      .where(eq(resumeTokens.profile_id, profileId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revoked_at).not.toBeNull();
  });

  it("refuses to issue a link for a profile that does not exist", async () => {
    await expect(issueResumeLink(crypto.randomUUID(), "eszter@szorp.hu")).rejects.toThrow(
      /no such profile/,
    );
  });

  it("defaults to a thirty-day life", async () => {
    const link = await issueResumeLink(profileId, "eszter@szorp.hu");
    const days = (Date.parse(link.expires_at) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(RESUME_TTL_DAYS - 1);
    expect(days).toBeLessThanOrEqual(RESUME_TTL_DAYS);
  });
});

describe("helpers the finish screen needs", () => {
  it("remembers the most recent address for a profile", async () => {
    expect(await emailForProfile(profileId)).toBeNull();
    await issueResumeLink(profileId, "first@szorp.hu");
    await new Promise((r) => setTimeout(r, 5));
    await issueResumeLink(profileId, "second@szorp.hu");
    expect(await emailForProfile(profileId)).toBe("second@szorp.hu");
  });

  it("builds the link without doubling the slash", () => {
    expect(resumeUrl("https://syb-kappa.vercel.app/", "abc")).toBe(
      "https://syb-kappa.vercel.app/resume/abc",
    );
  });
});

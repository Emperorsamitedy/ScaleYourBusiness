// Idea 51 — shareable report links. The claims: the token is unguessable
// and only its hash is stored; a link expires when the owner said and stops
// the moment it is revoked; every dead link — unknown, malformed, revoked,
// expired — gets the SAME page; creating and revoking land in the
// append-only decision log; and what a reader sees carries no owner email,
// no customer contact, no personal field, none of the owner's answers to
// the recommendations, and no link into the account.

import "dotenv/config";
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { NextIntlClientProvider } from "next-intl";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import en from "../../messages/en.json";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Route tests: no request scope in a test, so cookies come from this jar.
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: () => {},
  }),
}));

import { db } from "../../db";
import {
  accounts,
  authSessions,
  businessProfiles,
  contacts,
  decisionLog,
  diagnosisReports,
  fieldRecords,
  offers,
  profileSnapshots,
  reportShares,
  snapshotRecords,
  users,
} from "../../db/schema";
import SharedReportPage from "../../app/shared/[token]/page";
import { AUTH_COOKIE, INTAKE_COOKIE, signProfileCookie } from "../auth/access";
import { signInWithEmail } from "../auth/sign-in";
import { loadBank } from "../bank/loader";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import { ensureSnapshot } from "../profile/snapshot";
import {
  SHARE_TOKEN_RE,
  ShareError,
  createShare,
  isPersonalKey,
  listShares,
  resolveShare,
  revokeShare,
  shareStatus,
  shareTokenHash,
  viewSharedReport,
} from "./share";

// The setup and teardown write and delete across many tables; under a full
// suite's load on one shared Postgres they have been seen to pass 10 s.
const HOOK_TIMEOUT_MS = 60_000;
const stamp = Date.now();
const ownerEmail = `share-owner-${stamp}@example.test`;
const customerEmail = `share-customer-${stamp}@example.test`;
const ADDRESS = "Fő utca 12, 1011 Budapest";
const SECRET_REASON = "my brother-in-law runs the competitor";

let accountId: string;
let profileId: string;
let otherAccountId: string;
let otherProfileId: string;
let offerId: string;
let reportId: string;
let userId: string;
let sessionToken: string;

const write = (pid: string, key: string, value: unknown) =>
  writeField(
    pid,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: isoDateTime(new Date().toISOString()),
      recorded_at: isoDateTime(new Date().toISOString()),
    }),
  );

beforeAll(async () => {
  await loadBank("specs/question-bank-v1.json");
  const [a] = await db
    .insert(accounts)
    .values({ reporting_currency: "HUF", locale: "hu-HU" })
    .returning();
  const [p] = await db
    .insert(businessProfiles)
    .values({ account_id: a!.id, schema_version: "1.0.0" })
    .returning();
  const [b] = await db.insert(accounts).values({ reporting_currency: "EUR" }).returning();
  const [q] = await db
    .insert(businessProfiles)
    .values({ account_id: b!.id, schema_version: "1.0.0" })
    .returning();
  accountId = a!.id;
  profileId = p!.id;
  otherAccountId = b!.id;
  otherProfileId = q!.id;

  const [o] = await db
    .insert(offers)
    .values({ profile_id: profileId, kind: "physical" })
    .returning();
  offerId = o!.id;
  await write(profileId, "identity.legal_name", "Szörp Kft.");
  await write(profileId, `offers.${offerId}.name`, "Szörp 0.5L");
  await write(profileId, `offers.${offerId}.price`, { amount_minor: 450_000, currency: "HUF" });
  // A first price, then a correction: the correction is history the link may show.
  await write(profileId, `offers.${offerId}.price`, { amount_minor: 499_000, currency: "HUF" });
  await write(profileId, "legal.postal_address", ADDRESS);
  await write(profileId, "operations.common_complaints", "never cited by the report");

  // A customer of this business, in the CRM — a shared report never reads it.
  await db.insert(contacts).values({
    account_id: accountId,
    email: customerEmail,
    name: "Kovács Anna",
    consent_source: "test",
  });

  const snapshot = await ensureSnapshot(profileId, "report");
  const [r] = await db
    .insert(diagnosisReports)
    .values({
      profile_id: profileId,
      snapshot_id: snapshot.id,
      summary: "Your margin is thin. Fix the price first.",
      completeness: "0.6",
      cost_eur: "0.12",
      unit_economics: {
        currency: "HUF",
        offers: [],
        blended_margin_pct: null,
        break_even: null,
        fixed_costs_monthly: null,
        stated_vs_computed_margin: null,
        refusals: [],
      },
      findings: [
        {
          area: "finance",
          title: "Thin margin on the 0.5L",
          detail: "Price and cost sit close.",
          // The model cited the address: the reader still never sees it.
          evidence: [`offers.${offerId}.price`, "legal.postal_address"],
          severity: "high",
          confidence: 0.8,
        },
      ],
      recommendations: [
        {
          addresses: [0],
          title: "Test a 12% price rise",
          rationale: "Loyal buyers.",
          effort: "low",
          reversibility: { level: "easy", if_you_change_your_mind: "Set it back." },
          sensitivity_callouts: [],
          scenario: {
            assumptions: [],
            base_case: { case: "base", statement: "More profit.", formula: null },
            downside_case: { case: "downside", statement: "Less.", formula: null },
            upside_case: { case: "upside", statement: "Most.", formula: null },
            breakeven_condition: "sales can fall 10%",
          },
          status: "rejected",
          rejection_reason: SECRET_REASON,
        },
      ],
      data_gaps: [
        {
          question_id: "4.1a",
          prompt: "Monthly revenue?",
          section: "revenue",
          priority: "core",
          buys: "x",
          blocking: true,
        },
      ],
    })
    .returning();
  reportId = r!.id;

  const session = await signInWithEmail(ownerEmail, profileId);
  userId = session.user_id;
  sessionToken = session.session_token;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  // decision_log rows stay — append-only by trigger, and that is the feature.
  await db
    .delete(reportShares)
    .where(inArray(reportShares.account_id, [accountId, otherAccountId]));
  await db.delete(diagnosisReports).where(eq(diagnosisReports.profile_id, profileId));
  const snaps = await db
    .select({ id: profileSnapshots.id })
    .from(profileSnapshots)
    .where(eq(profileSnapshots.profile_id, profileId));
  for (const s of snaps) {
    await db.delete(snapshotRecords).where(eq(snapshotRecords.snapshot_id, s.id));
  }
  await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, profileId));
  await db.delete(contacts).where(eq(contacts.account_id, accountId));
  await db.delete(authSessions).where(eq(authSessions.user_id, userId));
  await db
    .update(accounts)
    .set({ owner_user_id: null })
    .where(inArray(accounts.id, [accountId, otherAccountId]));
  await db.delete(users).where(eq(users.id, userId));
  await db
    .delete(fieldRecords)
    .where(inArray(fieldRecords.profile_id, [profileId, otherProfileId]));
  await db.delete(offers).where(eq(offers.profile_id, profileId));
  await db
    .delete(businessProfiles)
    .where(inArray(businessProfiles.id, [profileId, otherProfileId]));
  await db.delete(accounts).where(inArray(accounts.id, [accountId, otherAccountId]));
}, HOOK_TIMEOUT_MS);

const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

/**
 * The page as the app renders it: inside the root layout's message
 * provider (app/layout.tsx), which the report body's words come from (L-3a).
 */
async function deadPage(token: string): Promise<string> {
  const page = await SharedReportPage({ params: Promise.resolve({ token }) });
  return renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      locale: "en",
      messages: en,
      timeZone: "UTC",
      children: page,
    }),
  );
}

describe("pure rules", () => {
  it("revoked beats expired, and expiry is exact to the instant", () => {
    const now = new Date("2026-10-26T12:00:00.000Z");
    expect(shareStatus({ expires_at: "2026-10-26T12:00:00.001Z", revoked_at: null }, now)).toBe(
      "active",
    );
    expect(shareStatus({ expires_at: "2026-10-26T12:00:00.000Z", revoked_at: null }, now)).toBe(
      "expired",
    );
    expect(
      shareStatus({ expires_at: "2026-10-01T00:00:00Z", revoked_at: "2026-09-30T00:00:00Z" }, now),
    ).toBe("revoked");
  });

  it("personal keys are caught as scalars and as entity fields; business facts are not", () => {
    expect(isPersonalKey("legal.postal_address")).toBe(true);
    expect(isPersonalKey("marketing.brand.public_face")).toBe(true);
    expect(isPersonalKey("suppliers.3c941b9e-a4e2-48ad-8e6a-4f22ff2b20ee.email")).toBe(true);
    expect(isPersonalKey("offers.3c941b9e-a4e2-48ad-8e6a-4f22ff2b20ee.price")).toBe(false);
    expect(isPersonalKey("customers.has_contact_database")).toBe(false);
    expect(isPersonalKey("identity.legal_name")).toBe(false);
  });
});

describe("create, verify, expire, revoke", () => {
  it("create: a 43-character token, only its sha256 stored, and a decision-log entry", async () => {
    const log = quiet();
    try {
      const { token, share } = await createShare({ accountId, profileId, userId });
      expect(token).toMatch(SHARE_TOKEN_RE);
      const [row] = await db.select().from(reportShares).where(eq(reportShares.id, share.id));
      expect(row!.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
      expect(JSON.stringify(row)).not.toContain(token);
      expect(row!.report_id).toBe(reportId);
      // Default: seven days.
      const ms = new Date(row!.expires_at).getTime() - new Date(row!.created_at).getTime();
      expect(ms).toBe(7 * 86_400_000);
      const entries = await db
        .select()
        .from(decisionLog)
        .where(and(eq(decisionLog.ref_id, share.id), eq(decisionLog.kind, "report_share")));
      expect(entries).toHaveLength(1);
      expect(entries[0]!.actor).toBe("owner");
      // The log line names ids, never the token.
      expect(JSON.stringify(log.mock.calls)).not.toContain(token);
    } finally {
      log.mockRestore();
    }
  });

  it("verify: the token opens the frozen report and counts the view", async () => {
    const log = quiet();
    try {
      const { token, share } = await createShare({ accountId, profileId, userId, days: 30 });
      const view = await viewSharedReport(token);
      expect(view?.id).toBe(reportId);
      expect(view?.summary).toContain("margin is thin");
      await resolveShare(token);
      const listed = (await listShares({ accountId, profileId })).find((s) => s.id === share.id);
      expect(listed?.status).toBe("active");
      expect(listed?.view_count).toBe(2);
      expect(listed?.last_viewed_at).not.toBeNull();
      expect(new Date(listed!.expires_at).getTime() - new Date(listed!.created_at).getTime()).toBe(
        30 * 86_400_000,
      );
      expect(JSON.stringify(listed)).not.toContain(shareTokenHash(token));
    } finally {
      log.mockRestore();
    }
  });

  it("expire: a link made 8 days ago for 7 days is dead", async () => {
    const log = quiet();
    try {
      const { token } = await createShare({
        accountId,
        profileId,
        userId,
        days: 7,
        now: new Date(Date.now() - 8 * 86_400_000),
      });
      expect(await resolveShare(token)).toBeNull();
      expect(await viewSharedReport(token)).toBeNull();
    } finally {
      log.mockRestore();
    }
  });

  it("revoke: dead at once, idempotent, logged once, and never someone else's", async () => {
    const log = quiet();
    try {
      const { token, share } = await createShare({ accountId, profileId, userId });
      expect(await resolveShare(token)).not.toBeNull();
      await expect(
        revokeShare({ accountId: otherAccountId, profileId: otherProfileId, shareId: share.id }),
      ).rejects.toThrow(ShareError);
      expect(await resolveShare(token)).not.toBeNull();

      expect(await revokeShare({ accountId, profileId, shareId: share.id })).toEqual({
        revoked: true,
      });
      expect(await resolveShare(token)).toBeNull();
      expect(await revokeShare({ accountId, profileId, shareId: share.id })).toEqual({
        revoked: false,
      });
      const entries = await db
        .select()
        .from(decisionLog)
        .where(and(eq(decisionLog.ref_id, share.id), eq(decisionLog.kind, "report_share_revoke")));
      expect(entries).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("refuses a length the owner can't choose", async () => {
    await expect(
      createShare({ accountId, profileId, userId, days: 365 as unknown as 7 }),
    ).rejects.toThrow(ShareError);
  });
});

describe("no oracle: every dead link gets the same page", () => {
  it("unknown, malformed, revoked and expired render byte-for-byte the same", async () => {
    const log = quiet();
    try {
      const revoked = await createShare({ accountId, profileId, userId });
      await revokeShare({ accountId, profileId, shareId: revoked.share.id });
      const expired = await createShare({
        accountId,
        profileId,
        userId,
        now: new Date(Date.now() - 31 * 86_400_000),
      });
      const unknown = "A".repeat(43);
      const pages = await Promise.all(
        [unknown, "not-a-token", "", revoked.token, expired.token].map(deadPage),
      );
      expect(pages[0]).toContain("This link is no longer active.");
      for (const page of pages) expect(page).toBe(pages[0]);
    } finally {
      log.mockRestore();
    }
  });
});

describe("what a reader sees — no PII, no owner answers, no way into the account", () => {
  it("the shared data holds no owner email, customer, address or decline reason", async () => {
    const log = quiet();
    try {
      const { token } = await createShare({ accountId, profileId, userId });
      const view = await viewSharedReport(token);
      expect(view).not.toBeNull();
      const json = JSON.stringify(view);
      for (const secret of [ownerEmail, customerEmail, "Kovács Anna", ADDRESS, SECRET_REASON]) {
        expect(json, secret).not.toContain(secret);
      }
      // Owner-only and internal fields are gone.
      expect(json).not.toContain(profileId);
      expect(json).not.toContain("cost_eur");
      expect(view!.fact_map["legal.postal_address"]).toBeUndefined();
      // Only facts the report cites travel — not the whole profile.
      expect(view!.fact_map["operations.common_complaints"]).toBeUndefined();
      expect(view!.fact_map[`offers.${offerId}.price`]?.value).toContain("4 990");
      expect(view!.fact_map["identity.legal_name"]?.value).toBe("Szörp Kft.");
      // A cited offer field brings its offer's name, so it reads as "Szörp 0.5L · price".
      expect(view!.fact_map[`offers.${offerId}.name`]?.value).toBe("Szörp 0.5L");
      // The recommendation is there; the owner's answer to it is not.
      expect(view!.recommendations[0]!.title).toBe("Test a 12% price rise");
      expect(view!.recommendations[0]!.rejection_reason).toBeNull();
      // The price correction happened before the link: its history may show.
      expect(view!.history[`offers.${offerId}.price`]?.length).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  it("history after the link was made never reaches it (a snapshot, not live)", async () => {
    const log = quiet();
    try {
      const { token } = await createShare({ accountId, profileId, userId });
      await write(profileId, `offers.${offerId}.price`, { amount_minor: 520_000, currency: "HUF" });
      const view = await viewSharedReport(token);
      expect(view!.history[`offers.${offerId}.price`]?.length).toBe(1);
      expect(JSON.stringify(view)).not.toContain("5 200");
    } finally {
      log.mockRestore();
    }
  });

  it("the rendered page has no link into the account, and says it's a shared snapshot", async () => {
    const log = quiet();
    try {
      const { token } = await createShare({ accountId, profileId, userId });
      const html = await deadPage(token);
      expect(html).toContain("Shared report · read only");
      expect(html).toContain("This is a shared snapshot, made");
      expect(html).toContain("Thin margin on the 0.5L");
      expect(html).not.toMatch(/href="\//);
      expect(html).not.toContain("Look into this");
      expect(html).not.toContain("Answer now");
      expect(html).not.toContain(SECRET_REASON);
      expect(html).not.toContain(ADDRESS);
    } finally {
      log.mockRestore();
    }
  });
});

describe("POST /api/report/share — same-origin, signed-in owner only", () => {
  const APP = "http://localhost:3000";
  const post = (headers: Record<string, string>, body: unknown) =>
    new NextRequest(`${APP}/api/report/share`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
    });

  it("a cross-site POST is refused before anything is read", async () => {
    const { POST } = await import("../../app/api/report/share/route");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      jar.clear();
      jar.set(INTAKE_COOKIE, signProfileCookie(profileId));
      jar.set(AUTH_COOKIE, sessionToken);
      for (const headers of [
        { "sec-fetch-site": "cross-site" },
        { origin: "https://evil.example" },
        {},
      ]) {
        const res = await POST(post(headers, { action: "create" }));
        expect(res.status, JSON.stringify(headers)).toBe(403);
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("same-origin but signed out: 401", async () => {
    const { POST } = await import("../../app/api/report/share/route");
    jar.clear();
    jar.set(INTAKE_COOKIE, signProfileCookie(profileId));
    const res = await POST(post({ "sec-fetch-site": "same-origin" }, { action: "create" }));
    expect(res.status).toBe(401);
  });

  it("the owner makes a link (the URL carries the token once) and revokes it", async () => {
    const { POST, GET } = await import("../../app/api/report/share/route");
    const log = quiet();
    try {
      jar.clear();
      jar.set(INTAKE_COOKIE, signProfileCookie(profileId));
      jar.set(AUTH_COOKIE, sessionToken);
      const res = await POST(
        post({ "sec-fetch-site": "same-origin" }, { action: "create", days: 30 }),
      );
      expect(res.status).toBe(201);
      const made = (await res.json()) as { url: string; share: { id: string } };
      expect(made.url).toMatch(/\/shared\/[A-Za-z0-9_-]{43}$/);
      const bad = await POST(
        post({ "sec-fetch-site": "same-origin" }, { action: "create", days: 3 }),
      );
      expect(bad.status).toBe(400);

      const listed = (await (await GET()).json()) as { shares: { id: string }[] };
      expect(listed.shares.some((s) => s.id === made.share.id)).toBe(true);
      expect(JSON.stringify(listed)).not.toContain(made.url.split("/").pop()!);

      const revoked = await POST(
        post({ "sec-fetch-site": "same-origin" }, { action: "revoke", share_id: made.share.id }),
      );
      expect(await revoked.json()).toEqual({ revoked: true });
      expect(await resolveShare(made.url.split("/").pop()!)).toBeNull();
    } finally {
      log.mockRestore();
    }
  });
});

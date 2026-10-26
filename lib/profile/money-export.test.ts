// Idea 49 — the accountant export. The claims: amounts leave as exact
// decimal strings beside their currency (rule 1, no float), a cell a
// spreadsheet would evaluate is neutralised, inferred figures carry their
// inputs and formula (rule 6), an unknown money fact keeps its row (rule
// 5), superseded figures go in the history file (rule 3), and the route
// opens only to the signed-in owner of THIS business.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The route reads cookies through next/headers; a test has no request scope.
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
  fieldRecords,
  offers,
  users,
} from "../../db/schema";
import { AUTH_COOKIE, INTAKE_COOKIE, signProfileCookie } from "../auth/access";
import { signInWithEmail } from "../auth/service";
import { loadBank } from "../bank/loader";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { SourceRef } from "../core/source-ref";
import { writeField } from "./field-store";
import type { MoneyExportRow, StoredFact } from "./money-export";
import {
  CURRENT_COLUMNS,
  csvCell,
  isMoneyFact,
  moneyExportRows,
  toCsv,
  toExportRow,
} from "./money-export";

describe("CSV cells — RFC 4180 quoting and formula neutralising", () => {
  it("prefixes a cell a spreadsheet would evaluate with a quote", () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
  });

  it("leaves plain numbers, negative ones included, readable as numbers", () => {
    expect(csvCell("-12.50")).toBe("-12.50");
    expect(csvCell("4990.00")).toBe("4990.00");
    expect(csvCell("0.750")).toBe("0.750");
  });

  it("quotes commas, quotes and line breaks, and leaves ordinary text alone", () => {
    expect(csvCell("price, per unit")).toBe(`"price, per unit"`);
    expect(csvCell('the "big" one')).toBe(`"the ""big"" one"`);
    expect(csvCell("two\nlines")).toBe(`"two\nlines"`);
    expect(csvCell("Szörp 0.5L")).toBe("Szörp 0.5L");
  });

  it("writes a BOM, the header and CRLF lines", () => {
    const row = { field: "revenue.monthly_revenue", amount: "-1.00" } as MoneyExportRow;
    const csv = toCsv(["field", "amount"], [row]);
    expect(csv).toBe("\uFEFFfield,amount\r\nrevenue.monthly_revenue,-1.00\r\n");
  });
});

const fact = (over: Partial<StoredFact>): StoredFact => ({
  field_key: "revenue.monthly_revenue",
  value: { amount_minor: 420_000_050, currency: "HUF" },
  status: "answered",
  confidence: "0.750",
  source: { kind: "owner_input" },
  observed_at: "2026-10-01T00:00:00.000Z",
  recorded_at: "2026-10-02T00:00:00.000Z",
  superseded_at: null,
  ...over,
});

describe("rows — money in major units, provenance kept", () => {
  it("prints the amount from minor units exactly, with its currency", () => {
    const row = toExportRow(fact({}), "Monthly revenue", false);
    expect(row.amount).toBe("4200000.50");
    expect(row.currency).toBe("HUF");
    expect(row.source).toBe("owner_input");
    expect(row.derived_from).toBe("");
    expect(row.superseded_at).toBeUndefined();
  });

  it("an inferred figure carries its inputs and its formula (rule 6)", () => {
    const row = toExportRow(
      fact({
        status: "inferred",
        source: {
          kind: "inferred",
          derived_from: ["offers.a.price", "offers.a.volume_period"],
          method: "revenue = price × volume",
        },
      }),
      "",
      false,
    );
    expect(row.derived_from).toBe("offers.a.price | offers.a.volume_period");
    expect(row.formula).toBe("revenue = price × volume");
  });

  it("an unknown amount keeps its row with no figure (rule 5)", () => {
    const row = toExportRow(fact({ value: null, status: "unknown" }), "", false);
    expect(row.amount).toBe("");
    expect(row.currency).toBe("");
    expect(row.status).toBe("unknown");
  });

  it("decides money from the value or the bank, never from a list in code", () => {
    const keys = { scalar: new Set(["costs.debt"]), entityFields: new Set(["price"]) };
    const id = "3c941b9e-a4e2-48ad-8e6a-4f22ff2b20ee";
    expect(isMoneyFact("anything", { amount_minor: 1, currency: "EUR" }, keys)).toBe(true);
    expect(isMoneyFact("costs.debt", null, keys)).toBe(true);
    expect(isMoneyFact(`offers.${id}.price`, null, keys)).toBe(true);
    expect(isMoneyFact(`offers.${id}.name`, "Szörp", keys)).toBe(false);
    expect(isMoneyFact("identity.team_size", 4, keys)).toBe(false);
    // A float is not money and never reaches the file as one.
    expect(isMoneyFact("x", { amount_minor: 1.5, currency: "EUR" }, keys)).toBe(false);
  });
});

/* ── against the database: scope, history, and the route's door ── */

const stamp = Date.now();
const ownerEmail = `export-owner-${stamp}@example.test`;
let accountId: string;
let profileId: string;
let otherAccountId: string;
let otherProfileId: string;
let offerId: string;

const write = (
  pid: string,
  key: string,
  value: unknown,
  source: SourceRef = { kind: "owner_input" },
) =>
  writeField(
    pid,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: value === null ? "unknown" : source.kind === "inferred" ? "inferred" : "answered",
      confidence: 0.75,
      source,
      observed_at: isoDateTime(new Date().toISOString()),
      recorded_at: isoDateTime(new Date().toISOString()),
    }),
  );

beforeAll(async () => {
  await loadBank("specs/question-bank-v1.json");
  const [a] = await db.insert(accounts).values({ reporting_currency: "HUF" }).returning();
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

  await write(profileId, "revenue.monthly_revenue", { amount_minor: 300_000_000, currency: "HUF" });
  // A correction: the first figure is superseded, never overwritten (rule 3).
  await write(profileId, "revenue.monthly_revenue", { amount_minor: 420_000_050, currency: "HUF" });
  await write(profileId, "costs.debt", null);
  await write(profileId, `offers.${offerId}.name`, "=Szörp 0.5L");
  await write(profileId, `offers.${offerId}.price`, { amount_minor: 499_000, currency: "HUF" });
  await write(profileId, "identity.team_size", 4);
  await write(otherProfileId, "revenue.monthly_revenue", { amount_minor: 1, currency: "EUR" });
});

afterAll(async () => {
  const userRows = await db.select().from(users).where(eq(users.email, ownerEmail));
  for (const u of userRows) await db.delete(authSessions).where(eq(authSessions.user_id, u.id));
  await db
    .update(accounts)
    .set({ owner_user_id: null })
    .where(inArray(accounts.id, [accountId, otherAccountId]));
  for (const u of userRows) await db.delete(users).where(eq(users.id, u.id));
  await db
    .delete(fieldRecords)
    .where(inArray(fieldRecords.profile_id, [profileId, otherProfileId]));
  await db.delete(offers).where(eq(offers.profile_id, profileId));
  await db
    .delete(businessProfiles)
    .where(inArray(businessProfiles.id, [profileId, otherProfileId]));
  await db.delete(accounts).where(inArray(accounts.id, [accountId, otherAccountId]));
});

describe("the read — one business's money facts", () => {
  it("current: the corrected revenue, the unknown debt, the offer price; no non-money facts", async () => {
    const rows = await moneyExportRows({ accountId, profileId, part: "current" });
    const byField = new Map(rows.map((r) => [r.field, r]));
    expect(byField.get("revenue.monthly_revenue")?.amount).toBe("4200000.50");
    expect(byField.get("costs.debt")?.status).toBe("unknown");
    const price = byField.get(`offers.${offerId}.price`);
    expect(price?.amount).toBe("4990.00");
    expect(price?.label).toBe("=Szörp 0.5L · price");
    expect(byField.has("identity.team_size")).toBe(false);
    expect(byField.has(`offers.${offerId}.name`)).toBe(false);
    // The bank's own words label a scalar field.
    expect(byField.get("revenue.monthly_revenue")?.label).not.toBe("");
  });

  it("history: the superseded figure, with when it was replaced", async () => {
    const rows = await moneyExportRows({ accountId, profileId, part: "history" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe("3000000.00");
    expect(rows[0]!.superseded_at).not.toBe("");
  });

  it("a profile id paired with another account reads nothing", async () => {
    const rows = await moneyExportRows({
      accountId: otherAccountId,
      profileId,
      part: "current",
    });
    expect(rows).toEqual([]);
  });

  it("the file neutralises the entity name that starts with '='", async () => {
    const csv = toCsv(
      CURRENT_COLUMNS,
      await moneyExportRows({ accountId, profileId, part: "current" }),
    );
    expect(csv).toContain("'=Szörp 0.5L · price");
    expect(csv).not.toMatch(/,=Szörp/);
  });
});

describe("GET /api/profile/export — the signed-in owner only", () => {
  const get = (part = "current") =>
    new NextRequest(`http://localhost:3000/api/profile/export?part=${part}`);

  it("no cookie at all: 401", async () => {
    jar.clear();
    const { GET } = await import("../../app/api/profile/export/route");
    expect((await GET(get())).status).toBe(401);
  });

  it("the intake cookie alone, before anyone owns the business: still 401 — a file leaving needs the owner", async () => {
    jar.clear();
    jar.set(INTAKE_COOKIE, signProfileCookie(profileId));
    const { GET } = await import("../../app/api/profile/export/route");
    expect((await GET(get())).status).toBe(401);
  });

  it("the signed-in owner gets an attachment that no cache keeps", async () => {
    const session = await signInWithEmail(ownerEmail, profileId);
    expect(session.account_id).toBe(accountId);
    jar.clear();
    jar.set(INTAKE_COOKIE, signProfileCookie(profileId));
    jar.set(AUTH_COOKIE, session.session_token);
    const { GET } = await import("../../app/api/profile/export/route");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const res = await GET(get());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("content-disposition")).toMatch(
        /^attachment; filename="syb-money-facts-\d{4}-\d{2}-\d{2}\.csv"$/,
      );
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const body = await res.text();
      expect(body).toContain("revenue.monthly_revenue");
      expect(body).toContain("4200000.50,HUF");
      expect(body).not.toContain(ownerEmail);
      const history = await GET(get("history"));
      expect(await history.text()).toContain("3000000.00,HUF");
      expect((await GET(get("everything"))).status).toBe(400);
    } finally {
      log.mockRestore();
    }
  });

  it("once owned, the cookie without the session is refused", async () => {
    jar.clear();
    jar.set(INTAKE_COOKIE, signProfileCookie(profileId));
    const { GET } = await import("../../app/api/profile/export/route");
    expect((await GET(get())).status).toBe(401);
  });
});

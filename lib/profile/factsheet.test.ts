// The fact sheet's claims, proven: it reads from a snapshot, the
// snapshot dedupes by content, provenance is counted not asserted, an
// explicit unknown is an answer while a never-asked question is a gap,
// and every gap says what answering it buys.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  competitors,
  fieldRecords,
  profileSnapshots,
  snapshotRecords,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { loadBank } from "../bank/loader";
import { writeField } from "./field-store";
import { buildFactSheet, gapBuys, repr } from "./factsheet";
import { ensureSnapshot } from "./snapshot";

const BANK_PATH = "specs/question-bank-v1.json";
let accountId: string;
let profileId: string;

async function ownerSays(key: string, value: unknown, status = "answered"): Promise<void> {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value: status === "answered" ? value : null,
      status: status as "answered" | "unknown",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

beforeAll(async () => {
  await loadBank(BANK_PATH);
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "HUF", locale: "hu-HU" })
    .returning();
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account!.id, schema_version: "1.0.0" })
    .returning();
  accountId = account!.id;
  profileId = profile!.id;

  await ownerSays("identity.legal_name", "Szörp Kft.");
  await ownerSays("identity.description", "Kézműves szörpök");
  // Rule 5: an explicit unknown is an answer, not a gap.
  await ownerSays("costs.fixed_monthly", null, "unknown");

  // A derived fact, with its formula.
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId("revenue.monthly_revenue"),
      value: { amount_minor: 450_000_000, currency: "HUF" },
      status: "inferred",
      confidence: 0.6,
      source: {
        kind: "inferred",
        derived_from: [fieldId("offers.total_revenue")],
        method: "sum of offer revenue",
      },
      observed_at: at,
      recorded_at: at,
    }),
  );

  // A competitor entity with a researched fact.
  const [row] = await db
    .insert(competitors)
    .values({ profile_id: profileId, source: { kind: "owner_input" } })
    .returning();
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(`competitors.${row!.id}.name`),
      value: "Szomszéd Szörp",
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(`competitors.${row!.id}.delivery_promise`),
      value: "2 munkanap",
      status: "answered",
      confidence: 0.5,
      source: { kind: "web_research", researched_url: "https://szomszed-szorp.hu" },
      observed_at: at,
      recorded_at: at,
    }),
  );
});

afterAll(async () => {
  const snaps = await db
    .select({ id: profileSnapshots.id })
    .from(profileSnapshots)
    .where(eq(profileSnapshots.profile_id, profileId));
  for (const s of snaps) {
    await db.delete(snapshotRecords).where(eq(snapshotRecords.snapshot_id, s.id));
  }
  await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, profileId));
  await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
  await db.delete(competitors).where(eq(competitors.profile_id, profileId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

describe("repr — deterministic humanising", () => {
  it("renders money as major units with the currency, never a float artifact", () => {
    expect(repr({ amount_minor: 450_000_000, currency: "HUF" })).toBe("4 500 000 HUF");
    expect(repr({ amount_minor: 649_000, currency: "EUR" })).toBe("6 490 EUR");
  });
  it("prefers the owner's raw words on enums", () => {
    expect(repr({ code: "physical_products", label_raw: "szörpök" })).toBe("szörpök");
    expect(repr({ code: "physical_products" })).toBe("physical products");
    expect(repr([{ code: "a" }, { code: "b" }])).toBe("a, b");
  });
  it("reads bare vocabulary codes as words, but leaves owner text verbatim", () => {
    expect(repr("social_organic")).toBe("social organic");
    expect(repr("We never_ever discount.")).toBe("We never_ever discount.");
    expect(repr("instagram")).toBe("instagram");
  });
});

describe("P1-59 — the sheet reads from a snapshot", () => {
  it("shows every fact with its source, and counts provenance", async () => {
    const sheet = await buildFactSheet(profileId);

    const identity = sheet.sections.find((s) => s.section === "identity");
    const name = identity?.facts.find((f) => f.key === "identity.legal_name");
    expect(name?.value).toBe("Szörp Kft.");
    expect(name?.source_kind).toBe("owner_input");

    const revenue = sheet.sections
      .find((s) => s.section === "revenue")
      ?.facts.find((f) => f.key === "revenue.monthly_revenue");
    expect(revenue?.value).toBe("4 500 000 HUF");
    expect(revenue?.source_kind).toBe("inferred");
    expect(revenue?.source_detail).toBe("sum of offer revenue");

    const kinds = Object.fromEntries(sheet.provenance.map((p) => [p.kind, p.count]));
    expect(kinds["owner_input"]).toBeGreaterThanOrEqual(4);
    expect(kinds["inferred"]).toBe(1);
    expect(kinds["web_research"]).toBe(1);
  });

  it("groups entity facts per entity, named", async () => {
    const sheet = await buildFactSheet(profileId);
    const comp = sheet.entities.find((e) => e.spine === "competitors");
    expect(comp?.name).toBe("Szomszéd Szörp");
    const delivery = comp?.facts.find((f) => f.key === "delivery_promise");
    expect(delivery?.value).toBe("2 munkanap");
    expect(delivery?.source_kind).toBe("web_research");
    expect(delivery?.source_detail).toBe("https://szomszed-szorp.hu");
  });

  it("viewing twice does not take a second snapshot when nothing moved", async () => {
    const a = await ensureSnapshot(profileId);
    const b = await ensureSnapshot(profileId);
    expect(b.id).toBe(a.id);

    await ownerSays("goals.main_goal", "növekedés");
    const c = await ensureSnapshot(profileId);
    expect(c.id).not.toBe(a.id);
  });
});

describe("P1-60 — gaps say what answering them buys", () => {
  it("an explicit unknown is not a gap; a never-asked core question is, and blocks", async () => {
    const sheet = await buildFactSheet(profileId);

    // costs.fixed_monthly was answered "I don't know" — never a gap.
    expect(sheet.gaps.some((g) => g.prompt.toLowerCase().includes("fixed"))).toBe(false);

    // The country was never asked: a core gap, marked blocking, linkable.
    const country = sheet.gaps.find((g) => g.question_id === "1.1b");
    expect(country?.priority).toBe("core");
    expect(country?.blocking).toBe(true);
    expect(country?.buys).toContain("core");

    // Ordered by weight: every core gap before any non-core gap.
    const priorities = sheet.gaps.map((g) => g.priority);
    const lastCore = priorities.lastIndexOf("core");
    expect(priorities.slice(0, lastCore + 1).every((p) => p === "core")).toBe(true);
  });

  it("gap copy is deterministic and counts real follow-ups", () => {
    expect(gapBuys({ priority: "core", unlocks: ["3.1", "3.2"] })).toContain("2 follow-ups");
    expect(gapBuys({ priority: "important", unlocks: null })).toContain("sharpens");
    expect(gapBuys({ priority: "deep", unlocks: [] })).toContain("precision");
  });
});

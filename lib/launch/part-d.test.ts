// The multi-market spec Part D's tests:
//   · a regional-fallback benchmark carries its origin label in all seven locales
//   · a country with fewer than 7 contributing businesses cannot be marked open
//   · a case study without a mechanism, or without verified backing, can't be created

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  caseStudies,
  connections,
  countryLaunches,
  fieldRecords,
  intakeEvents,
  peerBenchmarkConsents,
} from "../../db/schema";
import { resolveBenchmark, originLabels, neighboursOf } from "../benchmarks/resolver";
import { CaseStudyError, createCaseStudy, crossBorderView } from "../case-studies/case-study";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { money } from "../core/money";
import { LOCALES } from "../i18n/locales";
import { bootstrapIntake } from "../intake/service";
import { closePlan } from "../ledger/close";
import { openPlan } from "../ledger/plans";
import { optIntoPeers } from "../peers/consent";
import { writeField } from "../profile/field-store";
import { openCountry } from "./country";

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const acc = created.map((s) => s.account_id);
  await db.delete(caseStudies).where(inArray(caseStudies.profile_id, ids));
  await db.delete(peerBenchmarkConsents).where(inArray(peerBenchmarkConsents.profile_id, ids));
  await db.delete(connections).where(inArray(connections.account_id, acc));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
  await db.delete(countryLaunches).where(eq(countryLaunches.country, "LU"));
});

async function put(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

/** A live, contributing café in Luxembourg: consented, measured, sector and size known. */
async function contributor(opts: { measured?: boolean } = {}) {
  const s = await bootstrapIntake();
  created.push(s);
  await put(s.profile_id, "legal.country", "Luxembourg");
  await put(s.profile_id, "identity.business_type", "cafe");
  await put(s.profile_id, "legal.entity_type", "llc_ltd");
  await put(s.profile_id, "identity.team_size", 5);
  await optIntoPeers({ profileId: s.profile_id, by: null });
  if (opts.measured !== false) {
    await db.insert(connections).values({
      account_id: s.account_id,
      provider: "fixture",
      purpose: "measure",
      status: "connected",
      granted_scopes: ["read_revenue", "read_orders", "read_ad_spend"],
    });
  }
  return s;
}

describe("§D.1 — the cold-start ladder always names its rung", () => {
  const never = async () => null;

  it("a regional fallback carries its origin label in all seven locales, naming the countries", async () => {
    const served = await resolveBenchmark("HU", {
      national: never,
      regional: async (countries) => (countries.includes("AT") ? 4_200 : null),
      official: never,
    });
    expect(served.origin).toEqual({ rung: "regional", countries: neighboursOf("HU") });
    for (const locale of LOCALES) {
      const label = served.label[locale];
      expect(label, locale).toBeTruthy();
      expect(label, locale).not.toMatch(/\{countries\}|\{source\}|\{vintage\}/);
    }
    expect(served.label.en).toMatch(/Austria/);
    expect(served.label.en).toMatch(/costs aren't yours/);
    expect(served.label["hu-HU"]).toMatch(/Ausztria/);
    expect(served.label["de-DE"]).toMatch(/Österreich/);
  });

  it("prefers the national cohort, then official statistics with their vintage, then nothing — never silently", async () => {
    expect(
      (await resolveBenchmark("HU", { national: async () => 1, regional: never, official: never }))
        .origin.rung,
    ).toBe("national");
    const official = await resolveBenchmark("HU", {
      national: never,
      regional: never,
      official: async () => ({ value: 2, source: "Eurostat SBS", vintage: "2022" }),
    });
    expect(official.origin).toEqual({ rung: "official", source: "Eurostat SBS", vintage: "2022" });
    expect(official.label.en).toMatch(/Eurostat SBS, 2022/);
    const none = await resolveBenchmark("HU", {
      national: never,
      regional: never,
      official: never,
    });
    expect(none).toMatchObject({ value: null, origin: { rung: "none" } });
    for (const locale of LOCALES) expect(none.label[locale], locale).toBeTruthy();
  });

  it("every rung has words in every language", () => {
    for (const rung of ["national", "regional", "official", "none"] as const) {
      const labels = originLabels({ rung, countries: ["AT"], source: "x", vintage: "2022" });
      for (const locale of LOCALES)
        expect(labels[locale].length, `${rung} ${locale}`).toBeGreaterThan(10);
    }
  });
});

describe("§D.2 — a country opens only with 7 contributing businesses in one pair", () => {
  it("6 is refused; an unmeasured business doesn't count; the 7th opens it", async () => {
    for (let i = 0; i < 6; i++) await contributor();
    await contributor({ measured: false });
    await expect(openCountry("LU", "Owner")).rejects.toThrow(/needs 7.*most in any is 6/);
    await contributor();
    const qualifying = await openCountry("LU", "Owner");
    expect(qualifying).toMatchObject({ segment: "small_corp", businesses: 7 });
    const [row] = await db.select().from(countryLaunches).where(eq(countryLaunches.country, "LU"));
    expect(row?.opened_by).toBe("Owner");
  });
});

describe("§D.3 — case studies travel by mechanism, backed by verified gains", () => {
  async function gainFor(s: { profile_id: string; account_id: string }, verdict: "gain" | "loss") {
    const { plan } = await openPlan({
      profileId: s.profile_id,
      accountId: s.account_id,
      provider: "fixture",
      action_summary: "Change Tuesday staffing",
      hypothesis: "Less food is thrown away",
      expected: {
        effect: money(100_000, "EUR"),
        low: money(50_000, "EUR"),
        high: money(150_000, "EUR"),
      },
      currency: "EUR",
      reversible: true,
      opened_by: "agent",
      station: 3,
      shadow: false,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const o =
      verdict === "gain"
        ? { observed_minor: 120_000, low_minor: 60_000, high_minor: 180_000, method_notes: "t" }
        : { observed_minor: -50_000, low_minor: -80_000, high_minor: -20_000, method_notes: "t" };
    return closePlan(plan.id, o);
  }

  it("refuses without a mechanism, or with a backing entry that isn't a verified gain", async () => {
    const s = await contributor();
    const gain = await gainFor(s, "gain");
    const loss = await gainFor(s, "loss");
    await expect(
      createCaseStudy({
        profileId: s.profile_id,
        mechanism: "saved money",
        ledgerEntryIds: [gain.id],
      }),
    ).rejects.toBeInstanceOf(CaseStudyError);
    await expect(
      createCaseStudy({
        profileId: s.profile_id,
        mechanism: "A café cut food waste by changing Tuesday staffing",
        ledgerEntryIds: [],
      }),
    ).rejects.toThrow(/backed by ledger entries/);
    await expect(
      createCaseStudy({
        profileId: s.profile_id,
        mechanism: "A café cut food waste by changing Tuesday staffing",
        ledgerEntryIds: [loss.id],
      }),
    ).rejects.toThrow(/only verified gains/);
  });

  it("is created from verified gains, and crosses borders without its amount", async () => {
    const s = await contributor();
    const gain = await gainFor(s, "gain");
    const c = await createCaseStudy({
      profileId: s.profile_id,
      mechanism: "A five-person café cut 14% of its food waste by changing Tuesday staffing",
      ledgerEntryIds: [gain.id],
    });
    expect(c).toMatchObject({
      country: "LU",
      currency: "EUR",
      nace: "I56",
      segment: "small_corp",
      local_amount_minor: 120_000,
    });
    const view = crossBorderView(c);
    expect(Object.keys(view).sort()).toEqual(["country", "mechanism", "nace", "segment"]);
    expect(JSON.stringify(view)).not.toMatch(/120|amount/);
  });

  it("the database refuses one without a mechanism or backing, even written directly", async () => {
    const s = created[0]!;
    const error = await db
      .insert(caseStudies)
      .values({
        profile_id: s.profile_id,
        country: "LU",
        currency: "EUR",
        nace: "I56",
        segment: "small_corp",
        local_amount_minor: 1,
        mechanism: " ",
        ledger_entry_ids: [],
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(String((error as { cause?: { message?: string } })?.cause?.message)).toMatch(
      /case_studies_(mechanism|backed)/,
    );
  });
});

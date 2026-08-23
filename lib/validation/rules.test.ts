// Session Q — the nine rules of data-model §7, each with a passing and a
// firing case (P0-80). Every scenario is driven through writeField alone:
// a finding appearing here proves the engine runs on every field write,
// not as a batch (P0-81). Auto-resolution and persisted resolutions
// (P0-84) are asserted the same way.

import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  suppliers,
  validationFindings,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import { resolveFinding } from "./engine";
import { RULES, RULES_VERSION } from "./rules";

const HUF = "HUF";
const createdAccounts: string[] = [];
const createdProfiles: string[] = [];

async function newProfile(): Promise<string> {
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: HUF, locale: "hu-HU" })
    .returning();
  if (!account) throw new Error("account insert failed");
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account.id, schema_version: "1.0.0" })
    .returning();
  if (!profile) throw new Error("profile insert failed");
  createdAccounts.push(account.id);
  createdProfiles.push(profile.id);
  return profile.id;
}

/** Write an answered owner fact — the ONLY way scenarios touch the DB. */
async function w(
  profileId: string,
  key: string,
  value: unknown,
  observedAt?: string,
): Promise<void> {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: observedAt ? isoDateTime(observedAt) : at,
      recorded_at: at,
    }),
  );
}

async function open(profileId: string, ruleId: string) {
  const rows = await db
    .select()
    .from(validationFindings)
    .where(
      and(
        eq(validationFindings.profile_id, profileId),
        eq(validationFindings.rule_id, ruleId),
        isNull(validationFindings.resolution),
      ),
    );
  return rows[0] ?? null;
}

async function latest(profileId: string, ruleId: string) {
  const rows = await db
    .select()
    .from(validationFindings)
    .where(
      and(
        eq(validationFindings.profile_id, profileId),
        eq(validationFindings.rule_id, ruleId),
      ),
    );
  return rows[rows.length - 1] ?? null;
}

const money = (major: number) => ({ amount_minor: major * 100, currency: HUF });
const uuid = () => crypto.randomUUID();

afterAll(async () => {
  for (const id of createdProfiles) {
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, id));
    await db.delete(suppliers).where(eq(suppliers.profile_id, id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, id));
  }
  for (const id of createdAccounts) {
    await db.delete(accounts).where(eq(accounts.id, id));
  }
});

describe("the rule set is declarative and versioned (P0-78/79)", () => {
  it("carries nine rules and a version", () => {
    expect(RULES).toHaveLength(9);
    expect(RULES_VERSION).toBe("1.0.0");
    for (const rule of RULES) {
      expect(rule.triggers.length).toBeGreaterThan(0);
    }
  });
});

describe("margin_mismatch", () => {
  it("passes while inputs are consistent, fires on a >10pt gap, auto-resolves", async () => {
    const p = await newProfile();
    await w(p, "costs.gross_margin", 20);
    expect(await open(p, "margin_mismatch")).toBeNull(); // no offers yet — passing

    const o = uuid();
    await w(p, `offers.${o}.price`, money(4990));
    await w(p, `offers.${o}.cost_to_deliver`, money(2050)); // computed ≈ 59%
    const finding = await open(p, "margin_mismatch");
    expect(finding?.kind).toBe("contradiction");
    expect(finding?.rule_version).toBe(RULES_VERSION);
    expect((finding?.message as { en: string }).en).toContain("gross margin");

    await w(p, "costs.gross_margin", 59); // owner corrects — rule goes quiet
    expect(await open(p, "margin_mismatch")).toBeNull();
    const resolved = await latest(p, "margin_mismatch");
    expect((resolved?.resolution as { method: string }).method).toBe("auto_resolved");
  });
});

describe("revenue_vs_offers", () => {
  it("fires when offer arithmetic misses stated revenue by >20%", async () => {
    const p = await newProfile();
    const o = uuid();
    await w(p, "revenue.monthly_revenue", money(4_500_000));
    await w(p, `offers.${o}.price`, money(4990));
    await w(p, `offers.${o}.volume_period`, 100); // 499k vs 4.5M — fires
    expect((await open(p, "revenue_vs_offers"))?.kind).toBe("contradiction");

    await w(p, `offers.${o}.volume_period`, 900); // 4.49M — within 20%
    expect(await open(p, "revenue_vs_offers")).toBeNull();
  });
});

describe("costs_exceed_revenue", () => {
  it("fires only while the trend claims growth", async () => {
    const p = await newProfile();
    const c = uuid();
    await w(p, "revenue.monthly_revenue", money(10_000));
    await w(p, `costs.${c}.amount`, money(15_000));
    await w(p, `costs.${c}.cadence`, { code: "monthly" });
    expect(await open(p, "costs_exceed_revenue")).toBeNull(); // no trend — passing

    await w(p, "revenue.trend", { code: "growing" });
    expect((await open(p, "costs_exceed_revenue"))?.kind).toBe("implausible");

    await w(p, "revenue.trend", { code: "declining" });
    expect(await open(p, "costs_exceed_revenue")).toBeNull();
  });
});

describe("inventory_without_supplier", () => {
  it("fires on inventory with zero suppliers, clears when one is recorded", async () => {
    const p = await newProfile();
    await w(p, "offers.physical.holds_inventory", { code: "yes" });
    expect((await open(p, "inventory_without_supplier"))?.kind).toBe("gap");

    await db.insert(suppliers).values({ profile_id: p });
    await w(p, `suppliers.${uuid()}.name`, "Elderflower Bt.");
    expect(await open(p, "inventory_without_supplier")).toBeNull();
  });
});

describe("channel_without_revenue", () => {
  it("fires on a primary channel without any revenue figure", async () => {
    const p = await newProfile();
    await w(p, "channels.primary_id", { code: "webshop" });
    expect((await open(p, "channel_without_revenue"))?.kind).toBe("gap");

    await w(p, `channels.${uuid()}.revenue_monthly`, money(800_000));
    expect(await open(p, "channel_without_revenue")).toBeNull();
  });
});

describe("key_person_undocumented", () => {
  it("fires on single-point-of-failure with no SOPs", async () => {
    const p = await newProfile();
    await w(p, "service.key_person_dependency", { code: "single_point_of_failure" });
    expect(await open(p, "key_person_undocumented")).toBeNull(); // SOPs unknown — passing

    await w(p, "operations.has_sops", false);
    expect((await open(p, "key_person_undocumented"))?.kind).toBe("gap");

    await w(p, "operations.has_sops", true);
    expect(await open(p, "key_person_undocumented")).toBeNull();
  });
});

describe("stage_vs_revenue", () => {
  it("fires when an idea-stage business reports revenue", async () => {
    const p = await newProfile();
    await w(p, "identity.stage", { code: "idea" });
    expect(await open(p, "stage_vs_revenue")).toBeNull(); // no revenue claim — passing

    await w(p, "revenue.generates_revenue", { code: "yes" });
    const finding = await open(p, "stage_vs_revenue");
    expect(finding?.kind).toBe("contradiction");
    expect((finding?.message as { en: string }).en).toContain("idea");

    await w(p, "identity.stage", { code: "operating" });
    expect(await open(p, "stage_vs_revenue")).toBeNull();
  });
});

describe("stale_financials", () => {
  it("fires when the newest revenue point is older than 90 days", async () => {
    const p = await newProfile();
    const old = new Date(Date.now() - 120 * 86_400_000).toISOString();
    await w(p, "revenue.monthly_revenue", money(2_000_000), old);
    expect((await open(p, "stale_financials"))?.kind).toBe("stale");

    await w(p, "revenue.monthly_revenue", money(2_100_000)); // fresh observation
    expect(await open(p, "stale_financials")).toBeNull();
  });
});

describe("single_supplier_top_offer", () => {
  it("fires on exactly one supplier with no alternative", async () => {
    const p = await newProfile();
    const s = uuid();
    await db.insert(suppliers).values({ profile_id: p });
    await w(p, `suppliers.${s}.has_alternative`, false);
    expect((await open(p, "single_supplier_top_offer"))?.kind).toBe("gap");

    await w(p, `suppliers.${s}.has_alternative`, true);
    expect(await open(p, "single_supplier_top_offer")).toBeNull();
  });
});

describe("resolutions persist (P0-84)", () => {
  it("owner_confirmed sticks, and a resolved finding is never re-resolved", async () => {
    const p = await newProfile();
    await w(p, "identity.stage", { code: "idea" });
    await w(p, "revenue.generates_revenue", { code: "yes" });
    const finding = await open(p, "stage_vs_revenue");
    if (!finding) throw new Error("expected an open finding");

    await resolveFinding(finding.id, "owner_confirmed", "both are right");
    const after = await latest(p, "stage_vs_revenue");
    const resolution = after?.resolution as { method: string; note: string | null };
    expect(resolution.method).toBe("owner_confirmed");
    expect(resolution.note).toBe("both are right");
    expect(await open(p, "stage_vs_revenue")).toBeNull();

    // Second resolve is a no-op — the isNull guard protects history.
    await resolveFinding(finding.id, "dismissed", "should not overwrite");
    const final = await latest(p, "stage_vs_revenue");
    expect((final?.resolution as { method: string }).method).toBe("owner_confirmed");
  });
});

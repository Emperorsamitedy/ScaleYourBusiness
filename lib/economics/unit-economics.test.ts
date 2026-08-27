// Phase 1 Session B — P1-14. Every formula gets a case that computes and
// a case that refuses. The refusals matter as much as the numbers: a
// product that invents a plausible CPA is worse than one that says it
// cannot work it out.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  costItems,
  fieldRecords,
  offers,
  profileSnapshots,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { money } from "../core/money";
import { writeField } from "../profile/field-store";
import { readSnapshot, takeSnapshot } from "../profile/snapshot";
import { computeEconomics } from "./unit-economics";

const HUF = "HUF";
const accountIds: string[] = [];
const profileIds: string[] = [];
let profileId: string;

async function freshProfile(): Promise<string> {
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
  accountIds.push(account.id);
  profileIds.push(profile.id);
  return profile.id;
}

async function w(key: string, value: unknown, confidence = 0.75): Promise<void> {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

/** Add a priced offer; returns its spine id. */
async function addOffer(
  name: string,
  priceMajor: number,
  costMajor: number | null,
  volume: number | null,
  currency = HUF,
): Promise<string> {
  const [row] = await db
    .insert(offers)
    .values({ profile_id: profileId, kind: "physical" })
    .returning();
  if (!row) throw new Error("offer insert failed");
  await w(`offers.${row.id}.name`, name);
  await w(`offers.${row.id}.price`, money(priceMajor * 100, currency));
  if (costMajor !== null) await w(`offers.${row.id}.cost_to_deliver`, money(costMajor * 100, HUF));
  if (volume !== null) await w(`offers.${row.id}.volume_period`, volume);
  return row.id;
}

async function addFixedCost(label: string, amountMajor: number, cadence: string): Promise<void> {
  const [row] = await db
    .insert(costItems)
    .values({ profile_id: profileId, bucket: "fixed", scales_with_sales: false })
    .returning();
  if (!row) throw new Error("cost insert failed");
  await w(`costs.${row.id}.label`, label);
  await w(`costs.${row.id}.amount`, money(amountMajor * 100, HUF));
  await w(`costs.${row.id}.cadence`, { code: cadence });
}

async function economics() {
  const snap = await takeSnapshot(profileId, "report");
  return computeEconomics(await readSnapshot(snap.id), HUF);
}

beforeEach(async () => {
  profileId = await freshProfile();
});

afterAll(async () => {
  for (const id of profileIds) {
    // Snapshots first: snapshot_records holds a foreign key to field_records
    // precisely so a record a report depends on cannot be deleted out from
    // under it. Dropping the snapshots releases those references.
    await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, id));
    await db.delete(offers).where(eq(offers.profile_id, id));
    await db.delete(costItems).where(eq(costItems.profile_id, id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, id));
  }
  for (const id of accountIds) await db.delete(accounts).where(eq(accounts.id, id));
});

describe("P1-07 — margin per offer", () => {
  it("computes it, and records what it came from", async () => {
    const id = await addOffer("Szörp 0.5L", 4990, 4090, 189);
    const e = await economics();
    const offer = e.offers.find((o) => o.offer_id === id);

    expect(offer?.margin_pct?.value).toBe(18); // (4990−4090)/4990 = 18.0%
    expect(offer?.contribution?.value).toEqual(money(90_000, HUF)); // 900 HUF
    expect(offer?.margin_pct?.formula).toBe("(price − cost_to_deliver) ÷ price × 100");
    expect(offer?.margin_pct?.derived_from).toEqual([
      `offers.${id}.price`,
      `offers.${id}.cost_to_deliver`,
    ]);
    // §8.1 — a derivation is never more certain than its weakest input.
    expect(offer?.margin_pct?.confidence).toBeCloseTo(0.675, 3);
  });

  it("refuses rather than assuming a cost it was never given", async () => {
    await addOffer("Gift box", 12900, null, 17);
    const e = await economics();

    expect(e.offers[0]?.margin_pct).toBeNull();
    const refusal = e.refusals.find((r) => r.what.includes("Gift box"));
    expect(refusal?.missing[0]).toMatch(/cost_to_deliver$/);
    expect(refusal?.why).toContain("unknown rather than assumed");
  });

  it("refuses to compute a margin across two currencies", async () => {
    await addOffer("Export box", 39, 4090, 5, "EUR"); // EUR price, HUF cost
    const e = await economics();
    expect(e.offers[0]?.margin_pct).toBeNull();
    expect(e.refusals.some((r) => r.why.includes("different currencies"))).toBe(true);
  });
});

describe("P1-08 — blended margin", () => {
  it("weights by units sold, not by offer count", async () => {
    await addOffer("Szörp 0.5L", 5000, 4100, 900); // 18%, high volume
    await addOffer("Gift box", 10000, 3900, 100); // 61%, low volume
    const e = await economics();

    // Unweighted this would be ~39.5%; weighted it must sit near the 0.5L.
    expect(e.blended_margin_pct?.value).toBeCloseTo(22.3, 0);
    expect(e.blended_margin_pct?.formula).toContain("units sold");
  });

  it("says so when it had no volumes to weight with", async () => {
    await addOffer("A", 5000, 4100, null);
    await addOffer("B", 10000, 3900, null);
    const e = await economics();
    expect(e.blended_margin_pct?.value).toBeCloseTo(39.5, 1);
    expect(e.blended_margin_pct?.formula).toContain("no volumes recorded");
  });
});

describe("P1-09 — break-even", () => {
  it("computes units and revenue, and states the mix assumption", async () => {
    await addOffer("Szörp 0.5L", 5000, 4100, 100); // contributes 900
    await addFixedCost("Rent", 450_000, "monthly");
    const e = await economics();

    expect(e.fixed_costs_monthly?.value).toEqual(money(45_000_000, HUF));
    expect(e.break_even?.value.units_per_month).toBe(500); // 450 000 ÷ 900
    expect(e.break_even?.value.contribution_per_unit).toEqual(money(90_000, HUF));
    expect(e.break_even?.formula).toContain("offer mix holds");
  });

  it("normalises an annual cost to a monthly one", async () => {
    await addOffer("X", 5000, 4100, 10);
    await addFixedCost("Insurance", 1_200_000, "annual");
    const e = await economics();
    expect(e.fixed_costs_monthly?.value).toEqual(money(10_000_000, HUF)); // 100 000/mo
  });

  it("refuses when every sale loses money", async () => {
    await addOffer("Loss leader", 4000, 4500, 50);
    await addFixedCost("Rent", 300_000, "monthly");
    const e = await economics();

    expect(e.break_even).toBeNull();
    expect(e.refusals.some((r) => r.why.includes("no volume that breaks even"))).toBe(true);
  });

  it("refuses when there are no fixed costs to cover", async () => {
    await addOffer("X", 5000, 4100, 10);
    const e = await economics();
    expect(e.break_even).toBeNull();
    expect(e.refusals.some((r) => r.what === "break-even")).toBe(true);
  });
});

describe("P1-10 — average order value", () => {
  it("computes revenue ÷ orders", async () => {
    await w("revenue.monthly_revenue", money(450_000_000, HUF));
    await w("revenue.order_count_monthly", 310);
    const e = await economics();

    expect(e.average_order_value?.value).toEqual(money(1_451_613, HUF));
    expect(e.average_order_value?.formula).toBe("monthly revenue ÷ monthly orders");
  });

  it("refuses without an order count, naming what is missing", async () => {
    await w("revenue.monthly_revenue", money(450_000_000, HUF));
    const e = await economics();
    expect(e.average_order_value).toBeNull();
    const refusal = e.refusals.find((r) => r.what === "average order value");
    expect(refusal?.missing).toEqual(["revenue.order_count_monthly"]);
  });
});

describe("P1-11 — cost per acquisition", () => {
  it("counts only new customers", async () => {
    await w("marketing.monthly_ad_spend", money(20_000_000, HUF)); // 200 000
    await w("revenue.order_count_monthly", 300);
    await w("revenue.repeat_customer_rate", 0.2); // 240 new
    const e = await economics();

    expect(e.cost_per_acquisition?.value).toEqual(money(83_333, HUF)); // ≈833 HUF
    expect(e.cost_per_acquisition?.formula).toBe("ad spend ÷ (orders × (1 − repeat rate))");
  });

  it("treats a repeat rate given as a percentage the same as a fraction", async () => {
    await w("marketing.monthly_ad_spend", money(20_000_000, HUF));
    await w("revenue.order_count_monthly", 300);
    await w("revenue.repeat_customer_rate", 20); // 20, not 0.2
    const e = await economics();
    expect(e.cost_per_acquisition?.value).toEqual(money(83_333, HUF));
  });

  it("refuses without a repeat rate, and explains why it matters", async () => {
    await w("marketing.monthly_ad_spend", money(20_000_000, HUF));
    await w("revenue.order_count_monthly", 300);
    const e = await economics();

    expect(e.cost_per_acquisition).toBeNull();
    const refusal = e.refusals.find((r) => r.what === "cost per acquisition");
    expect(refusal?.missing).toEqual(["revenue.repeat_customer_rate"]);
    expect(refusal?.why).toContain("flatters the number");
  });

  it("refuses to convert ad spend held in another currency", async () => {
    await w("marketing.monthly_ad_spend", money(50_000, "EUR"));
    await w("revenue.order_count_monthly", 300);
    await w("revenue.repeat_customer_rate", 0.2);
    const e = await economics();

    expect(e.cost_per_acquisition).toBeNull();
    expect(e.refusals.some((r) => r.why.includes("FX rate"))).toBe(true);
  });
});

describe("P1-13 — stated against computed (§8.3)", () => {
  it("shows both, uses the computed one, and overwrites neither", async () => {
    await addOffer("Szörp 0.5L", 4990, 4090, 189); // computes to 18%
    await w("costs.gross_margin", 40); // the owner's belief
    const e = await economics();

    expect(e.stated_vs_computed_margin).toEqual({
      stated_pct: 40,
      computed_pct: 18,
      delta_pts: -22,
      used_for_analysis: "computed",
    });

    // Both values survive in the profile — nothing was corrected away.
    const snap = await takeSnapshot(profileId);
    const view = await readSnapshot(snap.id);
    expect(view.facts.get("costs.gross_margin")?.value).toBe(40);
  });

  it("stays silent when the owner never stated a margin", async () => {
    await addOffer("X", 5000, 4100, 10);
    const e = await economics();
    expect(e.stated_vs_computed_margin).toBeNull();
  });
});

describe("the whole block, on a realistic profile", () => {
  it("computes what it can and refuses the rest, by name", async () => {
    await addOffer("Szörp 0.5L", 4990, 4090, 189);
    await addOffer("Gift box", 12900, 5030, 17);
    await addOffer("Winter spice", 5490, null, 21); // no cost recorded
    await addFixedCost("Rent", 320_000, "monthly");
    await addFixedCost("Insurance", 240_000, "annual");
    await w("revenue.monthly_revenue", money(450_000_000, HUF));
    await w("revenue.order_count_monthly", 310);
    await w("costs.gross_margin", 40);

    const e = await economics();

    expect(e.offers).toHaveLength(3);
    expect(e.offers[0]?.name).toBe("Gift box"); // sorted best margin first
    expect(e.blended_margin_pct).not.toBeNull();
    expect(e.break_even?.value.units_per_month).toBeGreaterThan(0);
    expect(e.average_order_value).not.toBeNull();
    expect(e.fixed_costs_monthly?.value).toEqual(money(34_000_000, HUF)); // 320k + 20k
    expect(e.stated_vs_computed_margin?.used_for_analysis).toBe("computed");

    // It declined the two it genuinely could not do, and said which.
    expect(e.cost_per_acquisition).toBeNull();
    expect(e.refusals.map((r) => r.what)).toContain("cost per acquisition");
    expect(e.refusals.some((r) => r.what.includes("Winter spice"))).toBe(true);

    // Every computed figure can name its inputs (rule 6).
    for (const o of e.offers) {
      if (o.margin_pct) expect(o.margin_pct.derived_from.length).toBeGreaterThan(0);
    }
    expect(e.break_even?.derived_from.length).toBeGreaterThan(0);
  });
});

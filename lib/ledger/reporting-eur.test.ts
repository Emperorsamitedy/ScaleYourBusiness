// The multi-market spec §A.4: a ledger entry's `reporting_eur` is a derived
// EUR projection for SYB's internal cross-market roll-ups ONLY — stored with
// the rate and date it used, reproducible from them, and never read by any
// owner- or partner-facing surface or by the guarantee.

import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fxRates, intakeEvents } from "../../db/schema";
import { convertFromStored } from "../core/fx";
import { money } from "../core/money";
import { storeRates } from "../fx/ecb";
import { bootstrapIntake } from "../intake/service";
import { verifyLedger } from "./chain";
import { closePlan } from "./close";
import type { OpenPlanInput } from "./plans";
import { openPlan } from "./plans";

const created: { account_id: string; profile_id: string }[] = [];
// A currency no other suite stores rates for, on a day long past.
const DAY = "2026-01-30";

beforeAll(async () => {
  created.push(await bootstrapIntake());
  await storeRates([
    { currency: "HUF", date: DAY, per_eur: "391.48", source: "ECB daily reference" },
  ]);
});

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

function plan(currency: string, over: Partial<OpenPlanInput> = {}): OpenPlanInput {
  const s = created[0]!;
  return {
    profileId: s.profile_id,
    accountId: s.account_id,
    provider: "fixture",
    action_summary: "Set a fixture value",
    hypothesis: "Revenue rises",
    expected: {
      effect: money(500_000, currency),
      low: money(100_000, currency),
      high: money(900_000, currency),
    },
    currency,
    reversible: true,
    opened_by: "agent",
    station: 3,
    shadow: false,
    now: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

describe("§A.4 — reporting_eur, internal only", () => {
  it("a HUF close stores its EUR projection with the rate and date it used", async () => {
    const { plan: p } = await openPlan(plan("HUF"));
    const e = await closePlan(
      p.id,
      { observed_minor: 3_500_000, low_minor: 1_000_000, high_minor: 6_000_000, method_notes: "t" },
      new Date(`${DAY}T12:00:00Z`),
    );
    expect(e.net_minor).toBe(3_500_000); // the business's own money, in forints
    expect(e).toMatchObject({
      reporting_eur_minor: 8_940,
      reporting_fx_rate: "391.48",
      reporting_fx_source: "ECB daily reference",
    });
    expect(String(e.reporting_fx_date).slice(0, 10)).toBe(DAY);
    // Reproduces exactly from the stored rate and date — never today's.
    const again = convertFromStored(money(e.net_minor!, "HUF"), {
      ...money(e.reporting_eur_minor!, "EUR"),
      fx_rate_to_eur: e.reporting_fx_rate!,
      fx_rate_date: DAY,
      fx_source: e.reporting_fx_source!,
    });
    expect(again.amount_minor).toBe(e.reporting_eur_minor);
  });

  it("an EUR close projects to itself; a day with no stored rate projects to nothing", async () => {
    const eur = (await openPlan(plan("EUR"))).plan;
    const a = await closePlan(eur.id, {
      observed_minor: 100,
      low_minor: 50,
      high_minor: 150,
      method_notes: "t",
    });
    expect(a).toMatchObject({ reporting_eur_minor: 100, reporting_fx_rate: null });
    const pln = (await openPlan(plan("XCD"))).plan;
    const b = await closePlan(pln.id, {
      observed_minor: 100,
      low_minor: 50,
      high_minor: 150,
      method_notes: "t",
    });
    expect(b).toMatchObject({ reporting_eur_minor: null, reporting_fx_rate: null });
  });

  it("the chain still verifies with the projection in every hash", async () => {
    expect((await verifyLedger()).ok).toBe(true);
  });

  it("a stored rate can never be rewritten", async () => {
    const error = await db
      .update(fxRates)
      .set({ per_eur: "1.00" })
      .where(eq(fxRates.currency, "HUF"))
      .then(
        () => null,
        (e: unknown) => e,
      );
    const msg = `${(error as { message?: string })?.message ?? ""} ${(error as { cause?: { message?: string } })?.cause?.message ?? ""}`;
    expect(msg).toMatch(/never rewritten/);
  });
});

// Only the ledger's writer, its hash, the schema and SYB's internal ops
// roll-up may name the projection.
const ROOT = path.resolve(__dirname, "../..");
const ALLOWED = new Set([
  "lib/ledger/close.ts",
  "lib/ledger/chain.ts",
  "db/schema.ts",
  "lib/ops/cross-market.ts",
  "lib/core/fx.ts", // its header comment names what the EUR projection is for
]);

function sources(dir: string): string[] {
  const abs = path.join(ROOT, dir);
  const out: string[] = [];
  for (const name of readdirSync(abs)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = path.join(abs, name);
    if (statSync(p).isDirectory()) out.push(...sources(path.relative(ROOT, p)));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("§A.4 — reporting_eur never reaches an owner or partner", () => {
  it("is named only by the ledger's writer, its hash, the schema and the internal roll-up", () => {
    const hits = ["lib", "app", "components", "db"]
      .flatMap(sources)
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
      .filter((rel) =>
        /reporting_eur|reportingEur/.test(readFileSync(path.join(ROOT, rel), "utf8")),
      );
    expect(hits.filter((h) => !ALLOWED.has(h))).toEqual([]);
  });
});

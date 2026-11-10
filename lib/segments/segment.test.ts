// The segment model — the multi-market spec Part C. "A micro_sole account
// must not reach ladder station 3 through ANY path, including
// partner-initiated actions. Test this."

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  capabilityStations,
  fieldRecords,
  intakeEvents,
} from "../../db/schema";
import { lockSubscription } from "../billing/price-book";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { authorize, setStation, stationOf } from "../ladder/ladder";
import { writeField } from "../profile/field-store";
import { segmentOf } from "./read";
import { deriveSegment, routeAfterFreeResult, tierAllowed } from "./segment";

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
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

async function business(form: string | null, team: number | null) {
  const s = await bootstrapIntake();
  created.push(s);
  if (form !== null) await put(s.profile_id, "legal.entity_type", form);
  if (team !== null) await put(s.profile_id, "identity.team_size", team);
  return s;
}

describe("§C — derived from legal form, then staff", () => {
  it("a sole trader is micro_sole whatever its size", () => {
    expect(
      deriveSegment({ legal_form: "sole_trader", team_size: 25, size_band: null }).segment,
    ).toBe("micro_sole");
    expect(
      deriveSegment({ legal_form: "not_registered", team_size: null, size_band: null }).segment,
    ).toBe("micro_sole");
  });

  it("a company goes by headcount: under 10, 10–49, 50+", () => {
    const f = (n: number) =>
      deriveSegment({ legal_form: "llc_ltd", team_size: n, size_band: null }).segment;
    expect([f(1), f(9), f(10), f(49), f(50)]).toEqual([
      "small_corp",
      "small_corp",
      "mid_corp",
      "mid_corp",
      "large",
    ]);
  });

  it("with no headcount, the owner's size band stands in; with neither, no guess", () => {
    expect(
      deriveSegment({ legal_form: "llc_ltd", team_size: null, size_band: "medium" }).segment,
    ).toBe("mid_corp");
    expect(deriveSegment({ legal_form: "llc_ltd", team_size: null, size_band: null })).toEqual({
      segment: null,
      basis: "the business's size isn't known yet",
    });
    expect(deriveSegment({ legal_form: null, team_size: 3, size_band: null }).segment).toBeNull();
  });

  it("qualifies at the end of the free result, never at its gate", () => {
    expect(routeAfterFreeResult("micro_sole")).toBe("watch_or_waitlist");
    expect(routeAfterFreeResult("small_corp")).toBe("full_diagnosis");
    expect(routeAfterFreeResult("mid_corp")).toBe("full_diagnosis_partner_led");
    expect(routeAfterFreeResult("large")).toBe("waitlist");
    expect(routeAfterFreeResult(null)).toBe("ask_more");
  });

  it("reads the current facts of a stored business", async () => {
    const s = await business("llc_ltd", 9);
    expect((await segmentOf(s.profile_id)).segment).toBe("small_corp");
  });
});

describe("§C — a micro_sole account can't reach station 3 through any path", () => {
  it("its default is station 2, not 3", async () => {
    const s = await business("sole_trader", 1);
    expect(await stationOf(s.profile_id, "meta_ads")).toBe(2);
    expect((await authorize(s.profile_id, "meta_ads")).state).toBe("SHADOW");
  });

  it("raising it is refused, whoever asks — owner or partner", async () => {
    const s = await business("sole_trader", 1);
    for (const by of [null, crypto.randomUUID()]) {
      await expect(
        setStation({ profileId: s.profile_id, capability: "meta_ads", station: 3, by }),
      ).rejects.toThrow(/stay at station 2/);
    }
  });

  it("even a station written straight into the table is read as 2", async () => {
    const s = await business("sole_trader", 1);
    await db
      .insert(capabilityStations)
      .values({ profile_id: s.profile_id, capability: "meta_ads", station: 4 });
    expect(await stationOf(s.profile_id, "meta_ads")).toBe(2);
    expect((await authorize(s.profile_id, "meta_ads")).state).toBe("SHADOW");
  });

  it("a company is not capped", async () => {
    const s = await business("llc_ltd", 4);
    expect(await stationOf(s.profile_id, "meta_ads")).toBe(3);
  });
});

describe("§C — a micro_sole subscribes to Watch only", () => {
  it("refuses any other tier", async () => {
    const s = await business("sole_trader", 1);
    expect(tierAllowed("micro_sole", "act")).toBe(false);
    await expect(
      lockSubscription({
        profileId: s.profile_id,
        tier: "act",
        billingCountry: "HU",
        vatCountry: "HU",
      }),
    ).rejects.toThrow(/Watch/);
  });
});

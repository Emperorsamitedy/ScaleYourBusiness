// Peer Benchmark Network — architecture-v2 hard rule 4, invariant I4, D7,
// D13. A suppressed benchmark carries NOTHING: no number, no rounding, no
// bucket, no count, no "fewer than seven" — the tests check the whole
// object, not one field of it.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  intakeEvents,
  peerBenchmarkConsents,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { money } from "../core/money";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import { CohortCurrencyError, PEER_K, PEER_MAX_SHARE, peerAggregate } from "./aggregate";
import { hasPeerConsent, optIntoPeers, optOutOfPeers } from "./consent";
import { peerAverageOrderValue } from "./serve";

const even = (n: number, num = 1_000, den = 10) =>
  Array.from({ length: n }, () => ({ business: randomUUID(), numerator: num, denominator: den }));

describe("hard rule 4 / I4 — the aggregate (pure)", () => {
  it("states the spec's floors", () => {
    expect(PEER_K).toBe(7);
    expect(PEER_MAX_SHARE).toBe(0.25);
  });

  it("six businesses serve nothing at all — the whole result is { shown: false }", () => {
    const result = peerAggregate(even(6));
    expect(result).toEqual({ shown: false });
    expect(Object.keys(result)).toEqual(["shown"]);
  });

  it("seven businesses, none dominant, serve the ratio of totals", () => {
    expect(peerAggregate(even(7, 1_000, 10))).toEqual({ shown: true, value: 100, businesses: 7 });
  });

  it("seven, with one at 26% of the numerator, serve nothing", () => {
    const six = Array.from({ length: 6 }, () => ({
      business: randomUUID(),
      numerator: 350,
      denominator: 10,
    }));
    // 740 / (740 + 2100) = 26.06 %
    const result = peerAggregate([
      ...six,
      { business: randomUUID(), numerator: 740, denominator: 10 },
    ]);
    expect(result).toEqual({ shown: false });
  });

  it("exactly 25% is not 'exceeds 25%': it serves", () => {
    const six = Array.from({ length: 6 }, () => ({
      business: randomUUID(),
      numerator: 350,
      denominator: 10,
    }));
    // 700 / 2800 = 25 % exactly
    const result = peerAggregate([
      ...six,
      { business: randomUUID(), numerator: 700, denominator: 10 },
    ]);
    expect(result.shown).toBe(true);
  });

  it("dominance of the denominator suppresses too", () => {
    const six = Array.from({ length: 6 }, () => ({
      business: randomUUID(),
      numerator: 1_000,
      denominator: 5,
    }));
    // 30 orders of 60 = 50 %
    const result = peerAggregate([
      ...six,
      { business: randomUUID(), numerator: 1_000, denominator: 30 },
    ]);
    expect(result).toEqual({ shown: false });
  });

  it("one business can't be counted seven times: rows merge per business first", () => {
    const one = randomUUID();
    const rows = [
      ...Array.from({ length: 5 }, () => ({ business: one, numerator: 100, denominator: 1 })),
      ...even(2),
    ];
    expect(peerAggregate(rows)).toEqual({ shown: false });
  });

  it("nothing to divide by serves nothing", () => {
    expect(peerAggregate(even(8, 1_000, 0))).toEqual({ shown: false });
  });
});

// ---------------------------------------------------------------------------
// Serving from the database, opt-in only (D7, D13).
// ---------------------------------------------------------------------------

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(peerBenchmarkConsents).where(inArray(peerBenchmarkConsents.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

async function put(profileId: string, key: string, value: unknown): Promise<void> {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
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

/** A business of `type` with a month's revenue and orders; opted in unless told not to. */
async function shop(
  type: string,
  revenueMinor: number,
  orders: number,
  opts: { currency?: string; consent?: boolean } = {},
) {
  const s = await bootstrapIntake();
  created.push(s);
  await put(s.profile_id, "identity.business_type", type);
  await put(s.profile_id, "revenue.monthly_revenue", money(revenueMinor, opts.currency ?? "EUR"));
  await put(s.profile_id, "revenue.order_count_monthly", orders);
  if (opts.consent !== false) await optIntoPeers({ profileId: s.profile_id, by: null });
  return s;
}

describe("D7 — a business contributes only after it opts in", () => {
  it("records the opt-in and its withdrawal, keeping both", async () => {
    const s = await shop(`peer_test_${randomUUID()}`, 100_000, 10, { consent: false });
    expect(await hasPeerConsent(s.profile_id)).toBe(false);
    await optIntoPeers({ profileId: s.profile_id, by: null });
    await optIntoPeers({ profileId: s.profile_id, by: null }); // twice is once
    expect(await hasPeerConsent(s.profile_id)).toBe(true);
    await optOutOfPeers({ profileId: s.profile_id, by: null });
    expect(await hasPeerConsent(s.profile_id)).toBe(false);
    const rows = await db
      .select()
      .from(peerBenchmarkConsents)
      .where(eq(peerBenchmarkConsents.profile_id, s.profile_id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.withdrawn_at).not.toBeNull();
  });
});

describe("D13 — average order value for the business's cohort", () => {
  it("six peers serve nothing — and the reader is told Eurostat is the reference instead", async () => {
    const type = `peer_test_${randomUUID()}`;
    const reader = await shop(type, 50_000, 10, { consent: false });
    for (let i = 0; i < 6; i++) await shop(type, 100_000, 10);
    expect(await peerAverageOrderValue(reader.profile_id)).toEqual({
      shown: false,
      fallback: "eurostat",
    });
  });

  it("seven opted-in peers serve their ratio of totals, in the reader's currency", async () => {
    const type = `peer_test_${randomUUID()}`;
    const reader = await shop(type, 50_000, 10, { consent: false });
    for (let i = 0; i < 7; i++) await shop(type, 100_000 + i * 1_000, 10);
    // Σ revenue 721 000 ÷ Σ orders 70 = 10 300 minor units per order
    expect(await peerAverageOrderValue(reader.profile_id)).toEqual({
      shown: true,
      value: money(10_300, "EUR"),
      businesses: 7,
    });
  });

  it("never counts a business that hasn't opted in, has withdrawn, or reports another currency", async () => {
    const type = `peer_test_${randomUUID()}`;
    const reader = await shop(type, 50_000, 10, { consent: false });
    for (let i = 0; i < 5; i++) await shop(type, 100_000, 10);
    await shop(type, 100_000, 10, { consent: false }); // never opted in
    const withdrawn = await shop(type, 100_000, 10);
    await optOutOfPeers({ profileId: withdrawn.profile_id, by: null });
    await shop(type, 3_000_000, 10, { currency: "HUF" }); // another currency, never converted
    // Five usable peers, not eight.
    expect(await peerAverageOrderValue(reader.profile_id)).toEqual({
      shown: false,
      fallback: "eurostat",
    });
  });

  it("a business with no type or no revenue figure gets no cohort", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    expect(await peerAverageOrderValue(s.profile_id)).toEqual({
      shown: false,
      fallback: "eurostat",
    });
  });
});

describe("the multi-market spec §A.7 — a cohort has exactly one currency", () => {
  it("building a cohort with two currencies fails loudly", () => {
    const rows = [
      ...even(6).map((r) => ({ ...r, currency: "HUF" })),
      { business: randomUUID(), numerator: 1_000, denominator: 10, currency: "EUR" },
    ];
    expect(() => peerAggregate(rows)).toThrow(CohortCurrencyError);
    expect(() => peerAggregate(rows)).toThrow(/2 currencies \(EUR, HUF\)/);
  });

  it("one currency, or counts with none, build as before", () => {
    expect(peerAggregate(even(7).map((r) => ({ ...r, currency: "HUF" })))).toMatchObject({
      shown: true,
    });
    expect(peerAggregate(even(7))).toMatchObject({ shown: true });
  });
});

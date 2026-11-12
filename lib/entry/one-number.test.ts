// P7-70 — the free one-number entry (v1 spec §8.2, §8.6): six questions,
// no account, no connector, a result in under ten seconds, in every
// language; a share link; the referral chain.

import "dotenv/config";
import { inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { entryLeads } from "../../db/schema";
import en from "../../messages/en.json";
import entryFile from "../../specs/entry-v1.json";
import { LOCALES } from "../i18n/locales";
import {
  BUSINESS_TYPES,
  CHANNELS,
  EntryError,
  REVENUE_BANDS,
  bandMidpoint,
  checkAnswers,
  entryByToken,
  oneLeak,
  operationsQuestion,
  referralChain,
  runEntry,
} from "./one-number";

const salon = {
  sector: "salon_beauty",
  country: "PT",
  revenue_band: "12k_42k",
  employees: 4,
  channel: "search_maps",
  operations: "never",
};

describe("§8.2 — six questions, answered from the bank's own options", () => {
  it("accepts a whole answer and refuses anything off the list", () => {
    expect(checkAnswers(salon)).toEqual(salon);
    expect(() => checkAnswers({ ...salon, sector: "spaceship" })).toThrow(EntryError);
    expect(() => checkAnswers({ ...salon, country: "Portugal" })).toThrow(/country/);
    expect(() => checkAnswers({ ...salon, revenue_band: "lots" })).toThrow(/band/);
    expect(() => checkAnswers({ ...salon, employees: 0 })).toThrow(/people/);
    expect(() => checkAnswers({ ...salon, employees: 2.5 })).toThrow(/people/);
    expect(() => checkAnswers({ ...salon, channel: "telepathy" })).toThrow(/customers/);
    // A salon's operations question is reminders; a café's answer doesn't fit it.
    expect(() => checkAnswers({ ...salon, operations: "by_feel" })).toThrow(/last question/);
  });

  it("the sixth question is the sector's own", () => {
    expect(operationsQuestion("salon_beauty").question).toBe("reminders");
    expect(operationsQuestion("cafe").question).toBe("buying");
    expect(operationsQuestion("ecommerce_store").question).toBe("slow_stock");
    expect(operationsQuestion("consulting").question).toBe("invoicing");
    expect(operationsQuestion("other").question).toBe("invoicing");
  });
});

describe("§8.2 — one leak, named, a euro range, grade D", () => {
  it("prices the first rule that holds from the band's midpoint", () => {
    // 12.5k–41.667k a month: midpoint 27 083.50 €; no reminders: 5 %–12 %
    expect(bandMidpoint("12k_42k")).toBe(2_708_350);
    expect(oneLeak(checkAnswers(salon))).toEqual({
      id: "no_shows",
      low_minor: 135_000,
      high_minor: 325_000,
      currency: "EUR",
      grade: "D",
      basis: { low_bp: 500, high_bp: 1_200, band: "12k_42k" },
      measure: "bookings",
    });
  });

  it("falls through to the channel, then to price drift, and an open band uses 1.5 × its floor", () => {
    const fine = { ...salon, operations: "automatic" };
    expect(oneLeak(checkAnswers({ ...fine, channel: "paid_ads" })).id).toBe("untracked_ads");
    expect(oneLeak(checkAnswers({ ...fine, channel: "social" })).id).toBe("price_drift");
    expect(bandMidpoint("over_417k")).toBe(62_500_050);
  });

  it("every leak, measure, question and option has words in English (the catalogue keeps the other six in step)", () => {
    const entry = (en as unknown as { entry: Record<string, Record<string, unknown>> }).entry;
    for (const r of entryFile.leaks.rules) {
      expect(entry.leak?.[r.id], r.id).toBeTruthy();
      expect(entry.measure?.[r.measure], r.measure).toBeTruthy();
    }
    for (const b of REVENUE_BANDS)
      expect((entry.band as Record<string, string>)[b], b).toBeTruthy();
    for (const c of CHANNELS) expect((entry.channel as Record<string, string>)[c], c).toBeTruthy();
    for (const [, op] of Object.entries(entryFile.operations)) {
      const q = (entry.ops as Record<string, Record<string, string>>)[op.question]!;
      expect(q.question).toBeTruthy();
      for (const o of op.options) expect(q[o], `${op.question}.${o}`).toBeTruthy();
    }
    expect(BUSINESS_TYPES.length).toBeGreaterThan(30);
    expect(LOCALES).toHaveLength(7);
  });
});

const tokens: string[] = [];
afterAll(async () => {
  if (tokens.length > 0) await db.delete(entryLeads).where(inArray(entryLeads.token, tokens));
});

describe("§8.6 — no account, no connector, under ten seconds", () => {
  it("returns the leak and a peer comparison, records the lead, and shares it", async () => {
    const started = Date.now();
    const out = await runEntry({ answers: salon, locale: "hu-HU" });
    tokens.push(out.token);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out.result.leak.grade).toBe("D");
    expect(["served", "not_enough"]).toContain(out.result.comparison.status);
    expect(out.result.comparison.metric).toBe("revenue_per_employee");
    // The share link reads it back as it was; nothing about a person is in it.
    const shared = await entryByToken(out.token);
    expect(shared?.result.leak).toEqual(out.result.leak);
    expect(JSON.stringify(shared)).not.toMatch(/@|email|name/i);
    expect(await entryByToken("not-a-token!")).toBeNull();
  });

  it("follows the referral chain from a shared result (§5.6)", async () => {
    const root = await runEntry({ answers: salon, locale: "en" });
    const child = await runEntry({
      answers: { ...salon, sector: "barber" },
      locale: "en",
      ref: root.token,
    });
    const grandchild = await runEntry({
      answers: { ...salon, sector: "barber" },
      locale: "de-DE",
      ref: child.token,
    });
    tokens.push(root.token, child.token, grandchild.token);
    expect(await referralChain(root.token)).toBe(2);
    expect(await referralChain(child.token)).toBe(1);
  });
});

// P3-03 — rule 14's machinery, provable offline. The LLM seam is a
// fake with a call counter: the parse-once contract, the staleness
// re-parse, and the no-boundaries gap are all about WHEN the model is
// consulted, and the tests count it. The check itself is arithmetic.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords, intakeEvents } from "../../db/schema";
import { createField } from "../core/field";
import { confidence } from "../core/confidence";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { readCurrentField, readFieldHistory, writeField } from "../profile/field-store";
import { bootstrapIntake } from "../intake/service";
import type { HardLimit, LimitLlm } from "./hard-limits";
import {
  BOUNDARIES_KEY,
  checkHardLimits,
  coerceLimits,
  ensureHardLimits,
  HARD_LIMITS_KEY,
  LIMIT_EXTRACTION_METHOD,
  limitCaption,
} from "./hard-limits";

const created: { account_id: string; profile_id: string }[] = [];

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

async function writeBoundaries(profileId: string, text: string) {
  await writeField(
    profileId,
    createField<string>({
      id: fieldId(BOUNDARIES_KEY),
      value: text,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: isoDateTime(new Date().toISOString()),
      recorded_at: isoDateTime(new Date().toISOString()),
    }),
  );
}

/** A fake seam returning fixed extractions, counting invocations. */
function fakeLlm(limitsJson: string): { llm: LimitLlm; calls: () => number } {
  let n = 0;
  const llm: LimitLlm = async () => {
    n += 1;
    return { text: limitsJson, calls: [] };
  };
  return { llm, calls: () => n };
}

const NEVER_DISCOUNT = JSON.stringify({
  limits: [
    { code: "no_discounts", quote: "we never discount, full stop" },
    { code: "brand_tone_thing", quote: "never sound corporate" },
  ],
});

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P3-03 — coercion", () => {
  it("maps known codes to auto, unknown codes to manual 'other' — never dropped", () => {
    const limits = coerceLimits(NEVER_DISCOUNT);
    expect(limits).toHaveLength(2);
    expect(limits[0]).toMatchObject({ code: "no_discounts", enforcement: "auto" });
    expect(limits[1]).toMatchObject({
      code: "other",
      enforcement: "manual",
      quote: "never sound corporate",
    });
  });

  it("an empty answer yields an empty list; junk quotes are refused", () => {
    expect(coerceLimits('{"limits": []}')).toEqual([]);
    expect(coerceLimits('{"limits": [{"code": "no_discounts", "quote": "  "}]}')).toEqual([]);
    expect(() => coerceLimits("not json")).toThrow(/non-JSON/);
  });
});

describe("P3-03 — the deterministic check (rule 14)", () => {
  const limits: HardLimit[] = [
    { code: "no_discounts", quote: "we never discount", enforcement: "auto" },
    { code: "other", quote: "never sound corporate", enforcement: "manual" },
  ];

  it("blocks a forbidden action kind and names the limit in the owner's words", () => {
    const verdict = checkHardLimits(limits, "discount_or_promotion");
    expect(verdict.verdict).toBe("blocked");
    if (verdict.verdict === "blocked") {
      expect(limitCaption(verdict.limit)).toBe("13.5: we never discount");
      expect(verdict.manual).toHaveLength(1);
    }
  });

  it("passes an unforbidden kind — and the manual limit still rides along", () => {
    const verdict = checkHardLimits(limits, "price_increase");
    expect(verdict.verdict).toBe("pass");
    expect(verdict.manual.map((l) => l.quote)).toEqual(["never sound corporate"]);
  });

  it("a manual limit alone never auto-blocks anything", () => {
    const manualOnly: HardLimit[] = [
      { code: "other", quote: "never sound corporate", enforcement: "manual" },
    ];
    for (const kind of ["discount_or_promotion", "cold_outreach"] as const) {
      expect(checkHardLimits(manualOnly, kind).verdict).toBe("pass");
    }
  });
});

describe("P3-03 — parse once, at capture (fake LLM, call-counted)", () => {
  it("parses on first call, writes the inferred fact with provenance, then reuses", async () => {
    const s = await fresh();
    await writeBoundaries(s.profile_id, "We never discount, full stop. And never sound corporate.");
    const { llm, calls } = fakeLlm(NEVER_DISCOUNT);

    const first = await ensureHardLimits(s.profile_id, llm);
    expect(first.via).toBe("parsed");
    expect(first.limits).toHaveLength(2);
    expect(calls()).toBe(1);

    const fact = await readCurrentField<HardLimit[]>(s.profile_id, HARD_LIMITS_KEY);
    expect(fact?.status).toBe("inferred");
    expect(fact?.source).toMatchObject({
      kind: "inferred",
      derived_from: [BOUNDARIES_KEY],
      method: LIMIT_EXTRACTION_METHOD,
    });

    const second = await ensureHardLimits(s.profile_id, llm);
    expect(second.via).toBe("reused");
    expect(calls()).toBe(1); // the whole point: no second model call
  });

  it("changed boundaries re-parse once, superseding the old limits (rule 3)", async () => {
    const s = await fresh();
    await writeBoundaries(s.profile_id, "Never discount.");
    const { llm, calls } = fakeLlm(NEVER_DISCOUNT);
    await ensureHardLimits(s.profile_id, llm);

    await writeBoundaries(s.profile_id, "Actually discounts are fine now. But never cold email.");
    const rerun = await ensureHardLimits(s.profile_id, llm);
    expect(rerun.via).toBe("parsed");
    expect(calls()).toBe(2);

    const history = await readFieldHistory<HardLimit[]>(s.profile_id, HARD_LIMITS_KEY);
    expect(history).toHaveLength(2);
    expect(history[0]?.superseded_at).not.toBeNull(); // old parse kept, marked
    expect(history[1]?.superseded_at).toBeNull();
  });

  it("no boundaries answered → no limits, no fact, no model call (rule 5)", async () => {
    const s = await fresh();
    const { llm, calls } = fakeLlm(NEVER_DISCOUNT);
    const out = await ensureHardLimits(s.profile_id, llm);
    expect(out).toEqual({ limits: [], via: "no_boundaries" });
    expect(calls()).toBe(0);
    expect(await readCurrentField(s.profile_id, HARD_LIMITS_KEY)).toBeNull();
  });
});

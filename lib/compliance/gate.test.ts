// ComplianceGate — the v1 build spec §9 (P7-32): a rules engine over the
// per-country matrix, which is configuration loadable without a deploy and
// audit-logged on every change. That a failure here overrides any ladder
// authorization is proven in the engine's own suite
// (lib/execution/architecture-v2.test.ts), where both meet.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { countryComplianceChanges, countryComplianceMatrix } from "../../db/schema";
import { PHONE_COUNTRIES_KEY, phoneAnsweringAllowed } from "../phone/countries";
import { COMPLIANCE_RULES, check } from "./gate";
import {
  MatrixError,
  countryChanges,
  countryRule,
  inboundPhoneAllowed,
  outboundPhoneAllowed,
  removeCountryRule,
  setCountryRule,
} from "./matrix";

// ISO's user-assigned codes: never a real country, so no real row is touched.
const QM = "QM";
const QN = "QN";
const QO = "QO";
const TEST_COUNTRIES = [QM, QN, QO];

afterAll(async () => {
  for (const c of TEST_COUNTRIES) {
    if (await countryRule(c))
      await removeCountryRule({ country: c, actor: "test", reason: "cleanup" });
  }
});

const business = () => ({ profileId: randomUUID(), accountId: randomUUID() });
const SIGNOFF = { legal_signoff_date: "2026-11-01", legal_signoff_reference: "Counsel memo QM-1" };

function causeOf(error: unknown): string {
  const e = error as { message?: string; cause?: { message?: string } };
  return `${e.message ?? ""} ${e.cause?.message ?? ""}`;
}

describe("§9.2 — the matrix, strictest first", () => {
  it("a country with no row is blocked for phone answering, inbound and outbound", async () => {
    const rule = await countryRule(QM);
    expect(rule).toBeNull();
    expect(inboundPhoneAllowed(rule)).toBe(false);
    expect(outboundPhoneAllowed(rule)).toBe(false);
  });

  it("a new row defaults to all-party recording, criminal penalty, disclosure, blocked", async () => {
    const row = await setCountryRule({
      country: QM,
      change: {},
      actor: "ops: test",
      reason: "add the row",
    });
    expect(row).toMatchObject({
      recording_regime: "all_party",
      criminal_penalty: true,
      ai_disclosure_required: true,
      outbound_consent_required: true,
      blocked: true,
      outbound_blocked: true,
      execution_halted: false,
    });
  });

  it("refuses to unblock without counsel's dated sign-off — in words, and in the table", async () => {
    await expect(
      setCountryRule({ country: QM, change: { blocked: false }, actor: "ops", reason: "go" }),
    ).rejects.toThrow(MatrixError);
    // Around the module, the table's own check refuses it too.
    const error = await db
      .transaction(async (tx) => {
        await tx.execute(sql`select set_config('syb.actor', 'raw sql', true)`);
        await tx
          .update(countryComplianceMatrix)
          .set({ blocked: false })
          .where(eq(countryComplianceMatrix.country, QM));
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(causeOf(error)).toMatch(/country_compliance_matrix_signoff/);
  });

  it("unblocks inbound with a sign-off; outbound only after inbound", async () => {
    await expect(
      setCountryRule({
        country: QN,
        change: { ...SIGNOFF, outbound_blocked: false },
        actor: "ops",
        reason: "outbound first",
      }),
    ).rejects.toThrow(/after inbound/);
    const row = await setCountryRule({
      country: QN,
      change: { ...SIGNOFF, blocked: false },
      actor: "ops: Anna",
      reason: "counsel signed off inbound",
    });
    expect(inboundPhoneAllowed(row)).toBe(true);
    expect(outboundPhoneAllowed(row)).toBe(false);
  });

  it("AI disclosure can never be switched off (Article 50(1))", async () => {
    const error = await db
      .transaction(async (tx) => {
        await tx.execute(sql`select set_config('syb.actor', 'raw sql', true)`);
        await tx
          .update(countryComplianceMatrix)
          .set({ ai_disclosure_required: false })
          .where(eq(countryComplianceMatrix.country, QM));
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(causeOf(error)).toMatch(/country_compliance_matrix_disclosure/);
  });
});

describe("§9.5 — every change is audit-logged, and the log can't be edited", () => {
  it("records who, why, and the row before and after", async () => {
    await setCountryRule({
      country: QO,
      change: { note: "first" },
      actor: "ops: Bence",
      reason: "adding the row",
    });
    await setCountryRule({
      country: QO,
      change: { criminal_penalty: false, recording_regime: "single_party" },
      actor: "ops: Bence",
      reason: "counsel: single-party country",
    });
    const [latest] = await countryChanges(QO);
    expect(latest).toMatchObject({
      op: "UPDATE",
      actor: "ops: Bence",
      reason: "counsel: single-party country",
    });
    expect((latest?.before as { recording_regime: string }).recording_regime).toBe("all_party");
    expect((latest?.after as { recording_regime: string }).recording_regime).toBe("single_party");
  });

  it("a change that doesn't say who made it is refused, even in raw SQL", async () => {
    const error = await db
      .update(countryComplianceMatrix)
      .set({ note: "sneaky" })
      .where(eq(countryComplianceMatrix.country, QO))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(causeOf(error)).toMatch(/names who made it/);
  });

  it("the matrix can't be truncated around the log", async () => {
    const error = await db.execute(sql`truncate country_compliance_matrix`).then(
      () => null,
      (e: unknown) => e,
    );
    expect(causeOf(error)).toMatch(/not permitted/);
  });

  it("the change log refuses edits and deletes", async () => {
    const [latest] = await countryChanges(QO);
    for (const attempt of [
      () =>
        db
          .update(countryComplianceChanges)
          .set({ actor: "someone else" })
          .where(eq(countryComplianceChanges.id, latest!.id)),
      () => db.delete(countryComplianceChanges).where(eq(countryComplianceChanges.id, latest!.id)),
    ]) {
      const error = await attempt().then(
        () => null,
        (e: unknown) => e,
      );
      expect(causeOf(error)).toMatch(/append-only/);
    }
  });
});

describe("ComplianceGate.check — the rules engine", () => {
  it("is a list of named rules, not conditionals scattered through the code", () => {
    expect(COMPLIANCE_RULES.map((r) => r.id)).toEqual([
      "country_halted",
      "phone_inbound_blocked",
      "phone_outbound_blocked",
      "write_consent",
    ]);
  });

  it("refuses phone answering where the matrix blocks it, naming the matrix", async () => {
    const verdict = await check({ ...business(), capability: "phone_answering", country: QM });
    expect(verdict.clear).toBe(false);
    expect(verdict.clear === false && verdict.reasons.join(" ")).toMatch(/compliance matrix/);
  });

  it("clears phone answering once the matrix unblocks the country — no deploy", async () => {
    expect(await check({ ...business(), capability: "phone_answering", country: QN })).toEqual({
      clear: true,
    });
  });

  it("outbound calling stays blocked until its own flag is lifted", async () => {
    const verdict = await check({ ...business(), capability: "phone_outbound", country: QN });
    expect(verdict.clear).toBe(false);
  });

  it("a halted country blocks every external capability, even with consent in hand", async () => {
    await setCountryRule({
      country: QN,
      change: { execution_halted: true },
      actor: "ops: Anna",
      reason: "regulator inquiry",
    });
    const verdict = await check(
      { ...business(), capability: "meta_ads", country: QN, external: true },
      { writeConsent: async () => true },
    );
    expect(verdict.clear).toBe(false);
    expect(verdict.clear === false && verdict.reasons.join(" ")).toMatch(/halted/);
    expect(
      await check({ ...business(), capability: "phone_answering", country: QN }),
    ).toMatchObject({
      clear: false,
    });
    await setCountryRule({
      country: QN,
      change: { execution_halted: false },
      actor: "ops: Anna",
      reason: "inquiry closed",
    });
  });

  it("phone answering for a business whose country isn't known is refused", async () => {
    const verdict = await check({ ...business(), capability: "phone_answering", country: null });
    expect(verdict.clear).toBe(false);
  });
});

describe("an external capability needs a live write consent", () => {
  it("refuses an external capability with no write consent for it", async () => {
    const verdict = await check({
      ...business(),
      capability: "meta_ads",
      country: "HU",
      external: true,
    });
    expect(verdict.clear).toBe(false);
    expect(verdict.clear === false && verdict.reasons.join(" ")).toMatch(/write consent/);
  });

  it("clears it once the consent exists", async () => {
    const verdict = await check(
      { ...business(), capability: "meta_ads", country: "HU", external: true },
      { writeConsent: async () => true },
    );
    expect(verdict).toEqual({ clear: true });
  });

  it("a purchase order's consent is its approval: there is no account to connect", async () => {
    const verdict = await check(
      { ...business(), capability: "purchase_order", country: "HU", external: true },
      {
        writeConsent: async () => {
          throw new Error("must not be asked");
        },
      },
    );
    expect(verdict).toEqual({ clear: true });
  });

  it("asks nothing of an in-repo capability that writes nowhere", async () => {
    const verdict = await check(
      { ...business(), capability: "fixture", country: null, external: false },
      {
        writeConsent: async () => {
          throw new Error("must not be asked");
        },
      },
    );
    expect(verdict).toEqual({ clear: true });
  });

  it("reports every reason at once, not only the first", async () => {
    await setCountryRule({
      country: QO,
      change: { execution_halted: true },
      actor: "ops: test",
      reason: "two reasons",
    });
    const verdict = await check(
      { ...business(), capability: "meta_ads", country: QO, external: true },
      { writeConsent: async () => false },
    );
    expect(verdict.clear === false && verdict.reasons).toHaveLength(2);
  });

  it("phone answering runs on ScaleX's own line: no business account to connect", async () => {
    const verdict = await check(
      { ...business(), capability: "phone_answering", country: QN, external: true },
      {
        writeConsent: async () => {
          throw new Error("must not be asked");
        },
      },
    );
    expect(verdict).toEqual({ clear: true });
  });
});

describe("the old environment flag (architecture-v2 D6), superseded by the matrix", () => {
  it("no longer opens a country: the gate reads the matrix only", async () => {
    const saved = process.env[PHONE_COUNTRIES_KEY];
    process.env[PHONE_COUNTRIES_KEY] = QM;
    try {
      expect(phoneAnsweringAllowed(QM)).toBe(true); // the pure reader still parses it…
      const verdict = await check({ ...business(), capability: "phone_answering", country: QM });
      expect(verdict.clear).toBe(false); // …but nothing obeys it any more.
    } finally {
      if (saved === undefined) delete process.env[PHONE_COUNTRIES_KEY];
      else process.env[PHONE_COUNTRIES_KEY] = saved;
    }
  });
});

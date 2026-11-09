// Session G's service, proven offline. The two claims that matter:
// generation cannot spend Opus twice on an unchanged profile, and every
// recommendation response lands in the append-only decision log.

import "dotenv/config";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  decisionLog,
  diagnosisReports,
  fieldRecords,
  offers,
  profileSnapshots,
  rateLimits,
  snapshotRecords,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { loadBank } from "../bank/loader";
import type { DiagnosisLlm } from "../diagnosis/findings";
import { DiagnosisError } from "../diagnosis/findings";
import type { RecommendationsLlm } from "../diagnosis/recommendations";
import { writeField } from "../profile/field-store";
import { ownerLanguageLine } from "../llm/language";
import { ReportError, generateReport, latestReport, priorOf, respondToRecommendation } from "./service";

let accountId: string;
let profileId: string;
let offerId: string;

const write = (key: string, value: unknown, status: "answered" | "unknown" = "answered") =>
  writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value: status === "answered" ? value : null,
      status,
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: isoDateTime(new Date().toISOString()),
      recorded_at: isoDateTime(new Date().toISOString()),
    }),
  );

let findingsCalls = 0;
let recsCalls = 0;

const findingsLlm: DiagnosisLlm = () => {
  findingsCalls += 1;
  return Promise.resolve({
    text: JSON.stringify({
      summary: "Your margin is thin. Your costs are stale. Fix the first one first.",
      findings: [
        {
          area: "finance",
          title: "Thin margin on the 0.5L",
          detail: "Price and cost sit 900 HUF apart.",
          evidence: [`offers.${offerId}.price`],
          severity: "high",
          confidence: 0.8,
        },
      ],
    }),
    calls: [],
  });
};

const recommendationsLlm: RecommendationsLlm = () => {
  recsCalls += 1;
  return Promise.resolve({
    text: JSON.stringify({
      recommendations: [
        {
          addresses: [0],
          title: "Test a 12% price rise",
          rationale: "Loyal buyers, thin margin.",
          effort: "low",
          reversibility_level: "easy",
          if_you_change_your_mind: "Set the price back; nothing else moves.",
          scenario: {
            kind: "price_change",
            offer_id: offerId,
            change_pct: 12,
            volume_response_base_pct: -5,
            volume_response_downside_pct: -25,
            volume_response_upside_pct: 0,
            gap_field_keys: null,
            gap_why: null,
          },
        },
      ],
    }),
    calls: [],
  });
};

beforeAll(async () => {
  await loadBank("specs/question-bank-v1.json");
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

  const [offer] = await db
    .insert(offers)
    .values({ profile_id: profileId, kind: "physical" })
    .returning();
  offerId = offer!.id;
  await write(`offers.${offerId}.name`, "Szörp 0.5L");
  await write(`offers.${offerId}.price`, { amount_minor: 499_000, currency: "HUF" });
  await write(`offers.${offerId}.cost_to_deliver`, { amount_minor: 409_000, currency: "HUF" });
  await write(`offers.${offerId}.volume_period`, 310);
});

afterAll(async () => {
  await db.delete(diagnosisReports).where(eq(diagnosisReports.profile_id, profileId));
  const snaps = await db
    .select({ id: profileSnapshots.id })
    .from(profileSnapshots)
    .where(eq(profileSnapshots.profile_id, profileId));
  for (const s of snaps) {
    await db.delete(snapshotRecords).where(eq(snapshotRecords.snapshot_id, s.id));
  }
  await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, profileId));
  // decision_log rows stay — the append-only trigger rejects DELETE, and
  // that is the feature (P0-33), not a test inconvenience.
  await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
  await db.delete(offers).where(eq(offers.profile_id, profileId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

describe("P1-34/35 — generation reads a snapshot and assembles §7's structure", () => {
  it("produces summary, economics, findings, recommendations and gaps in one report", async () => {
    const { report, fresh } = await generateReport({
      accountId,
      profileId,
      findingsLlm,
      recommendationsLlm,
    });

    expect(fresh).toBe(true);
    expect(report.snapshot_id).toBeTruthy();
    expect(report.summary).toContain("margin is thin");
    expect(report.unit_economics.offers[0]!.margin_pct!.value).toBeCloseTo(18, 0);
    expect(report.findings[0]!.severity).toBe("high");
    expect(report.recommendations[0]!.status).toBe("proposed");
    expect(report.recommendations[0]!.scenario.breakeven_condition).toContain("sales can fall");
    // gaps link back into the intake by question id (P1-37)
    expect(report.data_gaps.length).toBeGreaterThan(0);
    expect(report.data_gaps[0]!.question_id).toBeTruthy();
    // evidence rendering has the source (P1-36)
    expect(report.fact_map[`offers.${offerId}.price`]!.source_kind).toBe("owner_input");
  });

  it("does NOT spend Opus again while the profile is unchanged — the cost guard", async () => {
    const before = { f: findingsCalls, r: recsCalls };
    const { report, fresh } = await generateReport({
      accountId,
      profileId,
      findingsLlm,
      recommendationsLlm,
    });
    expect(fresh).toBe(false);
    expect(findingsCalls).toBe(before.f);
    expect(recsCalls).toBe(before.r);

    const rows = await db
      .select()
      .from(diagnosisReports)
      .where(eq(diagnosisReports.profile_id, profileId));
    expect(rows).toHaveLength(1);
    expect(report.id).toBe(rows[0]!.id);
  });

  it("a changed profile generates fresh — new snapshot, new report", async () => {
    await write("goals.main_goal", "növekedés");
    const { fresh } = await generateReport({
      accountId,
      profileId,
      findingsLlm,
      recommendationsLlm,
    });
    expect(fresh).toBe(true);
    const rows = await db
      .select()
      .from(diagnosisReports)
      .where(eq(diagnosisReports.profile_id, profileId));
    expect(rows).toHaveLength(2);
  });

  it("the view carries the prior report and the superseded history, read-only", async () => {
    // goals.main_goal was written once above; a second answer supersedes it (rule 3).
    await write("goals.main_goal", "stabilitás");
    const view = await latestReport(profileId);
    expect(view).not.toBeNull();
    const rows = await db
      .select()
      .from(diagnosisReports)
      .where(eq(diagnosisReports.profile_id, profileId))
      .orderBy(desc(diagnosisReports.generated_at));
    // the newest report's prior is the one issued before it
    expect(view!.id).toBe(rows[0]!.id);
    expect(view!.prior?.id).toBe(rows[1]!.id);
    expect(view!.prior?.unit_economics.offers[0]!.margin_pct!.value).toBeCloseTo(18, 0);
    // the old answer is in the history, struck but kept
    const past = view!.history["goals.main_goal"];
    expect(past).toHaveLength(1);
    expect(past![0]!.value).toBe("növekedés");
    expect(past![0]!.superseded_at).toBeTruthy();
    // a report with nothing before it has no prior
    expect(priorOf(undefined)).toBeNull();
  });
});

describe("P1-38/39 — responses update the report and append to the decision log", () => {
  it("declining stores the reason and writes an owner rejection to the log", async () => {
    const report = (await latestReport(profileId))!;
    const rec = await respondToRecommendation({
      profileId,
      reportId: report.id,
      index: 0,
      response: "not_for_us",
      reason: "we tried this before",
    });
    expect(rec.status).toBe("rejected");
    expect(rec.rejection_reason).toBe("we tried this before");

    const reread = (await latestReport(profileId))!;
    expect(reread.recommendations[0]!.status).toBe("rejected");

    const [entry] = await db
      .select()
      .from(decisionLog)
      .where(eq(decisionLog.profile_id, profileId))
      .orderBy(desc(decisionLog.at))
      .limit(1);
    expect(entry!.actor).toBe("owner");
    expect(entry!.kind).toBe("rejection");
    expect(entry!.ref_id).toBe(`${report.id}#0`);
    expect(entry!.payload_hash).toHaveLength(64);
  });

  it("accepting writes an approval; a second response appends, never edits", async () => {
    const report = (await latestReport(profileId))!;
    const rec = await respondToRecommendation({
      profileId,
      reportId: report.id,
      index: 0,
      response: "look_into",
    });
    expect(rec.status).toBe("accepted");
    expect(rec.rejection_reason).toBeNull();

    const entries = await db
      .select()
      .from(decisionLog)
      .where(eq(decisionLog.profile_id, profileId));
    const responses = entries.filter((e) => e.ref_id.startsWith(report.id));
    expect(responses).toHaveLength(2); // rejection then approval — both kept
  });

  it("refuses a response to a report that is not this profile's", async () => {
    await expect(
      respondToRecommendation({
        profileId,
        reportId: "00000000-0000-0000-0000-000000000000",
        index: 0,
        response: "look_into",
      }),
    ).rejects.toThrow(DiagnosisError);
  });
});

describe("L-5 — the report is written in its generator's language, and says so", () => {
  it("tells both Opus calls the language, records it, and keeps the cost guard", async () => {
    const before = await latestReport(profileId);
    expect(before?.language).toBe("en"); // every report so far: English
    await write("goals.main_goal", "Wachstum");
    const systems: string[] = [];
    const { report, fresh } = await generateReport({
      accountId,
      profileId,
      findingsLlm: (a) => (systems.push(a.system), findingsLlm(a)),
      recommendationsLlm: (a) => (systems.push(a.system), recommendationsLlm(a)),
      locale: "de-DE",
    });
    expect(fresh).toBe(true);
    expect(systems).toHaveLength(2);
    for (const s of systems) {
      expect(s.endsWith(ownerLanguageLine("de-DE"))).toBe(true);
      expect(s).toContain('in German, addressing them formally, as "Sie"');
    }
    expect(report.language).toBe("de-DE");
    expect((await latestReport(profileId))?.language).toBe("de-DE");
    // A reader in Chinese asking again gets the German report, nothing spent.
    const again = await generateReport({
      accountId,
      profileId,
      findingsLlm,
      recommendationsLlm,
      locale: "zh-Hans",
    });
    expect(again.fresh).toBe(false);
    expect(again.report.language).toBe("de-DE");
  });
});

describe("security review 2026-11-09 — fresh generation is rate-limited", () => {
  // Its own account/profile: the shared fixture above is also asserting an
  // exact findings/recs call count, which a rate-limit test must not disturb.
  let rlAccountId: string;
  let rlProfileId: string;
  let rlOfferId: string;
  let i = 0;

  beforeAll(async () => {
    const [account] = await db
      .insert(accounts)
      .values({ reporting_currency: "EUR", locale: "en" })
      .returning();
    const [profile] = await db
      .insert(businessProfiles)
      .values({ account_id: account!.id, schema_version: "1.0.0" })
      .returning();
    rlAccountId = account!.id;
    rlProfileId = profile!.id;
    const [offer] = await db
      .insert(offers)
      .values({ profile_id: rlProfileId, kind: "physical" })
      .returning();
    rlOfferId = offer!.id;
    const field = (key: string, value: unknown) =>
      writeField(
        rlProfileId,
        createField<unknown>({
          id: fieldId(key),
          value,
          status: "answered",
          confidence: 0.75,
          source: { kind: "owner_input" },
          observed_at: isoDateTime(new Date().toISOString()),
          recorded_at: isoDateTime(new Date().toISOString()),
        }),
      );
    await field(`offers.${rlOfferId}.name`, "Rate-limit test offer");
    await field(`offers.${rlOfferId}.price`, { amount_minor: 1_000, currency: "EUR" });
    await field(`offers.${rlOfferId}.cost_to_deliver`, { amount_minor: 500, currency: "EUR" });
    await field(`offers.${rlOfferId}.volume_period`, 100);
  });

  afterAll(async () => {
    await db.delete(rateLimits).where(eq(rateLimits.key, `report:fresh:${rlProfileId}:86400000`));
    await db.delete(diagnosisReports).where(eq(diagnosisReports.profile_id, rlProfileId));
    const snaps = await db
      .select({ id: profileSnapshots.id })
      .from(profileSnapshots)
      .where(eq(profileSnapshots.profile_id, rlProfileId));
    for (const s of snaps) {
      await db.delete(snapshotRecords).where(eq(snapshotRecords.snapshot_id, s.id));
    }
    await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, rlProfileId));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, rlProfileId));
    await db.delete(offers).where(eq(offers.profile_id, rlProfileId));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, rlProfileId));
    await db.delete(accounts).where(eq(accounts.id, rlAccountId));
  });

  // Forces a genuinely different snapshot each call, so the cost guard
  // (unchanged profile → fresh: false, no limit spent) never masks this.
  async function freshGenerate(): Promise<{ fresh: boolean }> {
    i += 1;
    await writeField(
      rlProfileId,
      createField<unknown>({
        id: fieldId("goals.main_goal"),
        value: `goal ${i}`,
        status: "answered",
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: isoDateTime(new Date().toISOString()),
        recorded_at: isoDateTime(new Date().toISOString()),
      }),
    );
    const rlFindingsLlm: DiagnosisLlm = () =>
      Promise.resolve({
        text: JSON.stringify({
          summary: "Price looks thin.",
          findings: [
            {
              area: "finance",
              title: "Thin margin",
              detail: "Price sits close to nothing.",
              evidence: [`offers.${rlOfferId}.price`],
              severity: "low",
              confidence: 0.6,
            },
          ],
        }),
        calls: [],
      });
    const rlRecommendationsLlm: RecommendationsLlm = () =>
      Promise.resolve({
        text: JSON.stringify({
          recommendations: [
            {
              addresses: [0],
              title: "Test a price rise",
              rationale: "Thin margin.",
              effort: "low",
              reversibility_level: "easy",
              if_you_change_your_mind: "Set the price back; nothing else moves.",
              scenario: {
                kind: "price_change",
                offer_id: rlOfferId,
                change_pct: 10,
                volume_response_base_pct: -5,
                volume_response_downside_pct: -20,
                volume_response_upside_pct: 0,
                gap_field_keys: null,
                gap_why: null,
              },
            },
          ],
        }),
        calls: [],
      });
    return generateReport({
      accountId: rlAccountId,
      profileId: rlProfileId,
      findingsLlm: rlFindingsLlm,
      recommendationsLlm: rlRecommendationsLlm,
    });
  }

  it("allows 10 fresh generations a day, then refuses the 11th with a 429", async () => {
    for (let n = 0; n < 10; n++) {
      const { fresh } = await freshGenerate();
      expect(fresh).toBe(true);
    }
    await expect(freshGenerate()).rejects.toMatchObject({ status: 429, name: "ReportError" });
    await expect(freshGenerate()).rejects.toBeInstanceOf(ReportError);
  });
});

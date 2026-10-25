// M-2: the recalibration run on a fake client and a real (test) database.
// The load-bearing claim: it writes NOTHING to the profile — no snapshot,
// no report, no field — while running both models on the stored snapshot
// with the app's own prompt and judging both with the app's own checks.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  refuse55: false,
}));

vi.mock("../llm/client", () => {
  const usage = {
    input_tokens: 3_000,
    output_tokens: 1_200,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const reply = (model: string, text: string, stop = "end_turn") => ({
    model,
    stop_reason: stop,
    stop_details:
      stop === "refusal" ? { type: "refusal", category: "bio", explanation: null } : null,
    content: [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text },
    ],
    usage,
  });
  const finding = (title: string, severity: string, evidence: string[]) => ({
    area: "finance",
    title,
    detail: "d",
    evidence,
    severity,
    confidence: 0.7,
  });
  return {
    anthropicClient: () => ({
      messages: {
        create: async (params: Record<string, unknown>) => {
          fake.sent.push(params);
          const model = params.model as string;
          if (model.startsWith("claude-opus")) {
            if (model === "claude-opus-5-5" && fake.refuse55) return reply(model, "{}", "refusal");
            const findings =
              model === "claude-opus-4-8"
                ? [finding("Fixed costs are unknown", "critical", ["costs.fixed_monthly"])]
                : [
                    finding("You don't know your fixed costs", "high", ["costs.fixed_monthly"]),
                    finding("Invented", "low", ["made.up_field"]),
                  ];
            return reply(model, JSON.stringify({ summary: "A. B. C.", findings }));
          }
          // The interviewer: the first candidate, whichever Sonnet asks.
          const user = (params.messages as { content: string }[])[0]?.content ?? "";
          const id = /CANDIDATES \(choose exactly one\): ([^,\n]+)/.exec(user)?.[1]?.trim() ?? "";
          return reply(model, JSON.stringify({ next_question_id: id, selection_reason: "first" }));
        },
      },
    }),
  };
});

const { db } = await import("../../db");
const schema = await import("../../db/schema");
const {
  accounts,
  businessProfiles,
  diagnosisReports,
  fieldRecords,
  llmCalls,
  profileSnapshots,
  snapshotRecords,
} = schema;
const { loadBank } = await import("../bank/loader");
const { createField } = await import("../core/field");
const { fieldId } = await import("../core/ids");
const { isoDateTime } = await import("../core/iso");
const { writeField } = await import("../profile/field-store");
const { takeSnapshot } = await import("../profile/snapshot");
const run = await import("./recalibrate-run");

const ACCT = "00000000-0000-4000-8000-0000000c0ffe";
let accountId = "";
let profileId = "";
let snapshotId = "";

async function counts() {
  const [snaps, records, reports] = await Promise.all([
    db.select().from(profileSnapshots).where(eq(profileSnapshots.profile_id, profileId)),
    db.select().from(fieldRecords).where(eq(fieldRecords.profile_id, profileId)),
    db.select().from(diagnosisReports).where(eq(diagnosisReports.profile_id, profileId)),
  ]);
  return { snaps: snaps.length, records: records.length, reports: reports.length };
}

beforeAll(async () => {
  await loadBank("specs/question-bank-v1.json");
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "EUR", locale: "en-GB" })
    .returning();
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account!.id, schema_version: "1.0.0" })
    .returning();
  accountId = account!.id;
  profileId = profile!.id;
  const at = isoDateTime(new Date().toISOString());
  const write = (key: string, value: unknown, status: "answered" | "unknown") =>
    writeField(
      profileId,
      createField<unknown>({
        id: fieldId(key),
        value,
        status,
        confidence: 0.75,
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
      }),
    );
  await write("identity.legal_name", "Synthetic Bakery Kft.", "answered");
  await write("identity.description", "A small sourdough bakery", "answered");
  await write("costs.fixed_monthly", null, "unknown");
  snapshotId = (await takeSnapshot(profileId, "report")).id;
});

beforeEach(() => {
  fake.sent.length = 0;
  fake.refuse55 = false;
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await db.delete(llmCalls).where(eq(llmCalls.account_id, ACCT));
  const snaps = await db
    .select({ id: profileSnapshots.id })
    .from(profileSnapshots)
    .where(eq(profileSnapshots.profile_id, profileId));
  for (const s of snaps)
    await db.delete(snapshotRecords).where(eq(snapshotRecords.snapshot_id, s.id));
  await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, profileId));
  await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

describe("recalibrate:diagnosis on a stored snapshot", () => {
  it("finds the stored snapshot and names the business", async () => {
    const [t] = await run.diagnosisTargets({ profiles: [profileId] });
    expect(t).toEqual({
      profile_id: profileId,
      snapshot_id: snapshotId,
      label: "Synthetic Bakery Kft.",
    });
  });

  it("runs both Opus models on the same prompt, compares them, and writes nothing to the profile", async () => {
    const before = await counts();
    const targets = await run.diagnosisTargets({ profiles: [profileId] });
    const { prepared, skipped } = await run.prepareDiagnosis(targets);
    expect(skipped).toEqual([]);
    expect(prepared[0]?.prompt.user).toContain("costs.fixed_monthly = (unknown)");

    const est = run.estimateDiagnosisEur(prepared, ["claude-opus-4-8", "claude-opus-5-5"]);
    expect(est.per_model["claude-opus-5-5"]).toBeGreaterThan(0);
    expect(est.total).toBeCloseTo(
      (est.per_model["claude-opus-4-8"] ?? 0) + (est.per_model["claude-opus-5-5"] ?? 0),
      9,
    );

    const rows = await run.runDiagnosisComparison({
      prepared,
      models: ["claude-opus-4-8", "claude-opus-5-5"],
      accountId: ACCT,
    });
    expect(fake.sent.map((p) => p.model)).toEqual(["claude-opus-4-8", "claude-opus-5-5"]);
    expect(fake.sent[0]?.system).toBe(fake.sent[1]?.system);
    expect((fake.sent[0]?.messages as unknown[])[0]).toEqual(
      (fake.sent[1]?.messages as unknown[])[0],
    );
    expect((fake.sent[1]?.output_config as { effort?: string }).effort).toBe("high");

    const [row] = rows;
    expect(row?.snapshot_id).toBe(snapshotId);
    expect(row?.match.pairs).toHaveLength(1);
    expect(row?.severity_changes[0]?.b.severity).toBe("high");
    expect(row?.grounding.b).toMatchObject({ returned: 2, kept: 1, rejected: 1 });
    expect(row?.a.cost_eur).toBeGreaterThan(0); // the app's own cost lines, captured
    expect(row?.b.cost_eur).toBeLessThan(row!.a.cost_eur); // Opus 5.5 is cheaper per token

    expect(await counts()).toEqual(before); // no snapshot, no report, no field
    const metered = await db.select().from(llmCalls).where(eq(llmCalls.account_id, ACCT));
    expect(metered.map((r) => r.model).sort()).toEqual(["claude-opus-4-8", "claude-opus-5-5"]);
    expect(await db.select().from(llmCalls).where(eq(llmCalls.account_id, accountId))).toEqual([]);
  });

  it("counts a refusal as a refusal, with the cost the app logged", async () => {
    fake.refuse55 = true;
    const { prepared } = await run.prepareDiagnosis(
      await run.diagnosisTargets({ profiles: [profileId] }),
    );
    const [row] = await run.runDiagnosisComparison({
      prepared,
      models: ["claude-opus-4-8", "claude-opus-5-5"],
      accountId: ACCT,
    });
    expect(row?.b.refusal).toBe("bio");
    expect(row?.b.cost_eur).toBeGreaterThan(0);
    expect(row?.a.findings).toHaveLength(1);
  });

  it("skips a profile with no stored snapshot rather than taking one", async () => {
    const { skipped, prepared } = await run.prepareDiagnosis([
      { profile_id: profileId, snapshot_id: null, label: "x" },
    ]);
    expect(prepared).toEqual([]);
    expect(skipped[0]?.reason).toMatch(/no stored snapshot/);
  });
});

describe("recalibrate:diagnosis --sonnet", () => {
  it("asks both Sonnets for the next question on the stored intake state", async () => {
    const before = await counts();
    const targets = await run.intakeTargets({ profiles: [profileId] });
    const est = await run.estimateSonnetEur(targets.length, [
      "claude-sonnet-5",
      "claude-sonnet-5-5",
    ]);
    expect(est.total).toBeGreaterThan(0);
    const [row] = await run.runPickComparison({
      targets,
      models: ["claude-sonnet-5", "claude-sonnet-5-5"],
      accountId: ACCT,
    });
    expect(fake.sent.map((p) => p.model)).toEqual(["claude-sonnet-5", "claude-sonnet-5-5"]);
    expect(fake.sent.map((p) => p.thinking)).toEqual([
      { type: "disabled" },
      { type: "between_tools" },
    ]);
    expect(row?.same).toBe(true);
    expect(row?.candidates).toBeGreaterThan(0);
    expect(row?.a.calls).toBe(1);
    expect(await counts()).toEqual(before);
  });
});

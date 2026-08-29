// Session E, proven offline. The load-bearing claim is P1-24: no finding
// exists without evidence pointing at real snapshot fields, and that is
// CODE — testable without a model, a network, or a prompt. The prompt
// itself is provisional (see findings.ts header) and untested by design.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  profileSnapshots,
  snapshotRecords,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { loadBank } from "../bank/loader";
import { writeField } from "../profile/field-store";
import type { DiagnosisLlm } from "./findings";
import {
  DiagnosisError,
  runDiagnosis,
  SEVERITY_LABEL,
  sortFindings,
  threeSentences,
  validateFindings,
} from "./findings";

const KEYS = new Set(["revenue.monthly_revenue", "costs.fixed_monthly", "identity.description"]);

const GOOD = {
  area: "finance",
  title: "Fixed costs are unknown",
  detail: "You have not recorded what the business spends monthly.",
  evidence: ["costs.fixed_monthly"],
  severity: "high",
  confidence: 0.7,
};

describe("P1-24 — evidence is enforced in code, not in the prompt", () => {
  it("keeps a finding whose evidence names real snapshot fields", () => {
    const { kept, rejected } = validateFindings([GOOD], KEYS);
    expect(kept).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("rejects an empty evidence array — never repairs it", () => {
    const { kept, rejected } = validateFindings([{ ...GOOD, evidence: [] }], KEYS);
    expect(kept).toHaveLength(0);
    expect(rejected[0]!.reason).toMatch(/empty evidence/);
  });

  it("rejects evidence citing a field the snapshot does not hold", () => {
    const { kept, rejected } = validateFindings(
      [{ ...GOOD, evidence: ["costs.fixed_monthly", "made.up_field"] }],
      KEYS,
    );
    expect(kept).toHaveLength(0);
    expect(rejected[0]!.reason).toContain("made.up_field");
  });

  it("rejects bad severity, area, confidence, and blank text — each named", () => {
    const { kept, rejected } = validateFindings(
      [
        { ...GOOD, severity: "catastrophic" },
        { ...GOOD, area: "astrology" },
        { ...GOOD, confidence: 1.4 },
        { ...GOOD, title: "  " },
        GOOD,
      ],
      KEYS,
    );
    expect(kept).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    expect(rejected.map((r) => r.reason).join("\n")).toMatch(/severity/);
    expect(rejected.map((r) => r.reason).join("\n")).toMatch(/area/);
    expect(rejected.map((r) => r.reason).join("\n")).toMatch(/confidence/);
  });
});

describe("P1-25 — ordering and the three-sentence summary", () => {
  it("orders severest first, stable within a severity", () => {
    const sorted = sortFindings([
      { ...GOOD, title: "low A", severity: "low" },
      { ...GOOD, title: "critical", severity: "critical" },
      { ...GOOD, title: "low B", severity: "low" },
      { ...GOOD, title: "medium", severity: "medium" },
    ] as never);
    expect(sorted.map((f) => f.title)).toEqual(["critical", "medium", "low A", "low B"]);
  });

  it("trims a rambling summary to three sentences, never pads a short one", () => {
    expect(threeSentences("One. Two! Three? Four. Five.")).toBe("One. Two! Three?");
    expect(threeSentences("Only one sentence.")).toBe("Only one sentence.");
    expect(threeSentences("No terminator at all")).toBe("No terminator at all");
  });

  it("does not split inside decimals — the first live run's bug", () => {
    expect(
      threeSentences("Szörp 0.5L returns 4.5 million HUF. Second sentence. Third. Fourth."),
    ).toBe("Szörp 0.5L returns 4.5 million HUF. Second sentence. Third.");
  });
});

describe("P1-26 — severity is a mono label, never a colour", () => {
  it("exports labels and deliberately no colour map", async () => {
    expect(Object.values(SEVERITY_LABEL)).toEqual(["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
    const mod = await import("./findings");
    expect(Object.keys(mod).some((k) => /colou?r/i.test(k))).toBe(false);
  });
});

/* ── the run, against a real profile ── */

let accountId: string;
let profileId: string;

function stubLlm(reply: unknown): { llm: DiagnosisLlm; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    llm: ({ user }) => {
      prompts.push(user);
      return Promise.resolve({
        text: typeof reply === "string" ? reply : JSON.stringify(reply),
        calls: [
          {
            at: new Date().toISOString(),
            event: "llm_call" as const,
            workload: "diagnosis",
            account_id: accountId,
            model: "claude-opus-4-8",
            duration_ms: 12,
            input_tokens: 9_000,
            output_tokens: 1_200,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            cost_eur: 0.069,
          },
        ],
      });
    },
  };
}

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

  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId("identity.description"),
      value: "Kézműves szörpök",
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId("costs.fixed_monthly"),
      value: null,
      status: "unknown",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
});

afterAll(async () => {
  const snaps = await db
    .select({ id: profileSnapshots.id })
    .from(profileSnapshots)
    .where(eq(profileSnapshots.profile_id, profileId));
  for (const s of snaps) {
    await db.delete(snapshotRecords).where(eq(snapshotRecords.snapshot_id, s.id));
  }
  await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, profileId));
  await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, profileId));
  await db.delete(businessProfiles).where(eq(businessProfiles.id, profileId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
});

describe("P1-22/23/27 — the run", () => {
  it("hands the model the snapshot with provenance, and keeps only evidenced findings", async () => {
    const { llm, prompts } = stubLlm({
      summary: "You do not know your fixed costs. That blinds every margin question. Fix it first.",
      findings: [
        {
          area: "finance",
          title: "Fixed costs unknown",
          detail: "The profile records an explicit unknown for monthly fixed costs.",
          evidence: ["costs.fixed_monthly"],
          severity: "critical",
          confidence: 0.8,
        },
        {
          area: "finance",
          title: "Invented claim",
          detail: "Cites a field that does not exist.",
          evidence: ["revenue.monthly_revenue"],
          severity: "high",
          confidence: 0.9,
        },
      ],
    });

    const result = await runDiagnosis({ accountId, profileId, llm });

    // The prompt shows facts with status/confidence/source — provenance in.
    expect(prompts[0]).toContain("costs.fixed_monthly = (unknown)");
    expect(prompts[0]).toContain("source=owner_input");

    // The evidenced finding survives; the invented one is rejected, visibly.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.title).toBe("Fixed costs unknown");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toContain("revenue.monthly_revenue");

    // A snapshot backs it, the summary is three sentences, cost is measured.
    expect(result.snapshot_id).toBeTruthy();
    expect(result.summary.match(/[.!?]/g)!.length).toBeLessThanOrEqual(3);
    expect(result.cost_eur).toBeCloseTo(0.069);
  });

  it("throws rather than returning a diagnosis with zero surviving findings", async () => {
    const { llm } = stubLlm({
      summary: "x",
      findings: [{ ...GOOD, evidence: ["not.a_real_field"] }],
    });
    await expect(runDiagnosis({ accountId, profileId, llm })).rejects.toThrow(DiagnosisError);
  });

  it("throws on non-JSON output", async () => {
    const { llm } = stubLlm("I think this business is fine, overall!");
    await expect(runDiagnosis({ accountId, profileId, llm })).rejects.toThrow(/non-JSON/);
  });
});

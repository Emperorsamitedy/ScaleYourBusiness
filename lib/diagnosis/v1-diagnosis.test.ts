// The diagnosis rebuild — the v1 build spec §6.6's acceptance criteria and
// Phase 3's gate (§12): "No euro headline at grade C or D in any locale.
// Re-diagnosis produces a diff."

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { headline } from "../../components/report/panel";
import { db } from "../../db";
import { accounts, businessProfiles, intakeEvents, leaks } from "../../db/schema";
import { money } from "../core/money";
import { LOCALES } from "../i18n/locales";
import { bootstrapIntake } from "../intake/service";
import {
  FIRST_INTERVIEW_SECONDS,
  secondsOf,
  spentSeconds,
  withinBudget,
} from "../interviewer/budget";
import { closePlan } from "../ledger/close";
import { openPlan } from "../ledger/plans";
import type { ApplicableQuestion } from "../resolver/applicability";
import { gradeFromCoverage, headlineMoneyAllowed } from "./diagnosis-grade";
import { diffReports } from "./diff";
import { LeakError, leaksOf, moveLeak, registerLeaks } from "./leaks";
import { priceGaps } from "./priced-gaps";

const created: { account_id: string; profile_id: string }[] = [];
afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

const cover = (provider: string, days: number, huf: number) => ({
  provider,
  connection_id: provider,
  days,
  totals: { HUF: huf },
});

describe("§6.2 — the Diagnosis Grade", () => {
  it("D with nothing measured, C under 60 days, B with 60, A when two sources agree", () => {
    expect(gradeFromCoverage([]).grade).toBe("D");
    expect(gradeFromCoverage([cover("stripe", 30, 100)]).grade).toBe("C");
    expect(gradeFromCoverage([cover("stripe", 60, 100)]).grade).toBe("B");
    expect(
      gradeFromCoverage([cover("stripe", 90, 1_000_000), cover("nav_online_szamla", 75, 1_030_000)])
        .grade,
    ).toBe("A");
  });

  it("two sources that disagree by more than 5 % are B, not A", () => {
    expect(
      gradeFromCoverage([cover("stripe", 90, 1_000_000), cover("shopify", 90, 1_200_000)]).grade,
    ).toBe("B");
  });

  it("says what to connect next while it's below A", () => {
    expect(gradeFromCoverage([]).connect_next.length).toBeGreaterThan(0);
  });
});

describe("PHASE 3 GATE — no money headline at grade C or D, in any locale", () => {
  const recs = [
    {
      title: "Raise the gift box price",
      scenario: {
        downside_case: { profit_delta_monthly: money(10_000, "EUR") },
        base_case: { profit_delta_monthly: money(20_000, "EUR") },
        upside_case: { profit_delta_monthly: money(30_000, "EUR") },
      },
    },
  ] as never;

  it("A and B may lead with money; C and D may not — the same in every language", () => {
    for (const grade of ["A", "B"] as const) {
      expect(headlineMoneyAllowed(grade)).toBe(true);
      expect(headline(recs, grade)).not.toBeNull();
    }
    for (const grade of ["C", "D"] as const) {
      expect(headlineMoneyAllowed(grade)).toBe(false);
      for (const locale of LOCALES) expect(headline(recs, grade), `${grade} ${locale}`).toBeNull();
    }
  });
});

describe("§6.3 — gaps become priced questions", () => {
  it("prices a gap by the recommendations resting on it, ranks by value per minute, marks the first week", () => {
    const gaps = [
      { question_id: "4.1a", field_key: "revenue.monthly_revenue", prompt: "Monthly revenue" },
      { question_id: "5.1", field_key: "costs.fixed_monthly", prompt: "Fixed costs" },
      { question_id: "1.6a", field_key: "identity.size_band", prompt: "Size" },
      { question_id: "9.2", field_key: "operations.staff", prompt: "Staff" },
    ];
    const stakes = [
      { cites: ["revenue.monthly_revenue"], low: money(50_000, "EUR"), high: money(90_000, "EUR") },
      { cites: ["costs.fixed_monthly"], low: money(20_000, "EUR"), high: money(40_000, "EUR") },
    ];
    const priced = priceGaps(gaps, stakes);
    expect(priced[0]).toMatchObject({
      field_key: "revenue.monthly_revenue",
      unlock_method: "connect",
      unlock_value_range: [{ low: money(50_000, "EUR"), high: money(90_000, "EUR") }],
      first_week: true,
    });
    expect(priced.filter((p) => p.first_week)).toHaveLength(3);
    // Nothing rests on the size band: no money is claimed for it.
    expect(priced.find((p) => p.field_key === "identity.size_band")?.unlock_value_range).toEqual(
      [],
    );
    for (const p of priced) expect(p.effort_minutes).toBeGreaterThan(0);
  });
});

describe("§6.4 — re-diagnosis is a diff, not a fresh document", () => {
  it("names what's new, what went away, what's still open, and the grade's move", () => {
    const prev = {
      id: "r1",
      generated_at: "2026-10-01",
      grade: "D" as const,
      findings: [
        { key: "f-margin", title: "Thin margin on gift boxes", severity: "high" },
        { key: "f-hours", title: "Quiet Tuesdays", severity: "low" },
      ],
      figures: { "margin.gift_box": 1_800, aov: 4_990 },
    };
    const next = {
      id: "r2",
      generated_at: "2026-11-01",
      grade: "B" as const,
      findings: [
        { key: "f-margin", title: "Thin margin on gift boxes", severity: "high" },
        { key: "f-carts", title: "Abandoned carts", severity: "act_now" },
      ],
      figures: { "margin.gift_box": 2_100, aov: 4_990 },
    };
    const d = diffReports(prev, next, 2);
    expect(d.version).toBe(2);
    expect(d.grade).toEqual({ from: "D", to: "B", moved: "up" });
    expect(d.new_findings.map((f) => f.key)).toEqual(["f-carts"]);
    expect(d.resolved_findings.map((f) => f.key)).toEqual(["f-hours"]);
    expect(d.still_open.map((f) => f.key)).toEqual(["f-margin"]);
    expect(d.changed_figures).toEqual([{ key: "margin.gift_box", from: 1_800, to: 2_100 }]);
  });
});

describe("§6.5 — the first interview: 8 minutes, nothing a connector holds", () => {
  const q = (id: string, writes_to: string, cost: number): ApplicableQuestion =>
    ({ id, writes_to, cost, priority: "core" }) as ApplicableQuestion;

  it("the generator never lets the first interview pass 8 minutes", () => {
    const bank = Array.from({ length: 60 }, (_, i) => q(`q${i}`, `f.${i}`, (i % 3) + 1));
    const answered = new Set<string>();
    for (;;) {
      const spent = spentSeconds(bank, answered);
      const open = bank.filter((x) => !answered.has(x.writes_to));
      const next = withinBudget(
        open,
        { spent_seconds: spent, limit_seconds: FIRST_INTERVIEW_SECONDS },
        new Set(),
      )[0];
      if (!next) break;
      answered.add(next.writes_to);
    }
    expect(spentSeconds(bank, answered)).toBeLessThanOrEqual(FIRST_INTERVIEW_SECONDS);
    expect(answered.size).toBeLessThan(60); // the rest fills progressively
    expect(secondsOf(3)).toBeGreaterThan(secondsOf(1));
  });

  it("a question whose answer a live connector holds is never asked", () => {
    const qs = [q("4.1a", "revenue.monthly_revenue", 1), q("1.1", "identity.name", 1)];
    expect(withinBudget(qs, null, new Set(["revenue.daily"])).map((x) => x.id)).toEqual(["1.1"]);
    expect(withinBudget(qs, null, new Set()).map((x) => x.id)).toEqual(["4.1a", "1.1"]);
  });
});

describe("§6.6 — a leak is fixed-and-verified only with a verified gain", () => {
  async function gain(s: { profile_id: string; account_id: string }, observed: number) {
    const { plan } = await openPlan({
      profileId: s.profile_id,
      accountId: s.account_id,
      provider: "fixture",
      action_summary: "Raise the gift box price",
      hypothesis: "Margin improves",
      expected: {
        effect: money(10_000, "EUR"),
        low: money(5_000, "EUR"),
        high: money(15_000, "EUR"),
      },
      currency: "EUR",
      reversible: true,
      opened_by: "agent",
      station: 3,
      shadow: false,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    return closePlan(plan.id, {
      observed_minor: observed,
      low_minor: observed - 2_000,
      high_minor: observed + 2_000,
      method_notes: "t",
    });
  }

  it("opens each leak once, refuses 'fixed' without proof or with a loss, accepts a verified gain", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const found = [
      {
        key: "f-margin",
        title: "Thin margin",
        low: money(5_000, "EUR"),
        high: money(15_000, "EUR"),
        grade: "D",
      },
    ];
    expect(await registerLeaks(s.profile_id, crypto.randomUUID(), found)).toBe(1);
    expect(await registerLeaks(s.profile_id, crypto.randomUUID(), found)).toBe(0);
    const [leak] = await leaksOf(s.profile_id);

    await expect(
      moveLeak({ profileId: s.profile_id, leakId: leak!.id, to: "fixed_and_verified", by: null }),
    ).rejects.toBeInstanceOf(LeakError);
    const loss = await gain(s, -8_000);
    await expect(
      moveLeak({
        profileId: s.profile_id,
        leakId: leak!.id,
        to: "fixed_and_verified",
        by: null,
        verifiedEntryId: loss.id,
      }),
    ).rejects.toThrow(/only a verified gain/);
    const win = await gain(s, 12_000);
    const fixed = await moveLeak({
      profileId: s.profile_id,
      leakId: leak!.id,
      to: "fixed_and_verified",
      by: null,
      verifiedEntryId: win.id,
    });
    expect(fixed.status).toBe("fixed_and_verified");

    // The table itself refuses the status without its proof.
    const error = await db
      .update(leaks)
      .set({ verified_entry_id: null })
      .where(eq(leaks.id, leak!.id))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(String((error as { cause?: { message?: string } })?.cause?.message)).toMatch(
      /leaks_verified_needs_entry/,
    );
  });
});

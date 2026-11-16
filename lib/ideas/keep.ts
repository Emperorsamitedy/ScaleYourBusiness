// Keeping an idea — TASKS-IDEAS.md part 2 (I-10, I-32, I-50, I-51, I-52).
//
// An idea check becomes an idea business: its own account and profile
// (one account, one profile — the v1 invariant), made an idea from the
// start, for the same verified email (idea 52's "add a business"). What the
// person stated is written as owner-stated facts (grade D) where the data
// model has a field for it; the whole plan stays on its idea_checks row.
// An idea has no connection, proposal or execution (rule 40, held by
// triggers in migration 0124). Launching makes it an operating business,
// one way; the stated plan stays as it was and is set beside what gets
// measured (I-51), never swapped for it.

import { createHash } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, decisionLog, ideaChecks, ideaTestResults } from "../../db/schema";
import type { AuthedSession, RedeemedSession } from "../auth/service";
import { addBusiness } from "../auth/switch";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import type { AppLocale } from "../i18n/locales";
import { writeField } from "../profile/field-store";
import { dailySeries, shiftDay } from "../trust/series";
import type { IdeaAnswers, IdeaResult } from "./check";
import { IdeaError } from "./check";
import type { AssumptionLine, PlanVsActual, TestReading } from "./progress";
import {
  MIN_MEASURED_DAYS,
  assumptionsVsActual,
  firstConnector,
  planVsActual,
  scoreTest,
} from "./progress";
import { toMinor } from "./units";
import { loadFactWords } from "../bank/words";
import { trFor } from "../i18n/server-tr";
import { citiesOf } from "./local";

const hash = (payload: unknown) =>
  createHash("sha256").update(JSON.stringify(payload)).digest("hex");

/** The plan's monthly revenue at full plan, in minor units, or null when the customers weren't known. */
export function plannedRevenue(a: IdeaAnswers): { amount_minor: number; currency: string } | null {
  if (a.revenue_model === "recruitment" || a.price === null || a.customers_month === null) {
    return null;
  }
  return { amount_minor: a.customers_month * toMinor(a.price, a.currency), currency: a.currency };
}

/** Gap 4: "Café idea · Budapest", in the person's language — the switcher's name until launch. */
export async function ideaLabel(a: IdeaAnswers, language: AppLocale): Promise<string> {
  const words = await loadFactWords(language);
  const english = await loadFactWords("en");
  const type =
    words.value("identity.business_type", a.sector) ??
    english.value("identity.business_type", a.sector) ??
    a.sector;
  const city = a.city ? citiesOf(a.country).find((c) => c.id === a.city) : undefined;
  const place =
    city?.names[language] ??
    city?.names.en ??
    new Intl.DisplayNames([language], { type: "region" }).of(a.country) ??
    a.country;
  return trFor(language, "ideas")("keep.label", { type, place });
}

/** What the person stated, as facts the rest of the system reads (grade D, owner-stated). */
async function writeStatedFacts(profileId: string, a: IdeaAnswers, now: Date): Promise<void> {
  const at = isoDateTime(now.toISOString());
  const stated = <T>(key: string, value: T, note: string) =>
    writeField(
      profileId,
      createField<T>({
        id: fieldId(key),
        value,
        status: "answered",
        confidence: confidence(0.75),
        source: { kind: "owner_input" },
        observed_at: at,
        recorded_at: at,
        note,
      }),
    );
  const from = "Stated in the idea check.";
  // The bank's own stage (question 1.5): its idea questions and skips read it.
  await stated("identity.stage", { code: "idea" }, from);
  await stated("identity.business_type", { code: a.sector }, from);
  await stated("legal.country", a.country, from);
  if (a.team !== null) await stated("identity.team_size", a.team, from);
  if (a.capital !== null) {
    await stated(
      "costs.cash_available",
      { amount_minor: toMinor(a.capital, a.currency), currency: a.currency },
      from,
    );
  }
  const planned = plannedRevenue(a);
  if (planned) {
    await stated(
      "revenue.monthly_revenue",
      planned,
      "Planned, not earned: the idea check's price × customers a month at full plan. Measured sales supersede it after launch.",
    );
  }
}

/**
 * I-10: keep a shared check as an idea business for the signed-in person,
 * and switch this browser into it. A check is kept once.
 */
export async function keepIdea(args: {
  session: AuthedSession;
  currentToken: string | undefined;
  token: string;
  language: AppLocale;
  now?: Date;
}): Promise<Omit<RedeemedSession, "choose">> {
  const now = args.now ?? new Date();
  const [check] = await db
    .select()
    .from(ideaChecks)
    .where(eq(ideaChecks.token, args.token))
    .limit(1);
  if (!check) throw new IdeaError("that idea check isn't here", 404);
  if (check.profile_id) throw new IdeaError("this idea is already kept", 409);
  const answers = check.answers as IdeaAnswers;

  const next = await addBusiness({
    session: args.session,
    currentToken: args.currentToken,
    idea: { currency: answers.currency, language: args.language },
  });
  if (!next.profile_id) throw new IdeaError("the new business has no profile", 500);
  const profileId = next.profile_id;

  const [linked] = await db
    .update(ideaChecks)
    .set({ profile_id: profileId, label: await ideaLabel(answers, args.language) })
    .where(and(eq(ideaChecks.id, check.id), isNull(ideaChecks.profile_id)))
    .returning({ id: ideaChecks.id });
  if (!linked) throw new IdeaError("this idea is already kept", 409);

  await writeStatedFacts(profileId, answers, now);
  await db.insert(decisionLog).values({
    profile_id: profileId,
    actor: "owner",
    kind: "idea_saved",
    ref_id: check.id,
    payload_hash: hash({ check: check.id, token_sha: hash(args.token) }),
    user_id: next.user_id,
  });
  console.log(
    JSON.stringify({ event: "idea_kept", account_id: next.account_id, profile_id: profileId }),
  );
  return next;
}

export interface KeptIdea {
  check_id: string;
  token: string;
  answers: IdeaAnswers;
  result: IdeaResult;
  kind: "idea" | "operating";
  launched_at: string | null;
  results: { observed: number; reading: TestReading; recorded_at: string }[];
}

/** The idea kept as this profile, or null when the profile was never an idea. */
export async function keptIdea(profileId: string): Promise<KeptIdea | null> {
  const [row] = await db
    .select({
      check: ideaChecks,
      kind: businessProfiles.kind,
      launched_at: businessProfiles.launched_at,
    })
    .from(ideaChecks)
    .innerJoin(businessProfiles, eq(businessProfiles.id, ideaChecks.profile_id))
    .where(eq(ideaChecks.profile_id, profileId))
    .limit(1);
  if (!row) return null;
  const results = await db
    .select({
      observed: ideaTestResults.observed,
      reading: ideaTestResults.reading,
      recorded_at: ideaTestResults.recorded_at,
    })
    .from(ideaTestResults)
    .where(eq(ideaTestResults.profile_id, profileId))
    .orderBy(asc(ideaTestResults.recorded_at));
  return {
    check_id: row.check.id,
    token: row.check.token,
    answers: row.check.answers as IdeaAnswers,
    result: row.check.result as IdeaResult,
    kind: row.kind === "idea" ? "idea" : "operating",
    launched_at: row.launched_at,
    results: results.map((r) => ({ ...r, reading: r.reading as TestReading })),
  };
}

/** I-32: what the test showed, read against the lines kept with it (rule 41). */
export async function recordTestResult(args: {
  profileId: string;
  userId: string | null;
  observed: number;
}): Promise<TestReading> {
  const idea = await keptIdea(args.profileId);
  if (!idea) throw new IdeaError("this business isn't an idea", 404);
  if (idea.result.status !== "worked" || !idea.result.test) {
    throw new IdeaError("there is no test to record a result for", 409);
  }
  if (!Number.isSafeInteger(args.observed) || args.observed < 0) {
    throw new IdeaError("a result is a whole number from zero");
  }
  const reading = scoreTest(idea.result.test, args.observed);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(ideaTestResults)
      .values({
        profile_id: args.profileId,
        idea_check_id: idea.check_id,
        observed: args.observed,
        reading,
        user_id: args.userId,
      })
      .returning({ id: ideaTestResults.id });
    await tx.insert(decisionLog).values({
      profile_id: args.profileId,
      actor: "owner",
      kind: "idea_test_result",
      ref_id: row!.id,
      payload_hash: hash({
        test: idea.result.status === "worked" ? idea.result.test : null,
        observed: args.observed,
        reading,
      }),
      user_id: args.userId,
    });
  });
  return reading;
}

/** I-50: the idea is trading. One way; returns the first connector to suggest (I-52). */
export async function launchIdea(args: {
  profileId: string;
  userId: string | null;
  now?: Date;
}): Promise<{ connector: string | null }> {
  const now = args.now ?? new Date();
  const idea = await keptIdea(args.profileId);
  if (!idea) throw new IdeaError("this business isn't an idea", 404);
  if (idea.kind !== "idea") throw new IdeaError("this idea is already launched", 409);
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(businessProfiles)
      .set({ kind: "operating", launched_at: now.toISOString() })
      .where(and(eq(businessProfiles.id, args.profileId), eq(businessProfiles.kind, "idea")))
      .returning({ id: businessProfiles.id });
    if (!row) throw new IdeaError("this idea is already launched", 409);
    await tx.insert(decisionLog).values({
      profile_id: args.profileId,
      actor: "owner",
      kind: "idea_launch",
      ref_id: args.profileId,
      payload_hash: hash({ profile: args.profileId, launched_at: now.toISOString() }),
      user_id: args.userId,
    });
  });
  const at = isoDateTime(now.toISOString());
  await writeField(
    args.profileId,
    createField({
      id: fieldId("identity.stage"),
      value: { code: "recently_launched" },
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: "Launched from the idea check.",
    }),
  );
  const a = idea.answers;
  return {
    connector: a.revenue_model === "recruitment" ? null : firstConnector(a.revenue_model, a.sector),
  };
}

/** I-51: the plan against the measured days since launch (the last 60 at most), whole and per assumption. */
export async function ideaPlanVsActual(
  profileId: string,
  idea: KeptIdea,
  now = new Date(),
): Promise<{ revenue: PlanVsActual; assumptions: AssumptionLine[] } | null> {
  if (idea.kind !== "operating" || !idea.launched_at) return null;
  const today = now.toISOString().slice(0, 10);
  const launched = idea.launched_at.slice(0, 10);
  const from = [launched, shiftDay(today, -60)].sort().at(-1)!;
  const to = shiftDay(today, -1);
  const [revenue, orders] = await Promise.all([
    dailySeries(profileId, "revenue.daily", from, to),
    dailySeries(profileId, "orders.daily", from, to),
  ]);
  const currency = revenue && revenue.currencies.size === 1 ? revenue.currency : null;
  let sum = 0;
  for (const v of revenue?.values.values() ?? []) sum += v;
  // The average sale uses only days on which both were measured.
  let ordersSum = 0;
  let revenueOnOrderDays = 0;
  for (const [day, n] of orders?.values ?? []) {
    const r = revenue?.values.get(day);
    if (r === undefined) continue;
    ordersSum += n;
    revenueOnOrderDays += r;
  }
  const bothDays = [...(orders?.values.keys() ?? [])].filter((d) => revenue?.values.has(d)).length;
  const a = idea.answers;
  return {
    revenue: planVsActual({
      planned: plannedRevenue(a),
      measured: { sum_minor: sum, days: revenue?.values.size ?? 0, currency },
    }),
    assumptions:
      a.revenue_model === "recruitment" || a.price === null
        ? []
        : assumptionsVsActual({
            model: a.revenue_model,
            planned: {
              customers: a.customers_month,
              price_minor: toMinor(a.price, a.currency),
              currency: a.currency,
            },
            revenue: { sum_minor: revenueOnOrderDays, days: bothDays, currency },
            orders: { sum: Math.round(ordersSum), days: bothDays },
          }),
  };
}

/** I-10: what this business is — an idea, or one that trades. */
export async function profileKind(profileId: string): Promise<"idea" | "operating" | null> {
  const [row] = await db
    .select({ kind: businessProfiles.kind })
    .from(businessProfiles)
    .where(eq(businessProfiles.id, profileId));
  if (!row) return null;
  return row.kind === "idea" ? "idea" : "operating";
}

export { MIN_MEASURED_DAYS };

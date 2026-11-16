// TASKS-IDEAS part 2 against the database: keeping a check as an idea
// business, the triggers that keep an idea from operating (rule 40),
// recording a result (append-only, rule 41) and launching (one way).

import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  businessProfiles,
  connections,
  decisionLog,
  fieldRecords,
  ideaTestResults,
} from "../../db/schema";
import { createOwner, currentSession, openSession } from "../auth/service";
import { bootstrapIntake } from "../intake/service";
import type { IdeaAnswers } from "./check";
import { runIdea } from "./check";
import { ideaPlanVsActual, keepIdea, keptIdea, launchIdea, recordTestResult } from "./keep";

/** The database's own reason for refusing (drizzle wraps it as the cause). */
async function refusal(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  }
  return "not refused";
}

const ANSWERS: IdeaAnswers = {
  sector: "cafe",
  country: "HU",
  customer: "consumer",
  revenue_model: "one_off",
  currency: "HUF",
  price: 1_500,
  variable_cost: 500,
  customers_month: 1_500,
  fixed_month: 1_100_000,
  startup: 4_000_000,
  capital: 5_000_000,
  team: 2,
  ramp_months: 6,
};

/** A signed-in person with one ordinary business, and a fresh idea check. */
async function signedIn() {
  const email = `idea-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const boot = await bootstrapIntake();
  const owner = await createOwner(boot.account_id, email);
  const here = await openSession(owner);
  const session = await currentSession(here.session_token);
  if (!session) throw new Error("fixture session");
  const check = await runIdea({ answers: ANSWERS, locale: "en" });
  return { session, token: here.session_token, check };
}

async function kept() {
  const s = await signedIn();
  const next = await keepIdea({
    session: s.session,
    currentToken: s.token,
    token: s.check.token,
    language: "en",
  });
  return { ...s, next, profileId: next.profile_id! };
}

describe("I-10 — a check kept as an idea business", () => {
  it("is a new business of its own, made an idea, with what was stated as owner facts", async () => {
    const { session, next, profileId } = await kept();
    expect(next.account_id).not.toBe(session.account_id);
    const [p] = await db.select().from(businessProfiles).where(eq(businessProfiles.id, profileId));
    expect(p?.kind).toBe("idea");
    const facts = await db
      .select({
        key: fieldRecords.field_key,
        value: fieldRecords.value,
        source: fieldRecords.source,
      })
      .from(fieldRecords)
      .where(eq(fieldRecords.profile_id, profileId));
    const byKey = Object.fromEntries(facts.map((f) => [f.key, f]));
    expect(byKey["identity.business_type"]?.value).toEqual({ code: "cafe" });
    expect(byKey["legal.country"]?.value).toBe("HU");
    expect(byKey["identity.team_size"]?.value).toBe(2);
    // Planned, said so: 1 500 customers × 1 500 Ft.
    expect(byKey["revenue.monthly_revenue"]?.value).toEqual({
      amount_minor: 1_500 * 1_500 * 100,
      currency: "HUF",
    });
    expect(byKey["revenue.monthly_revenue"]?.source).toMatchObject({ kind: "owner_input" });
    const log = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, profileId), eq(decisionLog.kind, "idea_saved")));
    expect(log).toHaveLength(1);
  });

  it("can't be kept twice", async () => {
    const s = await kept();
    const again = await currentSession(s.next.session_token);
    await expect(
      keepIdea({
        session: again!,
        currentToken: s.next.session_token,
        token: s.check.token,
        language: "en",
      }),
    ).rejects.toThrow(/already kept/);
  });
});

describe("rule 40 — an idea has no connection, proposal or execution (the database holds it)", () => {
  it("refuses a connection for an idea, and allows it once launched", async () => {
    const { next, profileId } = await kept();
    expect(
      await refusal(
        db.insert(connections).values({ account_id: next.account_id, provider: "stripe" }),
      ),
    ).toMatch(/an idea has no connections yet/);
    await launchIdea({ profileId, userId: next.user_id });
    expect(
      await refusal(
        db.insert(connections).values({ account_id: next.account_id, provider: "stripe" }),
      ),
    ).toBe("not refused");
  });

  it("refuses a proposal for an idea", async () => {
    const { profileId } = await kept();
    // The trigger runs before the row's own checks, so it refuses first.
    expect(
      await refusal(db.execute(sql`insert into proposals (profile_id) values (${profileId})`)),
    ).toMatch(/an idea has no proposals yet/);
  });
});

describe("I-32 — a result read against the lines kept with the test", () => {
  it("records each result, reads it, and never edits one", async () => {
    const { profileId, next } = await kept();
    // Break-even 1 100 → pass at 275 deposits, fail below 110.
    expect(await recordTestResult({ profileId, userId: next.user_id, observed: 300 })).toBe("pass");
    expect(await recordTestResult({ profileId, userId: next.user_id, observed: 50 })).toBe("fail");
    const idea = await keptIdea(profileId);
    expect(idea?.results.map((r) => r.reading)).toEqual(["pass", "fail"]);
    expect(
      await refusal(
        db
          .update(ideaTestResults)
          .set({ observed: 999 })
          .where(eq(ideaTestResults.profile_id, profileId)),
      ),
    ).toMatch(/append-only/);
    expect(
      await refusal(db.delete(ideaTestResults).where(eq(ideaTestResults.profile_id, profileId))),
    ).toMatch(/append-only/);
  });
});

describe("I-50 — launching is one way, and the plan is kept", () => {
  it("makes it operating, suggests the first connector, and can't go back", async () => {
    const { profileId, next } = await kept();
    const out = await launchIdea({ profileId, userId: next.user_id });
    expect(out.connector).toBe("square"); // a café takes payments in person
    const idea = await keptIdea(profileId);
    expect(idea?.kind).toBe("operating");
    expect(idea?.launched_at).not.toBeNull();
    await expect(launchIdea({ profileId, userId: next.user_id })).rejects.toThrow(
      /already launched/,
    );
    expect(
      await refusal(
        db.update(businessProfiles).set({ kind: "idea" }).where(eq(businessProfiles.id, profileId)),
      ),
    ).toMatch(/can't become an idea/);
    // I-51: nothing measured yet, so the comparison waits.
    expect(await ideaPlanVsActual(profileId, idea!)).toMatchObject({ status: "too_early" });
  });

  it("an ordinary business was never an idea", async () => {
    const { session } = await signedIn();
    expect(await keptIdea(session.profile_id!)).toBeNull();
  });
});

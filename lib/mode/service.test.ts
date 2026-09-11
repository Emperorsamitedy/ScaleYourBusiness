// Session H — P1-42/44/45 against the real database. The rule logic
// has its own 19 unit tests; these cover what surrounds it: an empty
// profile defers, the field mapping is faithful (team_size includes the
// owner, employee_count must not), and the override asymmetry holds —
// extending is free, shortening demands an acknowledged signature.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  modeDecisions,
  watchActivity,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { loadBank } from "../bank/loader";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import { assembleInputs } from "./inputs";
import { decideForProfile, latestDecision, overrideWatch } from "./service";

const created: { account_id: string; profile_id: string }[] = [];

async function fresh() {
  const s = await bootstrapIntake();
  created.push(s);
  return s;
}

async function put(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: null,
    }),
  );
}

afterAll(async () => {
  for (const s of created) {
    await db.delete(watchActivity).where(eq(watchActivity.profile_id, s.profile_id));
    await db.delete(modeDecisions).where(eq(modeDecisions.profile_id, s.profile_id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P1-45 — an empty profile defers", () => {
  it("decideForProfile on a fresh profile is deferred, and no row is written", async () => {
    await loadBank("specs/question-bank-v1.json");
    const s = await fresh();
    const outcome = await decideForProfile(s.profile_id);
    expect(outcome.kind).toBe("deferred");
    expect(await latestDecision(s.profile_id)).toBeNull();
  });
});

describe("P1-42 — the field mapping is faithful", () => {
  it("maps stage codes, subtracts the owner from team_size, and carries ad spend minor units", async () => {
    const s = await fresh();
    await put(s.profile_id, "identity.stage", { code: "operating", label_raw: null });
    await put(s.profile_id, "revenue.generates_revenue", { code: "yes", label_raw: null });
    await put(s.profile_id, "revenue.order_count_monthly", 42);
    await put(s.profile_id, "identity.founded", "2023-01-15");
    await put(s.profile_id, "identity.team_size", 3);
    await put(s.profile_id, "marketing.advertising_status", { code: "yes", label_raw: null });
    await put(s.profile_id, "marketing.monthly_ad_spend", {
      amount_minor: 75_000,
      currency: "USD",
    });
    await put(s.profile_id, "operations.has_support_process", true);
    await put(s.profile_id, "tooling.has_automations", false);

    const { inputs, ad_spend_minor } = await assembleInputs(s.profile_id);
    expect(inputs.stage).toBe("operating");
    expect(inputs.has_revenue).toBe(true);
    expect(inputs.monthly_order_count).toBe(42);
    expect(inputs.months_operating).toBeGreaterThan(24);
    expect(inputs.employee_count).toBe(2); // 3 including the owner
    expect(inputs.has_active_ad_spend).toBe(true);
    expect(inputs.has_customer_support_process).toBe(true);
    expect(inputs.has_existing_automations).toBe(false);
    expect(ad_spend_minor).toBe(75_000);
  });
});

describe("P1-44 — the override asymmetry", () => {
  async function watchingDecision() {
    const s = await fresh();
    await db.insert(modeDecisions).values({
      profile_id: s.profile_id,
      mode: "watching",
      watch_weeks: 6,
      inputs: { reasons: ["test"] },
      reasoning: "test decision",
      confidence: "0.750",
      review_at: new Date(Date.now() + 42 * 86_400_000).toISOString(),
    });
    return s;
  }

  it("extending is one click — no acknowledgement, no sign-in", async () => {
    const s = await watchingDecision();
    const row = await overrideWatch({ profileId: s.profile_id, toWeeks: 8, userId: null });
    expect(row.watch_weeks).toBe(8);
    expect(row.owner_override?.kind).toBe("extend");
    expect(row.owner_override?.acknowledgement).toBeNull();
  });

  it("shortening without an acknowledgement is refused", async () => {
    const s = await watchingDecision();
    await expect(
      overrideWatch({ profileId: s.profile_id, toWeeks: 4, userId: "some-user" }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("shortening without being signed in is refused even with the text", async () => {
    const s = await watchingDecision();
    await expect(
      overrideWatch({
        profileId: s.profile_id,
        toWeeks: 4,
        userId: null,
        acknowledgementText: "I understand the risk",
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("shortening with both stores who acknowledged, and what they said", async () => {
    const s = await watchingDecision();
    const row = await overrideWatch({
      profileId: s.profile_id,
      toWeeks: 4,
      userId: "11111111-1111-1111-1111-111111111111",
      acknowledgementText: "I understand this reduces how much you learn first",
    });
    expect(row.watch_weeks).toBe(4);
    expect(row.owner_override?.kind).toBe("shorten");
    expect(row.owner_override?.acknowledgement?.user_id).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
    // The activity log records it as real work, honestly labelled.
    const activity = await db
      .select()
      .from(watchActivity)
      .where(eq(watchActivity.profile_id, s.profile_id));
    expect(activity.some((a) => a.kind === "watch_shortened")).toBe(true);
  });
});

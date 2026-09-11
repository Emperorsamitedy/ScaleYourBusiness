// Session H — P1-46. The honest-log guarantees: a first run records a
// baseline, an unchanged week says "held steady" rather than inventing
// motion, a changed week counts the real movement, and a finished
// watch announces completion exactly once no matter how often the cron
// fires.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  modeDecisions,
  profileSnapshots,
  watchActivity,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import { runWeeklyWatch } from "./job";

const created: { account_id: string; profile_id: string }[] = [];

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

async function watchedProfile(reviewInDays: number) {
  const s = await bootstrapIntake();
  created.push(s);
  await put(s.profile_id, "identity.legal_name", "Watch Job Co");
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: "watching",
    watch_weeks: 6,
    inputs: { reasons: [] },
    reasoning: "test",
    confidence: "0.750",
    review_at: new Date(Date.now() + reviewInDays * 86_400_000).toISOString(),
  });
  return s;
}

const activityOf = async (profileId: string) =>
  db.select().from(watchActivity).where(eq(watchActivity.profile_id, profileId));

afterAll(async () => {
  for (const s of created) {
    await db.delete(watchActivity).where(eq(watchActivity.profile_id, s.profile_id));
    await db.delete(modeDecisions).where(eq(modeDecisions.profile_id, s.profile_id));
    await db.delete(profileSnapshots).where(eq(profileSnapshots.profile_id, s.profile_id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

describe("P1-46 — the weekly watch job", () => {
  it("baseline, then held-steady, then a real diff — each said honestly", async () => {
    const s = await watchedProfile(30);

    await runWeeklyWatch();
    let log = await activityOf(s.profile_id);
    expect(log.some((a) => a.detail.includes("Baseline snapshot"))).toBe(true);

    // Nothing changed: the log must say so, not invent motion.
    await runWeeklyWatch();
    log = await activityOf(s.profile_id);
    expect(log.some((a) => a.detail.includes("held steady"))).toBe(true);

    // One real change: the diff names the movement.
    await put(s.profile_id, "identity.team_size", 4);
    await runWeeklyWatch();
    log = await activityOf(s.profile_id);
    const diff = log.find((a) => a.kind === "diff_computed");
    expect(diff).toBeDefined();
    expect(diff?.detail).toMatch(/1 new|1 changed/);
  });

  it("a finished watch announces completion exactly once", async () => {
    const s = await watchedProfile(-1); // review date already passed
    await runWeeklyWatch();
    await runWeeklyWatch();
    await runWeeklyWatch();
    const log = await activityOf(s.profile_id);
    expect(log.filter((a) => a.kind === "watch_complete")).toHaveLength(1);
    // And no snapshots were taken for an expired watch.
    expect(log.filter((a) => a.kind === "snapshot_taken")).toHaveLength(0);
  });
});

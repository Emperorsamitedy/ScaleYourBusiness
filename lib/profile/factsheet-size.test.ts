// The size band on the fact sheet and in the intake: an inferred band
// shows as DERIVED with its formula until the owner answers 1.6a, the
// owner's answer then replaces it, and both read in the bank's own words.

import "dotenv/config";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  profileSnapshots,
  snapshotRecords,
} from "../../db/schema";
import { loadBank } from "../bank/loader";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { getIntakeState } from "../intake/service";
import { buildFactSheet, labelledValue, optionLabelsOf } from "./factsheet";
import { writeField } from "./field-store";
import { SIZE_BAND_KEY, SIZE_BAND_METHOD } from "./size-band";

let accountId: string;
let profileId: string;

async function ownerSays(key: string, value: unknown): Promise<void> {
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
    }),
  );
}

const bandRow = (sheet: Awaited<ReturnType<typeof buildFactSheet>>) =>
  sheet.sections.find((s) => s.section === "identity")?.facts.find((f) => f.key === SIZE_BAND_KEY);

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
  await ownerSays("identity.legal_name", "Small Batch Ltd");
  await ownerSays("identity.team_size", 4);
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

describe("question 1.6a in the intake", () => {
  it("offers the four bands in the owner's words", async () => {
    const state = await getIntakeState(accountId, profileId, "1.6a");
    expect(state.question?.id).toBe("1.6a");
    expect(state.question?.options).toEqual([
      { code: "solo", label: "Just me" },
      { code: "small", label: "A small team" },
      { code: "medium", label: "A medium-sized business" },
      { code: "large", label: "A larger business" },
    ]);
  });
});

describe("the size band on the fact sheet", () => {
  it("shows the band inferred from team size as DERIVED, with its formula, without storing it", async () => {
    const sheet = await buildFactSheet(profileId);
    const row = bandRow(sheet);
    expect(row).toMatchObject({
      value: "A small team",
      status: "inferred",
      source_kind: "inferred",
      source_detail: SIZE_BAND_METHOD,
    });
    // The owner's own words are still asked for.
    expect(sheet.gaps.map((g) => g.question_id)).toContain("1.6a");
    // Nothing was written: the inference never takes the owner's place.
    const stored = await db
      .select()
      .from(fieldRecords)
      .where(
        and(eq(fieldRecords.profile_id, profileId), eq(fieldRecords.field_key, SIZE_BAND_KEY)),
      );
    expect(stored).toHaveLength(0);
  });

  it("shows the owner's own answer once given, over what the headcount says", async () => {
    await ownerSays(SIZE_BAND_KEY, { code: "solo" });
    const sheet = await buildFactSheet(profileId);
    expect(bandRow(sheet)).toMatchObject({
      value: "Just me",
      status: "answered",
      source_kind: "owner_input",
    });
    expect(sheet.gaps.map((g) => g.question_id)).not.toContain("1.6a");
  });

  it("keeps the earlier answer in history, in the bank's words (rule 3)", async () => {
    await ownerSays(SIZE_BAND_KEY, { code: "small" });
    const sheet = await buildFactSheet(profileId);
    expect(bandRow(sheet)?.value).toBe("A small team");
    expect(sheet.history[SIZE_BAND_KEY]?.map((h) => h.value)).toEqual(["Just me"]);
  });
});

describe("option labels — display only", () => {
  const labels = optionLabelsOf([
    {
      writes_to: "identity.size_band",
      input: { option_labels: { solo: { en: "Just me" }, small: { en: " " } } },
    },
    { writes_to: "identity.stage", input: { type: "single_select" } },
  ]);

  it("reads a labelled code in the bank's words, and anything else as before", () => {
    expect(labelledValue("identity.size_band", { code: "solo" }, labels)).toBe("Just me");
    // A blank label is no label.
    expect(labelledValue("identity.size_band", { code: "small" }, labels)).toBe("small");
    expect(labelledValue("identity.stage", { code: "preparing_to_launch" }, labels)).toBe(
      "preparing to launch",
    );
    expect(labelledValue("identity.size_band", null, labels)).toBeNull();
  });
});

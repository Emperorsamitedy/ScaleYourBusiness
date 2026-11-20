// P3-23c — shot lists and calendar proposals cite measured per-post
// outcomes ("your three Reels out-performed your four photo posts 4:1"),
// only from real measured rows, with the counts and the ratio computed
// here — and no evidence line at all when there is too little data.

import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { channels, offers } from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import { shiftDay } from "../trust/series";
import { EVIDENCE, compareFormats, formatOf, performanceEvidence, ratioWord } from "./performance";
import type { PostFormat } from "./performance";
import { proposeContentPlan } from "./plan";
import {
  fxBusiness,
  fxCleanup,
  fxExecuteConnection,
  fxPublishedItem,
  fxSnapshots,
} from "./readback-fixture";
import type { FxBusiness, FxOp } from "./readback-fixture";
import { proposeShotList } from "./shotlist";

afterAll(async () => {
  await fxCleanup();
});

const noLimits: LimitLlm = async () => ({ text: '{"limits": []}', calls: [] });

async function owner(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

/** A business with an Instagram channel and an offer, so both proposals can be made. */
async function business(): Promise<FxBusiness> {
  const b = await fxBusiness();
  const [ch] = await db
    .insert(channels)
    .values({ profile_id: b.profile_id })
    .returning({ id: channels.id });
  await owner(b.profile_id, `channels.${ch!.id}.type`, "social_organic");
  await owner(b.profile_id, `channels.${ch!.id}.platform`, "instagram");
  const [offer] = await db
    .insert(offers)
    .values({ profile_id: b.profile_id, kind: "physical" })
    .returning({ id: offers.id });
  await owner(b.profile_id, `offers.${offer!.id}.name`, "Ember Candle");
  return b;
}

let seq = 0;
/** Published posts with their day-7 interactions measured. */
async function posts(
  b: FxBusiness,
  connId: string,
  platform: "facebook" | "instagram",
  kind: "post" | "video",
  interactionsOnDay7: readonly number[],
  op?: FxOp,
) {
  for (const n of interactionsOnDay7) {
    seq += 1;
    const day = shiftDay("2026-08-01", seq);
    const id =
      platform === "instagram" ? `1795${String(seq).padStart(13, "0")}` : `1000000001_${seq}`;
    await fxPublishedItem(b, {
      platform,
      post_id: id,
      published_at: `${day}T10:00:00Z`,
      kind,
      ...(op ? { op } : {}),
    });
    await fxSnapshots(connId, platform, id, day, [
      { age: 3, interactions: Math.round(n / 2) },
      { age: EVIDENCE.age_days, interactions: n },
    ]);
  }
}

const values = (entries: [PostFormat, number[]][]) => new Map(entries);

describe("P3-23c — the arithmetic, pure", () => {
  it("names the counts and the ratio: three Reels against four photo posts, 4:1", () => {
    const e = compareFormats(
      "instagram",
      values([
        ["reel", [40, 48, 60]],
        ["photo", [10, 12, 12, 14]],
      ]),
    );
    expect(e?.line).toBe(
      "Your three Reels out-performed your four photo posts 4:1 on Instagram: a median of 48 interactions in their first 7 days, against 12.",
    );
    expect(e?.ratio).toBe(4);
    expect(e?.arithmetic).toContain("48 ÷ 12 = 4.00");
  });

  it("too little data is no line: under three posts of a format, one format only, or a zero median", () => {
    expect(
      compareFormats(
        "instagram",
        values([
          ["reel", [40, 48, 60]],
          ["photo", [10, 12]],
        ]),
      ),
    ).toBeNull();
    expect(compareFormats("instagram", values([["reel", [40, 48, 60]]]))).toBeNull();
    expect(
      compareFormats(
        "instagram",
        values([
          ["reel", [4, 5, 6]],
          ["photo", [0, 0, 0]],
        ]),
      ),
    ).toBeNull();
  });

  it("close medians read as about the same; small ratios keep one decimal", () => {
    const same = compareFormats(
      "facebook",
      values([
        ["photo", [10, 10, 11]],
        ["text", [10, 10, 10]],
      ]),
    );
    expect(same?.line).toContain("did about the same on Facebook");
    expect(same?.ratio).toBeNull();
    expect(ratioWord(1.5)).toBe("1.5:1");
    expect(ratioWord(4.2)).toBe("4:1");
  });

  it("formatOf: the item kind and the op that published it, never a guess", () => {
    expect(formatOf("instagram", "video", "publish_ig_media")).toBe("reel");
    expect(formatOf("instagram", "post", "publish_ig_media")).toBe("photo");
    expect(formatOf("facebook", "post", "publish_page_photo")).toBe("photo");
    expect(formatOf("facebook", "post", "publish_page_post")).toBe("text");
    expect(formatOf("facebook", "post", null)).toBeNull();
  });
});

describe("P3-23c — shot lists and calendars cite what performed before", () => {
  it("DONE-WHEN: a shot-list proposal cites a measured per-post outcome; so does the calendar", async () => {
    const b = await business();
    const conn = await fxExecuteConnection(b.account_id);
    await posts(b, conn.id, "instagram", "video", [40, 48, 60]);
    await posts(b, conn.id, "instagram", "post", [10, 12, 12, 14]);
    const line =
      "Your three Reels out-performed your four photo posts 4:1 on Instagram: a median of 48 interactions in their first 7 days, against 12.";

    expect((await performanceEvidence(b.profile_id))?.line).toBe(line);

    const shot = await proposeShotList(b.profile_id, { limitLlm: noLimits });
    const shotScenario = shot.scenario as {
      assumptions: { statement: string; measured?: string }[];
    };
    expect(shotScenario.assumptions[0]?.statement).toBe(line);
    expect(shotScenario.assumptions[0]?.measured).toContain("content.interactions.daily");
    const detail = (shot.action as { detail: { performance?: { ratio: number } } }).detail;
    expect(detail.performance?.ratio).toBe(4);

    const plan = await proposeContentPlan(b.profile_id, { limitLlm: noLimits });
    const planScenario = plan.scenario as { assumptions: { statement: string }[] };
    expect(planScenario.assumptions.map((a) => a.statement)).toContain(line);
  });

  it("with too little measured data, the evidence line is simply absent", async () => {
    const b = await business();
    const conn = await fxExecuteConnection(b.account_id);
    await posts(b, conn.id, "instagram", "video", [40, 48]);
    await posts(b, conn.id, "instagram", "post", [10, 12, 12]);
    expect(await performanceEvidence(b.profile_id)).toBeNull();
    const shot = await proposeShotList(b.profile_id, { limitLlm: noLimits });
    const statements = (shot.scenario as { assumptions: { statement: string }[] }).assumptions.map(
      (a) => a.statement,
    );
    expect(
      statements.some((s) => s.includes("out-performed") || s.includes("about the same")),
    ).toBe(false);
    expect(
      (shot.action as { detail: { performance?: unknown } }).detail.performance,
    ).toBeUndefined();
  });

  it("a post measured only before day 7 is left out, not stretched", async () => {
    const b = await business();
    const conn = await fxExecuteConnection(b.account_id);
    await posts(b, conn.id, "instagram", "video", [40, 48, 60]);
    await posts(b, conn.id, "instagram", "post", [10, 12]);
    // A third photo post with only an early reading: it doesn't make three.
    await fxPublishedItem(b, {
      platform: "instagram",
      post_id: "17959999999999999",
      published_at: "2026-10-15T10:00:00Z",
    });
    await fxSnapshots(conn.id, "instagram", "17959999999999999", "2026-10-15", [
      { age: 2, interactions: 500 },
    ]);
    expect(await performanceEvidence(b.profile_id)).toBeNull();
  });
});

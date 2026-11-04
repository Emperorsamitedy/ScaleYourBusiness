// I-46a — a content push ahead of a busy stretch. What must hold: a busy
// stretch two to three weeks out raises ONE content-calendar proposal
// through the existing calendar path (kind content_publishing, drafting
// nothing); no stretch, or one too near or too far, raises nothing; a
// second run, a week later or racing, raises nothing more; and the care,
// watch and set-up gates hold it.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  channels,
  contentItems,
  fieldRecords,
  intakeEvents,
  modeDecisions,
  proposals,
} from "../../db/schema";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import type { LimitLlm } from "../proposals/hard-limits";
import type { SeriesInfo } from "../seasons/forecast";
import { addDays, seasonForecast } from "../seasons/forecast";
import type { SeasonsView } from "../seasons/load";
import { contentQueue } from "./produce";
import {
  SEASON_PUSH,
  proposeSeasonPush,
  sameStretch,
  seasonPushRef,
  stretchToPush,
} from "./season-push";

// Monday 2 Nov 2026. This Monday less 364 days is 3 Nov 2025.
const NOW = new Date("2026-11-02T06:00:00Z");
const TODAY = "2026-11-02";
const INFO: SeriesInfo = { noun: "revenue", source: "Shopify", currency: "EUR" };

/** A year and a month of days at 100, with `busyFrom` for three weeks at 250. */
function viewWith(today: string, busyFrom: string | null): SeasonsView {
  const values = new Map<string, number>();
  const busyTo = busyFrom ? addDays(busyFrom, 20) : null;
  for (let d = "2025-10-01"; d < today; d = addDays(d, 1)) {
    values.set(d, busyFrom && busyTo && d >= busyFrom && d <= busyTo ? 250 : 100);
  }
  return {
    result: seasonForecast(values, INFO, today),
    connect: "Connect Shopify",
    other_currencies: [],
  };
}

// Last year's stretch from Mon 24 Nov 2025: this year's from Mon 23 Nov 2026, three weeks out.
const THREE_OUT = viewWith(TODAY, "2025-11-24");

const noLimits: LimitLlm = async () => ({ text: JSON.stringify({ limits: [] }), calls: [] });

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
  await db.delete(proposals).where(inArray(proposals.profile_id, ids));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  await db.delete(channels).where(inArray(channels.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

async function answer(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(NOW.toISOString());
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

/** A shop with an Instagram channel, in care unless told otherwise. */
async function shop(opts: { mode?: "instant" | "watching" | null; channel?: boolean } = {}) {
  const s = await bootstrapIntake();
  created.push(s);
  if (opts.mode !== null) {
    await db.insert(modeDecisions).values({
      profile_id: s.profile_id,
      mode: opts.mode ?? "instant",
      watch_weeks: opts.mode === "watching" ? 6 : null,
      inputs: {},
      reasoning: "fixture",
      confidence: "0.800",
      decided_at: new Date(NOW.getTime() - 86_400_000).toISOString(),
      review_at: new Date(NOW.getTime() + 30 * 86_400_000).toISOString(),
    });
  }
  if (opts.channel !== false) {
    const [ch] = await db
      .insert(channels)
      .values({ profile_id: s.profile_id })
      .returning({ id: channels.id });
    await answer(s.profile_id, `channels.${ch!.id}.type`, { code: "social_organic" });
    await answer(s.profile_id, `channels.${ch!.id}.platform`, { code: "instagram" });
  }
  return s;
}

const pushesOf = async (profileId: string) =>
  (await db.select().from(proposals).where(eq(proposals.profile_id, profileId))).filter((p) =>
    (p.originating_finding ?? "").startsWith("season:content:"),
  );

describe("I-46a — which stretch, and when (pure)", () => {
  it("picks a busy stretch starting two to three weeks out, and nothing nearer or further", () => {
    const u = stretchToPush(THREE_OUT.result);
    expect(u).not.toBeNull();
    expect(u!.starts_in_weeks).toBe(3);
    expect(u!.starts_on).toBe("2026-11-23");
    expect(seasonPushRef(u!)).toBe("season:content:2026-11-23");
    // Two weeks out still counts…
    expect(stretchToPush(viewWith(TODAY, "2025-11-17").result)?.starts_in_weeks).toBe(2);
    // …one week out is too late, five too early.
    expect(stretchToPush(viewWith(TODAY, "2025-11-10").result)).toBeNull();
    expect(stretchToPush(viewWith(TODAY, "2025-12-08").result)).toBeNull();
    // A steady year has no stretch at all.
    expect(stretchToPush(viewWith(TODAY, null).result)).toBeNull();
    expect(SEASON_PUSH.lead_min_weeks).toBe(2);
    expect(SEASON_PUSH.lead_max_weeks).toBe(3);
  });

  it("a stretch re-read a week later with its start moved by a week is the same stretch", () => {
    expect(sameStretch("season:content:2026-11-23", "2026-11-30")).toBe(true);
    expect(sameStretch("season:content:2026-11-23", "2027-02-01")).toBe(false);
    expect(sameStretch("stock:reorder:x", "2026-11-23")).toBe(false);
  });
});

describe("I-46a — the proposal", () => {
  it("raises once: a content calendar through the existing path, drafting nothing", async () => {
    const s = await shop();
    const out = await proposeSeasonPush(s.profile_id, {
      now: NOW,
      view: THREE_OUT,
      limitLlm: noLimits,
    });
    expect(out.status).toBe("created");
    if (out.status !== "created") return;
    const p = out.proposal;
    expect(p.module).toBe("content");
    expect(p.status).toBe("pending");
    expect(p.originating_finding).toBe("season:content:2026-11-23");
    const action = p.action as {
      kind: string;
      summary: string;
      detail: { items: { date: string }[]; season: { starts_on: string; index: number } };
    };
    expect(action.kind).toBe("content_publishing");
    expect(action.summary).toBe(
      "Ahead of your busy weeks from 23 Nov: a 3-week content calendar: 9 pieces across 1 channel",
    );
    // From next Monday, through the stretch's first week.
    expect(action.detail.items[0]?.date).toBe("2026-11-09");
    expect(action.detail.items.at(-1)!.date < "2026-11-30").toBe(true);
    expect(action.detail.season.starts_on).toBe("2026-11-23");
    expect(action.detail.season.index).toBeGreaterThanOrEqual(1.25);
    const scenario = p.scenario as { assumptions: { statement: string; measured?: string }[] };
    expect(scenario.assumptions[0]?.statement).toMatch(/^Last year the same 3 weeks ran 2\.\d×/);
    expect(scenario.assumptions[0]?.measured).toBe("your own revenue, measured from Shopify");
    expect(await contentQueue(s.profile_id)).toHaveLength(0);
  });

  it("not twice: the same stretch a week later, two weeks out, raises nothing more", async () => {
    const s = await shop();
    const first = await proposeSeasonPush(s.profile_id, {
      now: NOW,
      view: THREE_OUT,
      limitLlm: noLimits,
    });
    expect(first.status).toBe("created");
    const later = new Date(NOW.getTime() + 7 * 86_400_000);
    const view = viewWith(addDays(TODAY, 7), "2025-11-24");
    expect(stretchToPush(view.result)?.starts_in_weeks).toBe(2);
    const second = await proposeSeasonPush(s.profile_id, {
      now: later,
      view,
      limitLlm: noLimits,
    });
    expect(second).toMatchObject({ status: "already" });
    expect(await pushesOf(s.profile_id)).toHaveLength(1);
  });

  it("not twice when two runs race: one proposal, held by the unique index", async () => {
    const s = await shop();
    const runs = await Promise.all(
      [0, 1].map(() =>
        proposeSeasonPush(s.profile_id, { now: NOW, view: THREE_OUT, limitLlm: noLimits }),
      ),
    );
    expect(runs.filter((r) => r.status === "created")).toHaveLength(1);
    expect(await pushesOf(s.profile_id)).toHaveLength(1);
  });

  it("no stretch, no proposal", async () => {
    const s = await shop();
    const flat = await proposeSeasonPush(s.profile_id, {
      now: NOW,
      view: viewWith(TODAY, null),
      limitLlm: noLimits,
    });
    expect(flat.status).toBe("no_stretch");
    const tooFar = await proposeSeasonPush(s.profile_id, {
      now: NOW,
      view: viewWith(TODAY, "2025-12-08"),
      limitLlm: noLimits,
    });
    expect(tooFar.status).toBe("no_stretch");
    const thin: SeasonsView = { ...THREE_OUT, result: { status: "no_data" } };
    expect((await proposeSeasonPush(s.profile_id, { now: NOW, view: thin })).status).toBe(
      "no_stretch",
    );
    expect(await pushesOf(s.profile_id)).toHaveLength(0);
  });

  it("respects the gates: not in care, watching, or no channel to plan onto", async () => {
    const outside = await shop({ mode: null });
    expect(
      await proposeSeasonPush(outside.profile_id, { now: NOW, view: THREE_OUT }),
    ).toMatchObject({ status: "held" });
    const watched = await shop({ mode: "watching" });
    expect(
      await proposeSeasonPush(watched.profile_id, { now: NOW, view: THREE_OUT }),
    ).toMatchObject({ status: "held" });
    const bare = await shop({ channel: false });
    expect(
      await proposeSeasonPush(bare.profile_id, { now: NOW, view: THREE_OUT, limitLlm: noLimits }),
    ).toMatchObject({ status: "not_set_up" });
    for (const s of [outside, watched, bare]) {
      expect(await pushesOf(s.profile_id)).toHaveLength(0);
    }
  });

  it("waits behind a calendar the owner already has in the queue", async () => {
    const s = await shop();
    const { proposeContentPlan } = await import("./plan");
    await proposeContentPlan(s.profile_id, { now: NOW, limitLlm: noLimits });
    expect(
      await proposeSeasonPush(s.profile_id, { now: NOW, view: THREE_OUT, limitLlm: noLimits }),
    ).toMatchObject({ status: "waiting" });
    expect(await pushesOf(s.profile_id)).toHaveLength(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  type AdStateLike,
  type PerformanceLike,
  type QueueItem,
  adLine,
  aiMediaWord,
  calendarStrip,
  channelStrips,
  contentHeadline,
  formatMinor,
  mediaWord,
  performanceBars,
  performanceLine,
  publishLine,
  shortId,
  stateWord,
  tileMedia,
} from "./content-view";

const item = (over: Partial<QueueItem>): QueueItem => ({
  id: "64e2a1a7-b362-4bef-9f5f-318a2d4a0aaa",
  kind: "post",
  channel_label: "instagram",
  scheduled_for: "2026-10-22",
  status: "drafted",
  publish_proposal_id: null,
  published_at: null,
  ...over,
});

describe("channelStrips", () => {
  it("counts planned and posted per channel from the queue alone", () => {
    const strips = channelStrips(
      [
        item({ status: "published", scheduled_for: "2026-10-15" }),
        item({ scheduled_for: "2026-10-22" }),
        item({ channel_label: "facebook", scheduled_for: "2026-10-23" }),
        item({ channel_label: "facebook", status: "withdrawn" }),
      ],
      "2026-10-17",
    );
    expect(strips).toEqual([
      expect.objectContaining({ channel: "instagram", planned: 2, posted: 1, state: "on_pace" }),
      expect.objectContaining({ channel: "facebook", planned: 1, posted: 0, next: "2026-10-23" }),
    ]);
  });

  it("marks a channel behind when an unposted item is past its date, done when all posted", () => {
    const [behind] = channelStrips([item({ scheduled_for: "2026-10-10" })], "2026-10-17");
    expect(behind).toMatchObject({ state: "behind", overdue: 1 });
    const [done] = channelStrips([item({ status: "published" })], "2026-10-17");
    expect(done).toMatchObject({ state: "done", next: null });
  });
});

describe("contentHeadline", () => {
  it("states drafts and the ones waiting on the owner", () => {
    expect(
      contentHeadline({
        items: [item({ publish_proposal_id: "p" }), item({})],
        producible: 0,
        blocked: 0,
        nextDate: null,
      }),
    ).toBe("2 drafts. One needs your yes.");
  });

  it("says plainly when nothing can post, and when the queue is empty", () => {
    expect(
      contentHeadline({ items: [item({}), item({})], producible: 0, blocked: 2, nextDate: null }),
    ).toBe("2 drafts. None can post yet.");
    expect(contentHeadline({ items: [], producible: 0, blocked: 0, nextDate: null })).toBe(
      "Nothing drafted yet.",
    );
  });
});

describe("stateWord and shortId", () => {
  it("words each publish state", () => {
    const day = (iso: string) => iso.slice(8);
    expect(stateWord(item({ publish_proposal_id: "p" }), day)).toEqual({
      word: "in your queue",
      tone: "live",
    });
    expect(stateWord(item({ status: "queued" }), day).word).toBe("scheduled 22");
    expect(stateWord(item({ status: "failed" }), day).tone).toBe("alarm");
  });

  it("takes the first four hex digits of the real id", () => {
    expect(shortId("C", "64e2a1a7-b362")).toBe("C-64E2");
  });
});

describe("P3-21d/e — the publishing queue's words", () => {
  it("a publish Meta never confirmed reads 'unconfirmed', never plain 'publishing'", () => {
    const day = (iso: string) => iso.slice(8);
    expect(stateWord(item({ status: "publishing" }), day)).toEqual({
      word: "publishing",
      tone: "live",
    });
    expect(
      stateWord(
        item({ status: "publishing", last_error: "I may have posted this — check the Page." }),
        day,
      ),
    ).toEqual({ word: "unconfirmed", tone: "drift" });
  });

  it("an approved item says plainly when publishing is switched off, and what happens when it's on", () => {
    const queued = { ...item({ status: "queued" }), platform: null };
    expect(publishLine(queued, false)).toMatch(
      /^Approved, and waiting for publishing to be switched on\. Nothing is sent to Meta/,
    );
    expect(publishLine(queued, true)).toMatch(/goes out at its posting time, through the runner/);
    expect(publishLine({ ...queued, last_error: "Meta says this Page has used 80%" }, true)).toBe(
      "Meta says this Page has used 80%",
    );
  });

  it("published and withdrawn items name the platform; drafts need no line", () => {
    const at = (status: QueueItem["status"]) => ({ ...item({ status }), platform: "instagram" });
    expect(publishLine(at("published"), true)).toBe("Live on Instagram.");
    expect(publishLine(at("withdrawn"), true)).toBe(
      "Withdrawn: deleted from Instagram. Its record stays here.",
    );
    expect(publishLine(at("drafted"), false)).toBeNull();
  });
});

describe("performanceLine — P3-23b, a published item's measured line", () => {
  it("shows the figures on the day judged, the verdict word and its tone, and the arithmetic", () => {
    const line = performanceLine({
      verdict: "helped",
      audience_metric: "reach",
      age_days: 7,
      figures: { views: 2400, reach: 1240, interactions: 86 },
      arithmetic: "on day 7 after posting: reach 1240 against a median of 800 (+55%)",
    });
    expect(line).toEqual({
      figures: "day 7 · reach 1 240 · views 2 400 · interactions 86",
      word: "helped",
      tone: "ok",
      arithmetic: "on day 7 after posting: reach 1240 against a median of 800 (+55%)",
    });
  });

  it("a too-early item has no figures yet but still says why; nothing measured is no line", () => {
    const line = performanceLine({
      verdict: "too_early",
      audience_metric: "views",
      age_days: null,
      figures: null,
      arithmetic: "1 measured day(s) since 2026-10-18: the verdict needs 3",
    });
    expect(line).toMatchObject({ figures: null, word: "too early", tone: "low" });
    expect(performanceLine(undefined)).toBeNull();
    expect(
      performanceLine({
        verdict: "backfired",
        audience_metric: "views",
        age_days: 4,
        figures: { views: 10, reach: null, interactions: null },
        arithmetic: "x",
      }),
    ).toMatchObject({ figures: "day 4 · views 10", tone: "alarm" });
  });
});

describe("P3-54 — the ad line under an item", () => {
  const none: AdStateLike = { reason: null, proposal: null, build: null, go_live: null };
  it("a ready item offers one thing: make the proposal — with the paused note", () => {
    expect(adLine(none, false)).toMatchObject({
      action: "run_ad",
      text: expect.stringMatching(/Creates paused; going live is a separate approval/),
    });
    // An item that can't be an ad, with no ad history, shows nothing.
    expect(adLine({ ...none, reason: "it has no image or video yet" }, false)).toBeNull();
  });
  it("never offers it twice: proposed, approved, held back each say where it stands", () => {
    const p = (status: string) => adLine({ ...none, proposal: { id: "p", status } }, false);
    expect(p("pending")).toMatchObject({ word: "ad proposed", action: "queue" });
    expect(p("approved")).toMatchObject({ word: "ad approved", text: /switched on/, action: null });
    expect(p("blocked")).toMatchObject({ word: "ad held back", action: null });
    // A declined or lapsed one can be proposed again.
    expect(p("rejected")).toMatchObject({ action: "run_ad" });
  });
  it("a created ad is paused until its separate go-live runs; a lost confirmation is shown, never hidden", () => {
    const built = { id: "b", status: "built", last_error: null };
    expect(adLine({ ...none, build: built }, true)).toMatchObject({
      word: "ad paused",
      action: "go_live",
    });
    expect(
      adLine({ ...none, build: built, go_live: { id: "g", status: "pending" } }, true),
    ).toMatchObject({
      action: "queue",
    });
    expect(
      adLine({ ...none, build: built, go_live: { id: "g", status: "executed" } }, true),
    ).toMatchObject({
      word: "ad live",
    });
    expect(
      adLine(
        {
          ...none,
          build: { id: "b", status: "uncertain", last_error: "I may have created the ad set" },
        },
        true,
      ),
    ).toMatchObject({
      word: "ad unconfirmed",
      tone: "drift",
      text: "I may have created the ad set",
    });
  });
});

describe("P3-52/53 — what an item's media is, in the owner's words", () => {
  it("never shows a generated picture as filmed", () => {
    expect(mediaWord({ media: { origin: "footage" } })).toBe("your footage");
    expect(mediaWord({ media: { origin: "generated_image" } })).toBe("AI-generated image");
    expect(mediaWord({ media: { origin: "generated_video" } })).toBe("AI-generated video");
    expect(mediaWord(null)).toBe("your footage");
  });

  it("prices come as integer minor units and print as money", () => {
    expect(formatMinor({ amount_minor: 4, currency: "EUR" })).toBe("€0.04");
    expect(formatMinor({ amount_minor: 50, currency: "EUR" })).toBe("€0.50");
  });
});

describe("the small visuals — the calendar strip", () => {
  const flat = (items: QueueItem[], today: string) =>
    (calendarStrip(items, today)?.weeks ?? []).flat().filter((d) => d.entries.length > 0);

  it("puts each dated item on its day: posted, planned, or past its date", () => {
    const strip = calendarStrip(
      [
        item({ id: "a", status: "published", published_at: "2026-10-14T09:30:00Z" }),
        item({ id: "b", scheduled_for: "2026-10-15" }),
        item({ id: "c", status: "queued", scheduled_for: "2026-10-22" }),
        item({ id: "d", scheduled_for: "2026-10-22" }),
      ],
      "2026-10-17",
    );
    // Two whole weeks, Monday first: 12–25 October.
    expect(strip?.weeks.map((w) => w.length)).toEqual([7, 7]);
    expect(strip?.weeks[0]?.[0]?.date).toBe("2026-10-12");
    expect(strip?.weeks[1]?.[6]?.date).toBe("2026-10-25");
    expect(strip?.weeks.flat().filter((d) => d.today)).toEqual([
      { date: "2026-10-17", today: true, entries: [] },
    ]);
    expect(
      strip?.weeks
        .flat()
        .filter((d) => d.entries.length > 0)
        .map((d) => [d.date, d.entries]),
    ).toEqual([
      ["2026-10-14", [{ id: "a", mark: "posted" }]],
      ["2026-10-15", [{ id: "b", mark: "overdue" }]],
      [
        "2026-10-22",
        [
          { id: "c", mark: "planned" },
          { id: "d", mark: "planned" },
        ],
      ],
    ]);
    expect(strip?.outside).toBe(0);
  });

  it("is nothing for an empty queue or one with no dates", () => {
    expect(calendarStrip([], "2026-10-17")).toBeNull();
    expect(calendarStrip([item({ scheduled_for: null })], "2026-10-17")).toBeNull();
  });

  it("leaves out an item with no date, and a withdrawn one", () => {
    const days = flat(
      [
        item({ id: "dated" }),
        item({ id: "undated", scheduled_for: null }),
        item({ id: "gone", status: "withdrawn", published_at: "2026-10-20T08:00:00Z" }),
      ],
      "2026-10-17",
    );
    expect(days.flatMap((d) => d.entries.map((e) => e.id))).toEqual(["dated"]);
  });

  it("draws six weeks at most, around today, and counts what falls outside", () => {
    const strip = calendarStrip(
      [
        item({ id: "old", status: "published", published_at: "2026-08-03T08:00:00Z" }),
        item({ id: "soon", scheduled_for: "2026-10-22" }),
        item({ id: "far", scheduled_for: "2026-12-30" }),
      ],
      "2026-10-17",
    );
    expect(strip?.weeks).toHaveLength(6);
    // The week before today's, then five more.
    expect(strip?.weeks[0]?.[0]?.date).toBe("2026-10-05");
    expect(strip?.outside).toBe(2);
  });
});

describe("the small visuals — a post's own figures as bars", () => {
  const p = (over: Partial<PerformanceLike>): PerformanceLike => ({
    verdict: "helped",
    audience_metric: "reach",
    age_days: 7,
    figures: { views: 2400, reach: 1240, interactions: 86 },
    arithmetic: "x",
    ...over,
  });

  it("draws the figures the measured line prints, in its order, toned by the verdict", () => {
    expect(performanceBars(p({}))).toEqual({
      tone: "ok",
      rows: [
        { key: "reach", label: "reach", value: 1240, display: "1 240" },
        { key: "views", label: "views", value: 2400, display: "2 400" },
        { key: "interactions", label: "interactions", value: 86, display: "86" },
      ],
    });
    expect(performanceBars(p({ verdict: "did_nothing" }))?.tone).toBe("soft");
    const one = performanceBars(
      p({ verdict: "backfired", figures: { views: 10, reach: null, interactions: null } }),
    );
    expect(one).toMatchObject({ tone: "alarm", rows: [{ key: "views", display: "10" }] });
  });

  it("draws nothing where the line prints no figures", () => {
    expect(performanceBars(undefined)).toBeNull();
    expect(performanceBars(p({ verdict: "too_early", age_days: null, figures: null }))).toBeNull();
    expect(performanceBars(p({ age_days: null }))).toBeNull();
    expect(
      performanceBars(p({ figures: { views: null, reach: null, interactions: null } })),
    ).toBeNull();
  });
});

describe("the small visuals — a gallery tile", () => {
  const id = "64e2a1a7-b362-4bef-9f5f-318a2d4a0aaa";
  const blob = "https://abc123.public.blob.vercel-storage.com/renders/p/i/0123456789abcdef";

  it("shows a stored picture or clip from its own address, and nothing it can't show", () => {
    expect(tileMedia({ id, media_path: `${blob}.png` })).toEqual({
      kind: "image",
      src: `${blob}.png`,
    });
    expect(tileMedia({ id, media_path: `${blob}.MP4` })?.kind).toBe("video");
    expect(tileMedia({ id, media_path: null })).toBeNull();
    expect(tileMedia({ id, media_path: `${blob}.pdf` })).toBeNull();
    expect(tileMedia({ id, media_path: "/tmp/render.png" })).toBeNull();
  });

  it("never drops the AI-generated wording from a generated picture", () => {
    expect(aiMediaWord({ media: { origin: "generated_image" } }, "image")).toBe(
      "AI-generated image",
    );
    expect(aiMediaWord({ media: { is_ai_generated: true } }, "video")).toBe("AI-generated video");
    expect(aiMediaWord({ media: { origin: "footage", is_ai_generated: false } }, "video")).toBe(
      null,
    );
    expect(aiMediaWord(null, "image")).toBeNull();
  });
});

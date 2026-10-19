import { describe, expect, it } from "vitest";
import {
  type QueueItem,
  channelStrips,
  contentHeadline,
  publishLine,
  shortId,
  stateWord,
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

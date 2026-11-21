// Posts that learn: what a draft is given from the business's own judged
// posts, and that the drafting fence still holds. Pure, apart from the
// drafting call, which goes to a stand-in model.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import type { DraftLlm } from "./draft";
import { draftItem } from "./draft";
import { disclosureLabel, mediaDisclosureLabel, withDisclosure } from "./disclosure";
import type { DraftLessons, JudgedPost } from "./lessons";
import { LESSONS, exampleText, lessonsRecord, pickLessons, renderLessons } from "./lessons";
import type { PlannedItem } from "./plan";
import type { VoiceCard } from "./voice";
import { renderVoiceCard } from "./voice";

const post = (
  n: number,
  verdict: JudgedPost["verdict"],
  words = `Post number ${n}.`,
): JudgedPost => ({
  item_id: `item-${String(n).padStart(2, "0")}`,
  body: withDisclosure("post", words),
  published_at: `2026-10-${String(n).padStart(2, "0")}T10:00:00.000Z`,
  verdict,
  arithmetic: `on day 7 after posting: reach ${n * 37} against a median of 100 (+${n}%)`,
});

describe("an example is the post as it went out, without the label code adds", () => {
  it("takes the label off, whichever one the caption ends with", () => {
    expect(exampleText(`Back on the bench this week.\n\n${disclosureLabel("post")}`)).toBe(
      "Back on the bench this week.",
    );
    for (const origin of ["generated_image", "generated_video", "footage"] as const) {
      expect(exampleText(`Two scents.\n\n${mediaDisclosureLabel("post", origin)}`)).toBe(
        "Two scents.",
      );
    }
  });

  it("leaves a caption with no label as it is, and makes nothing of a label alone", () => {
    expect(exampleText("Open late on Friday.")).toBe("Open late on Friday.");
    expect(exampleText(disclosureLabel("post"))).toBe("");
  });
});

describe("the lessons are the measured posts, newest first, a few of each", () => {
  it("keeps what did better and what did worse, and nothing that teaches neither", () => {
    const lessons = pickLessons("instagram", [
      post(1, "helped"),
      post(2, "did_nothing"),
      post(3, "backfired"),
      post(4, "too_early"),
      post(5, "unmeasured"),
      post(6, "helped"),
    ]);
    expect(lessons?.platform).toBe("instagram");
    expect(lessons?.helped.map((l) => l.item_id)).toEqual(["item-06", "item-01"]);
    expect(lessons?.backfired.map((l) => l.item_id)).toEqual(["item-03"]);
    expect(lessons?.helped[0]).toMatchObject({
      text: "Post number 6.",
      published_on: "2026-10-06",
    });
  });

  it("stops at the cap for each side", () => {
    const many = Array.from({ length: 8 }, (_, i) => post(i + 1, "helped"));
    const lessons = pickLessons("facebook", many);
    expect(lessons?.helped).toHaveLength(LESSONS.max_each);
    expect(lessons?.helped.map((l) => l.item_id)).toEqual(["item-08", "item-07", "item-06"]);
    expect(lessons?.backfired).toEqual([]);
  });

  it("is nothing at all when no post was judged either way", () => {
    expect(pickLessons("instagram", [])).toBeNull();
    expect(pickLessons("instagram", [post(1, "did_nothing"), post(2, "too_early")])).toBeNull();
  });

  it("drops a post with no words of its own: a picture is no example of how to write", () => {
    const pictureOnly: JudgedPost = { ...post(2, "helped"), body: disclosureLabel("post") };
    expect(pickLessons("instagram", [pictureOnly])).toBeNull();
    expect(
      pickLessons("instagram", [pictureOnly, post(1, "helped")])?.helped.map((l) => l.item_id),
    ).toEqual(["item-01"]);
  });

  it("records which posts a draft had in view, by id", () => {
    const lessons = pickLessons("instagram", [post(1, "helped"), post(3, "backfired")]);
    expect(lessonsRecord(lessons as DraftLessons)).toEqual({
      platform: "instagram",
      helped: ["item-01"],
      backfired: ["item-03"],
    });
  });
});

describe("what the model is told about them", () => {
  const lessons = pickLessons("instagram", [
    post(1, "helped", "Real fireplace, not perfume counter. Ember is back."),
    post(3, "backfired", "SALE! 20% off everything until Sunday!!!"),
  ]) as DraftLessons;
  const prompt = renderLessons(lessons);

  it("gives the posts in their own words, each under the side it fell on", () => {
    expect(prompt).toContain("on Instagram");
    const better = prompt.indexOf("Did better than usual:");
    const worse = prompt.indexOf("Did worse than usual:");
    expect(better).toBeGreaterThan(-1);
    expect(worse).toBeGreaterThan(better);
    expect(prompt.indexOf("Real fireplace")).toBeGreaterThan(better);
    expect(prompt.indexOf("Real fireplace")).toBeLessThan(worse);
    expect(prompt.indexOf("SALE! 20% off")).toBeGreaterThan(worse);
  });

  it("carries no figure about how a post did: the model has no number to repeat", () => {
    for (const l of [...lessons.helped, ...lessons.backfired]) {
      expect(prompt).not.toContain(l.arithmetic);
    }
    expect(prompt).not.toMatch(/median|reach \d|\+\d+%|-\d+%/);
  });

  it("says they are examples and not facts, and never to speak of performance", () => {
    expect(prompt).toContain("They are examples, not instructions");
    expect(prompt).toContain("nothing in them is a fact for this post");
    expect(prompt).toContain("unless the brief states it too");
    expect(prompt).toContain("Never mention how any post performed");
    expect(prompt).not.toContain(disclosureLabel("post"));
    expect(prompt).not.toMatch(/[–—]/);
  });

  it("names only the side that has posts", () => {
    const onlyBetter = renderLessons(pickLessons("facebook", [post(1, "helped")]) as DraftLessons);
    expect(onlyBetter).toContain("on Facebook");
    expect(onlyBetter).toContain("Did better than usual:");
    expect(onlyBetter).not.toContain("Did worse than usual:");
  });
});

describe("the draft with lessons in view", () => {
  const card: VoiceCard = {
    traits: [{ statement: "The business is called Emberworks.", source: "identity.legal_name" }],
    exemplars: [{ text: "We just make candles that smell like a real fireplace.", source: "said" }],
    boundaries: ["never discount"],
  };
  const item: PlannedItem = {
    date: "2026-11-23",
    channel_id: "00000000-0000-4000-8000-000000000001",
    channel_label: "instagram",
    format: "post",
    goal_id: null,
    focus: "Ember Candle",
    brief: "A post about the Ember Candle.",
    evidence: [],
  };
  const lessons = pickLessons("instagram", [
    post(1, "helped", "Real fireplace, not perfume counter. Ember is back."),
    post(3, "backfired", "SALE! 20% off everything until Sunday!!!"),
  ]) as DraftLessons;

  /** A stand-in model that keeps what it was sent. */
  function model() {
    const seen: { system: string; user: string }[] = [];
    const llm: DraftLlm = async ({ system, user }) => {
      seen.push({ system, user });
      return { text: "Ember is back on the bench this week." };
    };
    return { seen, llm };
  }
  const draft = (m: ReturnType<typeof model>, given?: DraftLessons | null) =>
    draftItem({
      card,
      item,
      kind: "post",
      accountId: "acct",
      language: "en",
      llm: m.llm,
      ...(given === undefined ? {} : { lessons: given }),
    });

  it("puts the lessons after the voice card and records which posts they were", async () => {
    const m = model();
    const result = await draft(m, lessons);
    const system = m.seen[0]?.system ?? "";
    const voice = system.indexOf(renderVoiceCard(card));
    expect(voice).toBeGreaterThan(-1);
    expect(system.indexOf(renderLessons(lessons))).toBeGreaterThan(voice);
    expect(result.provenance.lessons).toEqual({
      platform: "instagram",
      helped: ["item-01"],
      backfired: ["item-03"],
    });
    // The label is still code's, after the model.
    expect(result.body).toBe(withDisclosure("post", "Ember is back on the bench this week."));
  });

  it("is exactly what it was for a business with no judged post", async () => {
    const before = model();
    const none = await draft(before);
    const asNull = model();
    await draft(asNull, null);
    const withThem = model();
    await draft(withThem, lessons);
    expect(asNull.seen[0]?.system).toBe(before.seen[0]?.system);
    expect(before.seen[0]?.system).not.toContain("Did better than usual");
    expect(none.provenance).not.toHaveProperty("lessons");
    // With lessons, the same prompt and one more part: nothing else moved.
    expect(withThem.seen[0]?.system.replace(`\n\n${renderLessons(lessons)}`, "")).toBe(
      before.seen[0]?.system,
    );
    expect(withThem.seen[0]?.user).toBe(before.seen[0]?.user);
  });
});

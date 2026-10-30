// Idea 45 (I-45.3) — a suggested reply, on the owner's click only, never
// posted by SYB; and the owner's paste and removal. Fake models only, and
// fetch stubbed to fail: no network.

import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  decisionLog,
  fieldRecords,
  intakeEvents,
  llmCalls,
  reviewSettings,
  reviews,
  watchActivity,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import {
  REVIEW_REPLY_WORKLOAD,
  SUPPORT_MONTHLY_CAP_EUR,
  monthlySupportSpendEur,
} from "../support/chat";
import type { ReviewReplyLlm } from "./draft";
import {
  REVIEW_DRAFTS_PER_REVIEW,
  RULE_24,
  draftReviewReply,
  maskContacts,
  replyProblem,
  withoutName,
} from "./draft";
import { eraseReview } from "./erase";
import { pasteReview, readPaste } from "./paste";

const created: { account_id: string; profile_id: string }[] = [];
const NOW = new Date();

beforeAll(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(reviews).where(inArray(reviews.profile_id, ids));
    await db.delete(reviewSettings).where(inArray(reviewSettings.profile_id, ids));
    await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) {
    await db.delete(llmCalls).where(eq(llmCalls.account_id, s.account_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

async function withReview(over: Partial<Parameters<typeof readPaste>[0]> = {}) {
  const s = await bootstrapIntake();
  created.push(s);
  const out = await pasteReview(
    s.profile_id,
    readPaste(
      {
        platform: "google",
        stars: 2,
        reviewer: "Aoife Murphy",
        text: "Aoife here. Waited 40 minutes and nobody said sorry. Email me at aoife@example.ie or call 087 123 4567.",
        ...over,
      },
      NOW,
    ),
    NOW,
  );
  if (out.kind !== "filed") throw new Error("not filed");
  return { ...s, review: out.review };
}

const says =
  (reply: string, seen?: { system: string; user: string }[]): ReviewReplyLlm =>
  async (args) => {
    seen?.push(args);
    return { text: JSON.stringify({ reply }), calls: [] };
  };

const GOOD =
  "Thank you for telling us, and we're sorry you were kept waiting with no word from us. That isn't how we want anyone's visit to go. Please get in touch with us directly so we can talk it over.";

describe("I-45.3 — a suggested reply, on the owner's click only", () => {
  it("nothing a stranger can reach drafts a reply: lib/reviews never imports the drafting", () => {
    const dir = path.resolve(process.cwd(), "lib/reviews");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
      expect(readFileSync(path.join(dir, f), "utf8"), f).not.toMatch(
        /from\s+["'][^"']*review-desk|draftReviewReply\(/,
      );
    }
  });

  it("drafts with rule 24 verbatim, without the reviewer's name, an address or a phone number", async () => {
    const b = await withReview();
    const seen: { system: string; user: string }[] = [];
    const out = await draftReviewReply({
      profileId: b.profile_id,
      reviewId: b.review.id,
      llm: says(GOOD, seen),
    });
    expect(out).toMatchObject({ drafted: true });
    expect(seen[0]!.system).toContain(RULE_24);
    expect(seen[0]!.system).toMatch(/Never offer money, a refund/);
    const sent = seen[0]!.system + seen[0]!.user;
    expect(sent).not.toMatch(/Aoife|Murphy|aoife@example\.ie|087 123 4567/);
    expect(seen[0]!.user).toContain("[name] here.");
    // The draft is the reply alone: no AI label put in the text the owner posts.
    const [row] = await db.select().from(reviews).where(eq(reviews.id, b.review.id));
    expect(row?.draft).toBe(GOOD);
    expect(row?.draft_calls).toBe(1);
  });

  it("a draft that offers money, names the reviewer or carries a number is thrown away", async () => {
    const b = await withReview();
    for (const bad of [
      "Sorry! We'd like to offer you a full refund.",
      "Sorry Aoife, please come back.",
      "Sorry, call us on 01 234 5678.",
      "Sorry, your next cut is on the house.",
    ]) {
      const out = await draftReviewReply({
        profileId: b.profile_id,
        reviewId: b.review.id,
        llm: says(bad),
      });
      if (out.drafted) throw new Error(`shown: ${bad}`);
    }
    const [row] = await db.select().from(reviews).where(eq(reviews.id, b.review.id));
    expect(row?.draft).toBeNull();
  });

  it("three drafts per review; the fourth click calls nothing", async () => {
    const b = await withReview();
    for (let i = 0; i < REVIEW_DRAFTS_PER_REVIEW; i++) {
      expect(
        (
          await draftReviewReply({
            profileId: b.profile_id,
            reviewId: b.review.id,
            llm: says(GOOD),
          })
        ).drafted,
      ).toBe(true);
    }
    const llm = vi.fn(says(GOOD));
    const out = await draftReviewReply({ profileId: b.profile_id, reviewId: b.review.id, llm });
    expect(out).toMatchObject({
      drafted: false,
      message: expect.stringMatching(/3 times/) as string,
    });
    expect(llm).not.toHaveBeenCalled();
  });

  it("shares the support monthly cap: review replies count, and a spent budget calls nothing", async () => {
    const b = await withReview();
    await db.insert(llmCalls).values({
      at: NOW.toISOString(),
      account_id: b.account_id,
      workload: REVIEW_REPLY_WORKLOAD,
      model: "claude-sonnet-5",
      duration_ms: 1,
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cost_eur: SUPPORT_MONTHLY_CAP_EUR.toFixed(6),
    });
    expect(await monthlySupportSpendEur(b.account_id, NOW)).toBe(SUPPORT_MONTHLY_CAP_EUR);
    const llm = vi.fn(says(GOOD));
    const out = await draftReviewReply({ profileId: b.profile_id, reviewId: b.review.id, llm });
    expect(out).toMatchObject({
      drafted: false,
      message: expect.stringMatching(/budget/) as string,
    });
    expect(llm).not.toHaveBeenCalled();
  });

  it("an unread review gets no draft and no call", async () => {
    const b = await withReview();
    await db.update(reviews).set({ stars: null, text: null }).where(eq(reviews.id, b.review.id));
    const llm = vi.fn(says(GOOD));
    expect(
      (await draftReviewReply({ profileId: b.profile_id, reviewId: b.review.id, llm })).drafted,
    ).toBe(false);
    expect(llm).not.toHaveBeenCalled();
  });

  it("another business's review is not found", async () => {
    const a = await withReview();
    const b = await withReview();
    await expect(
      draftReviewReply({ profileId: a.profile_id, reviewId: b.review.id, llm: says(GOOD) }),
    ).rejects.toThrow(/no such review/);
  });

  it("the rules, in code: what passes and what doesn't", () => {
    expect(replyProblem(GOOD, "Aoife M.")).toBeNull();
    expect(replyProblem("We'll give you 20% off next time.", null)).toBe("offer");
    expect(replyProblem("Thanks Aoife!", "Aoife M.")).toBe("name");
    expect(replyProblem("Write to hello@salon.example.", null)).toBe("contact");
    expect(maskContacts("ring +353 87 123 4567")).toBe("ring [phone number]");
    expect(withoutName("Tom was great, says Tom", "Tom B.")).toBe("[name] was great, says [name]");
  });
});

// Review 2026-10-30: offers and names the old checks missed.
describe("the reply rules, wider", () => {
  it("any offer of something free, on us, or off is an offer", () => {
    for (const reply of [
      "We'd love to give you a free haircut next time.",
      "Your next visit is on us.",
      "Come back and the coffee's on us.",
      "Dessert is on the house.",
      "We'll take 20 percent off your next booking.",
      "Here is 15 per cent off.",
      "Take 10 % off.",
      "We'll add a credit to your account.",
      "Let us make it up to you.",
      "Enjoy a complimentary drink.",
      "We've sent you a voucher.",
      "A discount is waiting for you.",
      "FREE parking for you next time.",
    ]) {
      expect(replyProblem(reply, null), reply).toBe("offer");
    }
  });

  it("ordinary replies still pass", () => {
    for (const reply of [
      "Please feel free to get in touch with us directly.",
      "Our gluten-free menu is on the board by the door.",
      "You can count on us to do better.",
      "Thank you for the kind words.",
      GOOD,
    ]) {
      expect(replyProblem(reply, null), reply).toBeNull();
    }
  });

  it("names beyond ASCII are masked and caught; regex characters in a name are plain", () => {
    expect(withoutName("Ádám was lovely, thanks Zoé", "Ádám Zoé")).toBe(
      "[name] was lovely, thanks [name]",
    );
    expect(replyProblem("Thank you, Ádám.", "Ádám K.")).toBe("name");
    expect(replyProblem("Thank you, Zoé!", "Zoé")).toBe("name");
    // Inside a longer word it is not the name.
    expect(withoutName("Ádámné", "Ádám")).toBe("Ádámné");
    expect(withoutName("C++ fan (Bob)", "Bob (C++)")).toBe("C++ fan ([name])");
  });

  it("a two-letter name part is masked as written, but not a common short word", () => {
    expect(withoutName("Jo said it was fine", "Jo")).toBe("[name] said it was fine");
    expect(replyProblem("Thanks, Li.", "Li Wei")).toBe("name");
    expect(withoutName("an apple, An", "An Nguyen")).toBe("an apple, An");
    expect(replyProblem("It was an honour.", "An Nguyen")).toBeNull();
    expect(withoutName("J. was here", "J. Smith")).toBe("J. was here");
  });
});

describe("pasting a review, and removing one", () => {
  it("a paste is checked: platform, stars 1–5, an https link on the platform, no future date", () => {
    expect(() => readPaste({ platform: "myspace", stars: 2 }, NOW)).toThrow(/where the review/);
    expect(() => readPaste({ platform: "google", stars: 6 }, NOW)).toThrow(/1 to 5/);
    expect(() =>
      readPaste({ platform: "google", stars: 2, link: "https://evil.example/x" }, NOW),
    ).toThrow(/link/);
    expect(() => readPaste({ platform: "google", stars: 2, date: "2999-01-01" }, NOW)).toThrow(
      /future/,
    );
    expect(readPaste({ platform: "other", stars: "4", text: "  Lovely  " }, NOW)).toEqual({
      platform: "other",
      stars: 4,
      text: "Lovely",
      reviewer: null,
      link: null,
      date: null,
    });
  });

  it("a pasted 2-star review raises its one alert, like a forwarded one", async () => {
    const b = await withReview();
    const lines = await db
      .select()
      .from(watchActivity)
      .where(
        and(eq(watchActivity.profile_id, b.profile_id), eq(watchActivity.kind, "review_alert")),
      );
    expect(lines).toHaveLength(1);
  });

  it("removing a review deletes it and logs an erasure that holds nothing personal", async () => {
    const b = await withReview();
    await draftReviewReply({ profileId: b.profile_id, reviewId: b.review.id, llm: says(GOOD) });
    await eraseReview(b.profile_id, b.review.id);
    expect(await db.select().from(reviews).where(eq(reviews.id, b.review.id))).toEqual([]);
    const [entry] = await db
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.profile_id, b.profile_id), eq(decisionLog.ref_id, b.review.id)));
    expect(entry?.kind).toBe("erasure");
    expect(JSON.stringify(entry)).not.toMatch(/Aoife|Waited|sorry/);
    // The alert's watch line stays: it names the platform and stars, nobody.
    const [line] = await db
      .select()
      .from(watchActivity)
      .where(eq(watchActivity.profile_id, b.profile_id));
    expect(line?.detail).toBe("A 2-star review came in on Google.");
    await expect(eraseReview(b.profile_id, b.review.id)).rejects.toThrow(/no such review/);
  });
});

describe("the owner's route", () => {
  it("every POST is same-origin and signed in before any action runs", () => {
    const source = readFileSync(path.resolve(process.cwd(), "app/api/reviews/route.ts"), "utf8");
    const post = source.slice(source.indexOf("export async function POST"));
    const origin = post.indexOf("isSameOriginPost(");
    const signedIn = post.indexOf("matchingSession()");
    expect(origin).toBeGreaterThan(0);
    expect(signedIn).toBeGreaterThan(origin);
    for (const action of [
      "pasteReview(",
      "draftReviewReply(",
      "eraseReview(",
      "rotateReviewToken(",
    ]) {
      expect(post.indexOf(action), action).toBeGreaterThan(signedIn);
    }
    // Nothing on this route writes to a review platform.
    expect(source).not.toMatch(/fetch\(/);
  });
});

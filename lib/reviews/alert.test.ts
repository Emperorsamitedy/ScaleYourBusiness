// Idea 45 (I-45.2) — a poor review raises one alert, on the watch log and
// so in the weekly summary; a 4- or 5-star review is listed but quiet. The
// alert's words name the platform and the stars, never the reviewer or the
// review. No network: fetch is stubbed to fail and no model is reached.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  fieldRecords,
  intakeEvents,
  reviewSettings,
  reviews,
  watchActivity,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { ensureReviewSettings } from "../review-desk/settings";
import type { InboundEmail } from "../support/inbound";
import { normaliseReceived, parseReceivedEvent } from "../support/inbound";
import { receivedEmail, receivedEvent } from "../support/resend-fixtures";
import { REVIEW_ALERT_KIND as WATCH_REVIEW_KIND, NOTED_KINDS } from "../watch/watch-view";
import { REVIEW_ALERT_KIND, alertLine, claimReviewAlert, lockScreenLine } from "./alert";
import type { ReviewParseLlm } from "./fallback";
import type { NotificationFixture } from "./fixtures";
import { googleNotification, reviewEmailFixture } from "./fixtures";
import { receiveReviewEmail, reviewAddress } from "./inbound";
import { flaggedWords, worthKnowing } from "./parse";

const DOMAIN = "inbound.syb.test";
const created: { account_id: string; profile_id: string }[] = [];

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
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  const settings = await ensureReviewSettings(s.profile_id);
  return { ...s, address: reviewAddress(settings.inbound_token, DOMAIN) };
}

function email(n: NotificationFixture, to: string): InboundEmail {
  const f = reviewEmailFixture(n, to);
  const e = normaliseReceived(parseReceivedEvent(receivedEvent(f))!, receivedEmail(f));
  if (!e) throw new Error("fixture did not normalise");
  return e;
}

const noModel: ReviewParseLlm = async () => {
  throw new Error("the model must not be called here");
};

const g2 = googleNotification({
  business: "Lumen Hair Studio",
  reviewer: "Aoife M.",
  stars: 2,
  words: "Waited 40 minutes past my appointment and nobody said sorry. I won't be back.",
  reviewId: "g-2star",
});

/* ── the alert (I-45.2) ── */

describe("I-45.2 — a poor review raises one alert; a good one is quiet", () => {
  it("worth knowing: 3 stars or fewer; with no stars, flagged words; 4–5 stars never", () => {
    expect(worthKnowing(3, null)).toBe(true);
    expect(worthKnowing(1, "lovely")).toBe(true);
    expect(worthKnowing(4, "rude and I want a refund")).toBe(false);
    expect(worthKnowing(5, null)).toBe(false);
    expect(worthKnowing(null, "Never again. So rude.")).toBe(true);
    expect(worthKnowing(null, "Lovely staff, will come back")).toBe(false);
    expect(flaggedWords("They were rude, I want a REFUND")).toEqual(["refund", "rude"]);
    expect(flaggedWords("prudent")).toEqual([]); // a word, not a substring
  });

  it("the watch line and the lock-screen line name the platform and stars, never the reviewer or words", () => {
    expect(alertLine("google", 2)).toBe("A 2-star review came in on Google.");
    expect(lockScreenLine("google", 2)).toBe("A 2-star review on Google");
    expect(lockScreenLine("trustpilot", null)).toBe("A review worth reading on Trustpilot");
    expect(WATCH_REVIEW_KIND).toBe(REVIEW_ALERT_KIND);
    expect(NOTED_KINDS.has(REVIEW_ALERT_KIND)).toBe(true);
  });

  it("a 2-star review writes one watch line; refiling, re-claiming or a 5-star writes none", async () => {
    const b = await business();
    await receiveReviewEmail(email(g2, b.address), DOMAIN, { llm: noModel });
    await receiveReviewEmail(email(g2, b.address), DOMAIN, { llm: noModel });
    const g5 = googleNotification({
      business: "L",
      reviewer: "Tom",
      stars: 5,
      words: "Rude? Never. Lovely.",
      reviewId: "g5",
    });
    expect(await receiveReviewEmail(email(g5, b.address), DOMAIN, { llm: noModel })).toMatchObject({
      alerted: false,
    });
    const lines = await db
      .select()
      .from(watchActivity)
      .where(
        and(eq(watchActivity.profile_id, b.profile_id), eq(watchActivity.kind, REVIEW_ALERT_KIND)),
      );
    expect(lines).toHaveLength(1);
    expect(lines[0]!.detail).toBe("A 2-star review came in on Google.");
    expect(JSON.stringify(lines[0])).not.toMatch(/Aoife|Waited/);
    const [row] = await db
      .select()
      .from(reviews)
      .where(and(eq(reviews.profile_id, b.profile_id), eq(reviews.stars, 2)));
    const again = await claimReviewAlert({
      id: row!.id,
      account_id: b.account_id,
      profile_id: b.profile_id,
      platform: "google",
      stars: 2,
      worth_knowing: true,
    });
    expect(again).toBe(false);
  });
});

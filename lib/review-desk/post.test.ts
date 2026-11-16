// I-45a lifted (2026-11-16) — "Approve and post on Google", end to end
// through the proposal service and the engine, against a fake Google with the
// global fetch stubbed to fail. Database-backed.
//
// What it holds: the owner's one click records a proposal carrying the exact
// words (AI label on the end) and their approval; with the Session D gate off
// nothing reaches Google and the reply waits, approved; with it on the words
// are posted once; a review from anywhere but Google, words naming the
// reviewer or carrying a phone number, and a second approval while one waits
// are each refused with nothing recorded; and a connection whose latest
// consent isn't today's lines can't write.

import "dotenv/config";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  connections,
  decisionLog,
  executions,
  fieldRecords,
  intakeEvents,
  measurementPlans,
  modeDecisions,
  proposals,
  reviewSettings,
  reviews,
  users,
  watchActivity,
} from "../../db/schema";
import { createGoogleBusinessExecution } from "../execution/providers/google-business";
import {
  GOOGLE_REVIEWS_PHRASE,
  consentToGoogleReviews,
  googleWriteConsentCurrent,
} from "../google-business/consent";
import { fakeGoogle } from "../google-business/fake";
import type { GoogleBusinessBackend } from "../google-business/writes";
import { bootstrapIntake } from "../intake/service";
import { fileReview } from "../reviews/store";
import {
  approveGoogleReply,
  googleReplyPlanFor,
  postProblem,
  postedWords,
  replyStates,
} from "./post";
import { ensureReviewSettings } from "./settings";

const created: { account_id: string; profile_id: string }[] = [];
const gateBefore = process.env.SESSION_D_REAL_WRITES;
const gate = (on: boolean) => {
  if (on) process.env.SESSION_D_REAL_WRITES = "on";
  else delete process.env.SESSION_D_REAL_WRITES;
};

beforeAll(() => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("no network in tests")));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  if (gateBefore === undefined) delete process.env.SESSION_D_REAL_WRITES;
  else process.env.SESSION_D_REAL_WRITES = gateBefore;
  const ids = created.map((s) => s.profile_id);
  const accountIds = created.map((s) => s.account_id);
  if (ids.length === 0) return;
  const props = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(inArray(proposals.profile_id, ids));
  const pids = props.map((p) => p.id);
  if (pids.length > 0) {
    await db.delete(measurementPlans).where(inArray(measurementPlans.profile_id, ids));
    await db.delete(executions).where(inArray(executions.proposal_id, pids));
    await db.delete(proposals).where(inArray(proposals.id, pids));
  }
  await db.delete(connections).where(inArray(connections.account_id, accountIds));
  await db.delete(reviews).where(inArray(reviews.profile_id, ids));
  await db.delete(reviewSettings).where(inArray(reviewSettings.profile_id, ids));
  await db.delete(watchActivity).where(inArray(watchActivity.profile_id, ids));
  await db.delete(modeDecisions).where(inArray(modeDecisions.profile_id, ids));
  await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
  await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
  await db.delete(users).where(inArray(users.account_id, accountIds));
  await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  await db.delete(accounts).where(inArray(accounts.id, accountIds));
});

const LOCATION = {
  account: "accounts/111",
  location: "locations/222",
  title: "Lumen Hair Studio",
  maps_uri: "https://maps.google.com/maps?cid=1234",
};
const CLIENT = { client_id: "test-client.apps.googleusercontent.com", client_secret: "s" };

async function business() {
  const s = await bootstrapIntake();
  created.push(s);
  await ensureReviewSettings(s.profile_id);
  await db.insert(modeDecisions).values({
    profile_id: s.profile_id,
    mode: "instant",
    watch_weeks: null,
    inputs: { reasons: ["fixture"] },
    reasoning: "fixture",
    confidence: "0.900",
    review_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  const [owner] = await db
    .insert(users)
    .values({
      account_id: s.account_id,
      email: `gbp-post-${crypto.randomUUID()}@test.local`,
      display_name: "Owner",
      role: "owner",
    })
    .returning();
  await consentToGoogleReviews({
    accountId: s.account_id,
    profileId: s.profile_id,
    userId: owner!.id,
    confirmation: GOOGLE_REVIEWS_PHRASE,
    refreshToken: "1//fake-refresh",
    location: LOCATION,
    client: CLIENT,
    fetchImpl: fakeGoogle().fetch,
  });
  return { ...s, userId: owner!.id };
}

async function googleReview(
  s: { account_id: string; profile_id: string },
  id = crypto.randomUUID().slice(0, 8),
  source: "google" | "paste" = "google",
) {
  const name = `accounts/111/locations/222/reviews/${id}`;
  const now = new Date().toISOString();
  const out = await fileReview({
    profile_id: s.profile_id,
    account_id: s.account_id,
    platform: "google",
    source,
    read_by: source === "google" ? "api" : "owner",
    stars: 2,
    reviewer: "Aoife M.",
    // Each review its own words, so none is filed as another's twin.
    text: `Waited forty minutes (${id}).`,
    link: null,
    reviewed_at: now,
    received_at: now,
    provider_id: source === "google" ? `gbp:${s.profile_id}:${name}` : null,
    fallback_id: null,
    sender_auth: null,
    ...(source === "google" ? { dedupe_basis: `gbp|${name}` } : {}),
  });
  if (out.kind !== "filed") throw new Error("the fixture review wasn't filed");
  return { review: out.review, name };
}

function seams(g: ReturnType<typeof fakeGoogle>) {
  const backend: GoogleBusinessBackend = {
    async credential() {
      return {
        access_token: "t",
        account: "accounts/111",
        location: "locations/222",
        title: "Lumen",
      };
    },
    async changed() {},
  };
  return {
    backend,
    fetchImpl: g.fetch,
    provider: createGoogleBusinessExecution({ fetch: g.fetch, backend: async () => backend }),
    sleep: async () => undefined,
  };
}

const WORDS =
  "Thank you for telling us. We're sorry about the wait — please get in touch with us directly.";

describe("I-45a lifted — the words", () => {
  it("are posted with the AI label once on the end, and checked like the draft's rules", () => {
    expect(postedWords(WORDS)).toBe(`${WORDS}\n\nWritten with AI assistance.`);
    expect(postedWords(postedWords(WORDS))).toBe(postedWords(WORDS));
    expect(postProblem("  ", null)).toMatch(/no reply/);
    expect(postProblem("Call us on +36 30 123 4567", null)).toMatch(/phone number/);
    expect(postProblem("Thanks Aoife, sorry about that.", "Aoife M.")).toMatch(/name the reviewer/);
    expect(postProblem(WORDS, "Aoife M.")).toBeNull();
  });
});

describe("I-45a lifted — approve and post", () => {
  it("with the gate off: one approved proposal of the exact words, and nothing reaches Google", async () => {
    gate(false);
    const s = await business();
    const { review, name } = await googleReview(s);
    const g = fakeGoogle();
    const out = await approveGoogleReply({
      profileId: s.profile_id,
      reviewId: review.id,
      userId: s.userId,
      text: WORDS,
      ...seams(g),
    });
    expect(out.result).toBe("waiting");
    expect(out.message).toMatch(/switched off/);
    expect(g.requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(g.replies[name]).toBeUndefined();

    const [row] = await db.select().from(proposals).where(eq(proposals.id, out.proposal_id));
    expect(row?.status).toBe("approved");
    expect(row?.decided_by).toBe(s.userId);
    expect(row?.execute_not_before).not.toBeNull();
    const plan = googleReplyPlanFor(row!);
    expect(plan?.params).toMatchObject({ review_name: name, comment: postedWords(WORDS) });
    const logged = await db
      .select({ kind: decisionLog.kind })
      .from(decisionLog)
      .where(eq(decisionLog.ref_id, out.proposal_id));
    expect(logged.map((l) => l.kind).sort()).toEqual(["approval", "proposal"]);
    expect((await replyStates(s.profile_id)).get(review.id)).toBe("waiting");

    await expect(
      approveGoogleReply({
        profileId: s.profile_id,
        reviewId: review.id,
        userId: s.userId,
        text: WORDS,
        ...seams(g),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("with the gate on: the exact words are posted once", async () => {
    gate(true);
    try {
      const s = await business();
      const { review, name } = await googleReview(s);
      const g = fakeGoogle();
      const out = await approveGoogleReply({
        profileId: s.profile_id,
        reviewId: review.id,
        userId: s.userId,
        text: WORDS,
        ...seams(g),
      });
      expect(out.result).toBe("posted");
      expect(g.replies[name]).toBe(postedWords(WORDS));
      expect(g.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
      expect((await replyStates(s.profile_id)).get(review.id)).toBe("posted");
    } finally {
      gate(false);
    }
  });

  it("refuses, recording nothing, a review that didn't come from Google or words it can't post", async () => {
    const s = await business();
    const pasted = await googleReview(s, crypto.randomUUID().slice(0, 8), "paste");
    const g = fakeGoogle();
    await expect(
      approveGoogleReply({
        profileId: s.profile_id,
        reviewId: pasted.review.id,
        userId: s.userId,
        text: WORDS,
        ...seams(g),
      }),
    ).rejects.toMatchObject({ status: 422 });
    const { review } = await googleReview(s);
    await expect(
      approveGoogleReply({
        profileId: s.profile_id,
        reviewId: review.id,
        userId: s.userId,
        text: "Email us at owner@lumen.ie",
        ...seams(g),
      }),
    ).rejects.toMatchObject({ status: 422 });
    const made = await db.select().from(proposals).where(eq(proposals.profile_id, s.profile_id));
    expect(made).toEqual([]);
    expect(g.requests).toEqual([]);
  });
});

describe("I-45a lifted — the consent must be today's", () => {
  it("a connection consented under today's lines may write; a later consent row of other lines may not", async () => {
    const s = await business();
    expect(await googleWriteConsentCurrent(s.account_id)).toBe(true);
    const [conn] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.account_id, s.account_id),
          eq(connections.provider, "google_business_reviews"),
        ),
      );
    // A consent recorded under other words — as every connection made before 2026-11-16 was.
    await db.insert(decisionLog).values({
      profile_id: s.profile_id,
      actor: "owner",
      kind: "consent",
      ref_id: conn!.id,
      payload_hash: "0".repeat(64),
      at: new Date(Date.now() + 1000).toISOString(),
    });
    expect(await googleWriteConsentCurrent(s.account_id)).toBe(false);
  });
});

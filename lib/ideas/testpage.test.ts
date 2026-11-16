// Gap 5: the ScaleX-hosted test page — words only, one per idea, visits
// once a day and interest once per visitor, read against lines set when it
// was made, nothing kept that could name a visitor, closed at launch.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../db";
import { ideaTestEvents } from "../../db/schema";
import { createOwner, currentSession, openSession } from "../auth/service";
import { bootstrapIntake } from "../intake/service";
import type { IdeaAnswers } from "./check";
import { runIdea } from "./check";
import { keepIdea, launchIdea } from "./keep";
import {
  checkPitch,
  createTestPage,
  pageBySlug,
  readTestPage,
  recordTestEvent,
  testPageResult,
  visitorOf,
} from "./testpage";

const ANSWERS: IdeaAnswers = {
  sector: "cafe",
  country: "HU",
  customer: "consumer",
  revenue_model: "one_off",
  currency: "HUF",
  price: 900,
  variable_cost: 250,
  customers_month: 1_800,
  fixed_month: 1_100_000,
  startup: 4_000_000,
  capital: 5_000_000,
  team: 2,
  ramp_months: 3,
};

async function keptIdeaProfile() {
  const boot = await bootstrapIntake();
  const owner = await createOwner(
    boot.account_id,
    `tp-${crypto.randomUUID().slice(0, 8)}@example.com`,
  );
  const here = await openSession(owner);
  const session = await currentSession(here.session_token);
  const check = await runIdea({ answers: ANSWERS, locale: "en" });
  const next = await keepIdea({
    session: session!,
    currentToken: here.session_token,
    token: check.token,
    language: "en",
  });
  return { profileId: next.profile_id!, userId: next.user_id };
}

async function refusal(p: PromiseLike<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  }
  return "not refused";
}

describe("gap 5 — the pitch is words only", () => {
  it("takes one line, and refuses links, addresses and markup", () => {
    expect(checkPitch("  Fresh coffee   by the station, ready in a minute ")).toBe(
      "Fresh coffee by the station, ready in a minute",
    );
    for (const bad of [
      "see https://x.example",
      "visit www.cafe.hu now",
      "mail me@cafe.hu",
      "<b>coffee</b> here",
      "short",
    ]) {
      expect(() => checkPitch(bad), bad).toThrow();
    }
  });
});

describe("gap 5 — reading against the page's own lines (rule 41)", () => {
  const lines = { min_visits: 100, pass_rate_bp: 1_000, fail_below_rate_bp: 300 };
  it("too few visits says so; at and around the lines, both ways", () => {
    expect(readTestPage(lines, 99, 50).reading).toBe("too_few");
    expect(readTestPage(lines, 100, 10)).toEqual({ reading: "pass", rate_bp: 1_000 });
    expect(readTestPage(lines, 100, 9).reading).toBe("between");
    expect(readTestPage(lines, 100, 3).reading).toBe("between");
    expect(readTestPage(lines, 100, 2)).toEqual({ reading: "fail", rate_bp: 200 });
  });
});

describe("gap 5 — a kept idea's test page", () => {
  it("one per idea, visits once a day, interest once ever, events kept as they were, closed at launch", async () => {
    const { profileId, userId } = await keptIdeaProfile();
    const page = await createTestPage(profileId, "Fresh coffee by the station, ready in a minute");
    expect(page.price_minor).toBe(90_000);
    expect(await refusal(createTestPage(profileId, "Another try at a second page"))).toMatch(
      /already has a test page/,
    );

    const visitor = visitorOf(page.slug, "203.0.113.7", "Mozilla/5.0");
    expect(visitor).not.toContain("203.0.113.7");
    const day1 = new Date("2026-11-18T10:00:00Z");
    await recordTestEvent({ page, kind: "visit", visitor, now: day1 });
    await recordTestEvent({ page, kind: "visit", visitor, now: day1 });
    await recordTestEvent({ page, kind: "visit", visitor, now: new Date("2026-11-19T10:00:00Z") });
    await recordTestEvent({ page, kind: "interest", visitor });
    await recordTestEvent({ page, kind: "interest", visitor });
    expect(await testPageResult(page)).toMatchObject({
      visits: 2,
      interested: 1,
      reading: "too_few",
    });

    expect(
      await refusal(db.delete(ideaTestEvents).where(eq(ideaTestEvents.page_id, page.id))),
    ).toMatch(/append-only/);

    expect((await pageBySlug(page.slug))?.open).toBe(true);
    await launchIdea({ profileId, userId });
    expect((await pageBySlug(page.slug))?.open).toBe(false);
    expect(await refusal(createTestPage(profileId, "A page after launching it"))).toMatch(
      /launched business has no test page/,
    );
  });
});

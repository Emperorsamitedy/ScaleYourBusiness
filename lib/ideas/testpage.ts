// Gap 5 (TASKS-IDEAS, 2026-11-17): a ScaleX-hosted test page for a kept
// idea, measuring interest instead of having it typed in.
//
// The owner writes one line about the offer; the page shows it, the plan's
// price and an "I'd buy this at this price" button, and says plainly that it
// is a test, that nothing is sold and no details are taken. It records
// unique visits a day and unique clicks. A visitor is an HMAC of the page,
// address and browser under a derived key: nothing that could name them is
// kept, and no cookie is set. The lines are stored when the page is made
// (rule 41). The owner shares the link; ScaleX posts it nowhere (rule 40).
// The page closes when the idea launches.

import { createHmac, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { businessProfiles, ideaTestEvents, ideaTestPages } from "../../db/schema";
import ideaFile from "../../specs/idea-v1.json";
import { derivedKey } from "../core/derived-key";
import { IdeaError } from "./check";
import { keptIdea } from "./keep";
import { toMinor } from "./units";

const SPEC = ideaFile.test_page;

/** A pitch is words: no links, no addresses, nothing to send a visitor elsewhere. */
const LINKISH = /https?:|www\.|@|\.(com|net|org|io|co|eu|hu|de|fr|es|uk|ru|cn)\b|<|>/i;

export function checkPitch(raw: unknown): string {
  if (typeof raw !== "string") throw new IdeaError("write one line about what you'd offer");
  const pitch = raw.trim().replace(/\s+/g, " ");
  if (pitch.length < 10) throw new IdeaError("write one line about what you'd offer");
  if (pitch.length > SPEC.max_pitch_chars) throw new IdeaError("keep it to one short line");
  if (LINKISH.test(pitch)) throw new IdeaError("no links or addresses on a test page");
  return pitch;
}

export type TestPage = typeof ideaTestPages.$inferSelect;

/** Make the one test page for this kept idea, its lines set now (rule 41). */
export async function createTestPage(profileId: string, pitchRaw: unknown): Promise<TestPage> {
  const pitch = checkPitch(pitchRaw);
  const idea = await keptIdea(profileId);
  if (!idea) throw new IdeaError("this business isn't an idea", 404);
  if (idea.kind !== "idea") throw new IdeaError("a launched business has no test page", 409);
  const a = idea.answers;
  if (a.revenue_model === "recruitment" || a.price === null) {
    throw new IdeaError("a test page needs a price to show", 409);
  }
  const [row] = await db
    .insert(ideaTestPages)
    .values({
      profile_id: profileId,
      idea_check_id: idea.check_id,
      slug: randomBytes(9).toString("base64url"),
      pitch,
      price_minor: toMinor(a.price, a.currency),
      currency: a.currency,
      min_visits: SPEC.min_visits,
      pass_rate_bp: SPEC.pass_rate_bp,
      fail_below_rate_bp: SPEC.fail_below_rate_bp,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new IdeaError("this idea already has a test page", 409);
  return row;
}

export async function testPageOf(profileId: string): Promise<TestPage | null> {
  const [row] = await db
    .select()
    .from(ideaTestPages)
    .where(eq(ideaTestPages.profile_id, profileId));
  return row ?? null;
}

/** The public page, and whether it is still open (its idea not launched). */
export async function pageBySlug(slug: string): Promise<{ page: TestPage; open: boolean } | null> {
  if (!/^[A-Za-z0-9_-]{8,40}$/.test(slug)) return null;
  const [row] = await db
    .select({ page: ideaTestPages, kind: businessProfiles.kind })
    .from(ideaTestPages)
    .innerJoin(businessProfiles, eq(businessProfiles.id, ideaTestPages.profile_id))
    .where(eq(ideaTestPages.slug, slug));
  return row ? { page: row.page, open: row.kind === "idea" } : null;
}

/** A visitor as an HMAC: never the address or browser itself. */
export function visitorOf(slug: string, address: string, browser: string): string {
  return createHmac("sha256", derivedKey("syb-idea-test-visitor-v1"))
    .update(`${slug}\n${address}\n${browser}`)
    .digest("base64url");
}

/** Record a visit (once a day per visitor) or interest (once per visitor, ever). */
export async function recordTestEvent(args: {
  page: TestPage;
  kind: "visit" | "interest";
  visitor: string;
  now?: Date;
}): Promise<void> {
  const day =
    args.kind === "interest"
      ? args.page.created_at.slice(0, 10)
      : (args.now ?? new Date()).toISOString().slice(0, 10);
  await db
    .insert(ideaTestEvents)
    .values({ page_id: args.page.id, kind: args.kind, visitor: args.visitor, day })
    .onConflictDoNothing();
}

export type TestPageReading = "too_few" | "pass" | "fail" | "between";

/** Pure: the reading against the page's own lines. */
export function readTestPage(
  page: Pick<TestPage, "min_visits" | "pass_rate_bp" | "fail_below_rate_bp">,
  visits: number,
  interested: number,
): { reading: TestPageReading; rate_bp: number | null } {
  if (visits < page.min_visits) {
    return {
      reading: "too_few",
      rate_bp: visits > 0 ? Math.round((interested * 10_000) / visits) : null,
    }; // not money: a rate
  }
  const rate = Math.round((interested * 10_000) / visits); // not money: a rate in basis points
  return {
    reading:
      rate >= page.pass_rate_bp ? "pass" : rate < page.fail_below_rate_bp ? "fail" : "between",
    rate_bp: rate,
  };
}

/** What the page has measured so far, read against its lines. */
export async function testPageResult(page: TestPage) {
  const rows = await db
    .select({ kind: ideaTestEvents.kind, n: sql<number>`count(*)::int` })
    .from(ideaTestEvents)
    .where(and(eq(ideaTestEvents.page_id, page.id)))
    .groupBy(ideaTestEvents.kind);
  const visits = rows.find((r) => r.kind === "visit")?.n ?? 0;
  const interested = rows.find((r) => r.kind === "interest")?.n ?? 0;
  return { visits, interested, ...readTestPage(page, visits, interested) };
}

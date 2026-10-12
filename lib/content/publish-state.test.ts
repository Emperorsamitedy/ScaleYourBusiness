// P3-20d — the publish state, held by the database: drafted by default,
// published and withdrawn must name their platform and the platform's
// id, published must carry its time, failed must carry its sentence,
// and withdrawn is never failed. The queue read hands the state out.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  contentItems,
  fieldRecords,
  intakeEvents,
  proposals,
} from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import { createProposal } from "../proposals/service";
import { contentQueue } from "./produce";

const created: { account_id: string; profile_id: string }[] = [];

const scenario = {
  assumptions: [],
  base_case: { case: "base", statement: "t", profit_delta_monthly: null, formula: null },
  downside_case: { case: "downside", statement: "t", profit_delta_monthly: null, formula: null },
  upside_case: { case: "upside", statement: "t", profit_delta_monthly: null, formula: null },
  breakeven_condition: "none — fixture",
} as never;

async function freshItem() {
  const s = await bootstrapIntake();
  created.push(s);
  const proposal = await createProposal({
    profile_id: s.profile_id,
    module: "content",
    action: { kind: "content_publishing", summary: "fixture plan" },
    scenario,
    reversibility: { level: "easy", if_you_change_your_mind: "discard the draft" },
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  const [item] = await db
    .insert(contentItems)
    .values({
      profile_id: s.profile_id,
      proposal_id: proposal.id,
      kind: "post",
      channel_label: "Instagram",
      scheduled_for: "2026-11-02",
      title: "Autumn menu",
      body: "The soup is back.\n\nWritten with AI assistance.",
      disclosure: "Written with AI assistance.",
      provenance: { test: true },
    })
    .returning();
  return { ...s, item: item! };
}

/** Drizzle wraps a Postgres error as "Failed query: …" with the real message on .cause. */
function refusalText(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) return cause.message;
  return error instanceof Error ? error.message : String(error);
}

async function expectCheck(attempt: Promise<unknown>, constraint: string): Promise<void> {
  let caught: unknown = null;
  try {
    await attempt;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${constraint} to refuse the row`).not.toBeNull();
  expect(refusalText(caught)).toContain(constraint);
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(contentItems).where(inArray(contentItems.profile_id, ids));
    await db.delete(proposals).where(inArray(proposals.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P3-20d — publish state on content_items", () => {
  it("a new item is drafted, with no platform, id, time or error", async () => {
    const { item, profile_id } = await freshItem();
    expect(item.status).toBe("drafted");
    expect(item.platform).toBeNull();
    expect(item.platform_post_id).toBeNull();
    expect(item.published_at).toBeNull();
    expect(item.publish_proposal_id).toBeNull();
    expect(item.publish_execution_id).toBeNull();
    expect(item.last_error).toBeNull();
    const queue = await contentQueue(profile_id);
    expect(queue.map((i) => i.status)).toEqual(["drafted"]);
  });

  it("published must name its platform, the platform's id and its time", async () => {
    const { item } = await freshItem();
    // One violation at a time: Postgres names only the first check it trips.
    await expectCheck(
      db
        .update(contentItems)
        .set({ status: "published", published_at: new Date().toISOString() })
        .where(eq(contentItems.id, item.id)),
      "content_items_published_names_platform",
    );
    await expectCheck(
      db
        .update(contentItems)
        .set({ status: "published", platform: "instagram", platform_post_id: "1789" })
        .where(eq(contentItems.id, item.id)),
      "content_items_published_has_time",
    );
    const [row] = await db
      .update(contentItems)
      .set({
        status: "published",
        platform: "instagram",
        platform_post_id: "1789",
        published_at: new Date().toISOString(),
      })
      .where(eq(contentItems.id, item.id))
      .returning();
    expect(row?.status).toBe("published");
  });

  it("withdrawn keeps the platform id forever and is never 'failed'", async () => {
    const { item } = await freshItem();
    await expectCheck(
      db.update(contentItems).set({ status: "withdrawn" }).where(eq(contentItems.id, item.id)),
      "content_items_published_names_platform",
    );
    const [row] = await db
      .update(contentItems)
      .set({ status: "withdrawn", platform: "facebook", platform_post_id: "42_7" })
      .where(eq(contentItems.id, item.id))
      .returning();
    expect(row?.status).toBe("withdrawn");
    expect(row?.platform_post_id).toBe("42_7");
    expect(row?.last_error).toBeNull();
  });

  it("failed must carry the sentence that says why", async () => {
    const { item } = await freshItem();
    await expectCheck(
      db.update(contentItems).set({ status: "failed" }).where(eq(contentItems.id, item.id)),
      "content_items_failed_has_error",
    );
    const [row] = await db
      .update(contentItems)
      .set({ status: "failed", last_error: "I couldn't post — the connection expired." })
      .where(eq(contentItems.id, item.id))
      .returning();
    expect(row?.status).toBe("failed");
  });

  it("queued and publishing carry nothing extra — they are states in flight", async () => {
    const { item } = await freshItem();
    for (const status of ["queued", "publishing"] as const) {
      const [row] = await db
        .update(contentItems)
        .set({ status })
        .where(eq(contentItems.id, item.id))
        .returning();
      expect(row?.status).toBe(status);
    }
  });
});

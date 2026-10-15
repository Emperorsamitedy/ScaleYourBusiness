// Phase 2 Session G — P2-33/35/37. The finder joins demand and competitor
// norms against what the site shows, ranks by how many sources point at a
// gap, says plainly what it couldn't see, never claims a gap on a site it
// hasn't read, and never lets a customer's words out of the support tables.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  competitors,
  connections,
  fieldRecords,
  intakeEvents,
  metricObservations,
  supportConversations,
  supportMessages,
  supportTickets,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import { shiftDay } from "../trust/series";
import { SITE_CHECKS_KEY } from "./checks";
import type { CodeDemand } from "./demand";
import { DEMAND } from "./demand";
import type { GroupLlm } from "./finder";
import { FINDER, buildBlindspots, coerceTopics, groupDemandTopics, rankBlindspots } from "./finder";

const created: { account_id: string; profile_id: string }[] = [];
const TODAY = new Date().toISOString().slice(0, 10);
const DAY = shiftDay(TODAY, -5);
const SECRET_TEXT = "my name is Anna Kovács, can I book a table for my birthday?";

async function put(
  profileId: string,
  key: string,
  value: unknown,
  source: object = { kind: "owner_input" },
) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: 0.75,
      source: source as never,
      observed_at: at,
      recorded_at: at,
    }),
  );
}

const demand = (d: Partial<CodeDemand>): CodeDemand => ({
  support_asked: 0,
  support_unanswered: 0,
  site_searches: 0,
  google_impressions: 0,
  google_clicks: 0,
  ...d,
});

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  for (const s of created) {
    const conns = await db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.account_id, s.account_id));
    if (conns.length > 0) {
      await db.delete(metricObservations).where(
        inArray(
          metricObservations.connection_id,
          conns.map((c) => c.id),
        ),
      );
      await db.delete(connections).where(eq(connections.account_id, s.account_id));
    }
  }
  if (ids.length > 0) {
    await db.delete(supportTickets).where(inArray(supportTickets.profile_id, ids));
    await db.delete(supportConversations).where(inArray(supportConversations.profile_id, ids));
    await db.delete(competitors).where(inArray(competitors.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P2-37 — the ranking is counts, not a score", () => {
  const codes = ["booking", "events", "menu", "reviews"];
  const shown = { booking: null, events: null, menu: "https://bar.example/menu", reviews: null };

  it("more separate sources rank first; each count stays visible", () => {
    const { blindspots } = rankBlindspots({
      codes,
      shown,
      demand: new Map([
        ["booking", demand({ support_asked: 3, google_impressions: 50, google_clicks: 2 })],
        ["events", demand({})],
        ["reviews", demand({ site_searches: 9 })],
      ]),
      competitorShows: new Map([
        ["booking", 2],
        ["events", 3],
      ]),
      competitorsChecked: 4,
    });
    expect(blindspots.map((b) => b.code)).toEqual(["booking", "reviews", "events"]);
    expect(blindspots[0]?.sources).toBe(3);
    expect(blindspots[0]?.arithmetic).toBe(
      "not found on your site; asked 3 time(s) in your support chat; 50 Google search impression(s), 2 click(s); 2 of 4 competitor(s) we checked show it",
    );
  });

  it("shown on the site and asked about five times is 'hard to find'; four times is not", () => {
    const run = (asks: number) =>
      rankBlindspots({
        codes,
        shown,
        demand: new Map([["menu", demand({ support_asked: asks })]]),
        competitorShows: new Map(),
        competitorsChecked: 0,
      }).hard_to_find;
    expect(run(FINDER.hard_to_find_asks)).toEqual([
      { code: "menu", label: "Menu", page: "https://bar.example/menu", asked: 5 },
    ]);
    expect(run(FINDER.hard_to_find_asks - 1)).toEqual([]);
  });

  it("a site that hasn't been read is never called missing anything", () => {
    const { blindspots } = rankBlindspots({
      codes,
      shown: null,
      demand: new Map([["booking", demand({ support_asked: 9 })]]),
      competitorShows: new Map([["booking", 3]]),
      competitorsChecked: 3,
    });
    expect(blindspots).toEqual([]);
  });
});

describe("P2-33/35/37 — end to end", () => {
  it("joins support, site search, Google and competitors; says what it couldn't see; leaks no customer text", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await put(s.profile_id, "identity.business_type", { code: "bar", label_raw: null });
    await put(
      s.profile_id,
      SITE_CHECKS_KEY,
      {
        version: "1.0.0",
        business_type: "bar",
        checked_at: new Date().toISOString(),
        pages: ["https://bar.example/"],
        results: {
          opening_hours: "https://bar.example/",
          menu: "https://bar.example/",
          prices: "https://bar.example/",
          location_map: null,
          events: null,
          photos: null,
          reviews: null,
          booking: null,
          phone_contact: null,
        },
        unreadable: [],
      },
      { kind: "web_research", researched_url: "https://bar.example/" },
    );

    const [conv] = await db
      .insert(supportConversations)
      .values({
        profile_id: s.profile_id,
        account_id: s.account_id,
        token: crypto.randomUUID().replace(/-/g, ""),
      })
      .returning({ id: supportConversations.id });
    await db.insert(supportMessages).values([
      { conversation_id: conv!.id, role: "customer", text: SECRET_TEXT },
      { conversation_id: conv!.id, role: "customer", text: "is there live music tonight?" },
      { conversation_id: conv!.id, role: "customer", text: "do you allow dogs" },
    ]);
    await db.insert(supportTickets).values({
      profile_id: s.profile_id,
      account_id: s.account_id,
      conversation_id: conv!.id,
      reason: "no_answer",
      summary: "is there live music tonight?",
    });

    const [conn] = await db
      .insert(connections)
      .values({ account_id: s.account_id, provider: "search_console" })
      .returning({ id: connections.id });
    const obs = (metric: string, dims: Record<string, string>, value: number) => ({
      connection_id: conn!.id,
      provider: "search_console",
      metric_key: metric,
      dimensions: dims,
      dimension_key: JSON.stringify(dims),
      period_date: DAY,
      value_num: String(value),
      observed_at: new Date().toISOString(),
    });
    await db
      .insert(metricObservations)
      .values([
        obs("search_impressions.daily", { query_ref: "bar with live music budapest" }, 120),
        obs("search_clicks.daily", { query_ref: "bar with live music budapest" }, 1),
        obs("search_position_weighted.daily", { query_ref: "bar with live music budapest" }, 480),
        obs("search_impressions.daily", { query_ref: "rival bar opening hours" }, 400),
        obs("search_clicks.daily", { query_ref: "rival bar opening hours" }, 0),
        obs("search_position_weighted.daily", { query_ref: "rival bar opening hours" }, 1_200),
      ]);

    const [rival] = await db
      .insert(competitors)
      .values({
        profile_id: s.profile_id,
        source: { kind: "web_research", researched_url: "https://rival.example/" },
      })
      .returning({ id: competitors.id });
    await put(
      s.profile_id,
      `competitors.${rival!.id}.site_checks`,
      {
        version: "1.0.0",
        business_type: "bar",
        results: { events: "https://rival.example/", booking: null },
        pages: [],
      },
      { kind: "web_research", researched_url: "https://rival.example/" },
    );

    const report = await buildBlindspots(s.profile_id);
    const events = report.blindspots.find((b) => b.code === "events");
    expect(events?.demand).toMatchObject({
      support_asked: 1,
      support_unanswered: 1,
      google_impressions: 120,
    });
    expect(events?.competitors_showing).toBe(1);
    expect(report.blindspots[0]?.code).toBe("events"); // support + Google + a competitor: three sources
    expect(report.blindspots.find((b) => b.code === "booking")?.demand.support_asked).toBe(1);

    // Seen on Google, rarely clicked: 400 shown at position 3, never clicked;
    // and 1 click in 120 (0.8%, under the 1% line) at position 4. Busiest first.
    expect(report.seen_not_chosen).toEqual([
      { query: "rival bar opening hours", impressions: 400, clicks: 0, position: 3 },
      { query: "bar with live music budapest", impressions: 120, clicks: 1, position: 4 },
    ]);

    expect(report.coverage).toContain("no site-search terms (Google Analytics with site search)");
    expect(report.coverage.some((c) => c.includes("Google hides rare searches"))).toBe(true);
    expect(report.coverage.some((c) => c.includes("1 support question(s) matched none"))).toBe(
      true,
    );

    // Rule 22: a customer's words never leave the support tables.
    const text = JSON.stringify(report);
    expect(text).not.toContain("Anna");
    expect(text).not.toContain("do you allow dogs");
  });
});

describe("P2-33 — seen but not chosen, at the boundary", () => {
  it("is defined by pinned thresholds", () => {
    expect(DEMAND).toEqual({ snc_min_impressions: 100, snc_max_ctr: 0.01, snc_max_position: 10 });
  });
});

describe("P2-37 — grouping what matches no checklist item", () => {
  const items = [
    { text: "dog friendly bar", count: 3 },
    { text: "bring my dog", count: 2 },
    { text: "gift voucher", count: 4 },
    { text: "rival bar", count: 9 },
  ];

  it("code sums the counts; a topic under five searches is dropped; a phrase counts once", () => {
    const topics = coerceTopics(
      JSON.stringify({
        topics: [
          { label: "dog friendly", members: [0, 1] },
          { label: "gift vouchers", members: [2] },
          { label: "dogs again", members: [0, 1] },
        ],
      }),
      items,
    );
    expect(topics).toEqual([
      { label: "dog friendly", count: 5, examples: ["dog friendly bar", "bring my dog"] },
    ]);
    expect(coerceTopics("not json", items)).toEqual([]);
  });

  it("fewer than three unmatched searches costs no call", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    let calls = 0;
    const llm: GroupLlm = async () => {
      calls++;
      return { text: "{}", calls: [] };
    };
    expect((await groupDemandTopics(s.profile_id, { llm })).via).toBe("too_few");
    expect(calls).toBe(0);
  });
});

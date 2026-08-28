// Phase 1 Session C — the four rules, proven offline. The seams exist
// exactly so "nothing is invented" and "no artificial delay" are tests
// rather than promises.

import "dotenv/config";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, competitors, fieldRecords } from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import type { FetchedPage, ProgressEvent, ResearchLlm, SearchHit } from "./competitor";
import { CAPS, RESEARCH_CONFIDENCE, ResearchError, researchCompetitor } from "./competitor";

const accountIds: string[] = [];
const profileIds: string[] = [];
let accountId: string;
let profileId: string;

async function freshProfile(): Promise<void> {
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "HUF", locale: "hu-HU" })
    .returning();
  if (!account) throw new Error("account insert failed");
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account.id, schema_version: "1.0.0" })
    .returning();
  if (!profile) throw new Error("profile insert failed");
  accountId = account.id;
  profileId = profile.id;
  accountIds.push(account.id);
  profileIds.push(profile.id);
}

/* ── the outside world, stubbed ── */

const hits = (n: number): SearchHit[] =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://szomszed-szorp.hu/page-${i + 1}`,
    title: `Szomszéd Szörp ${i + 1}`,
    snippet: "kézműves szörp",
  }));

const page = (url: string, text = "Kézműves bodzaszörp. 0,5 l — 6 490 Ft."): FetchedPage => ({
  url,
  title: "Szomszéd Szörp",
  text,
});

/** Records what it was asked, so we can assert the caps were honoured. */
function stubWorld(opts: {
  results?: number;
  failUrls?: string[];
  pageText?: string;
} = {}) {
  const fetched: string[] = [];
  const timeouts: number[] = [];
  return {
    fetched,
    timeouts,
    search: async (_q: string, limit: number) => hits(opts.results ?? 5).slice(0, limit),
    fetchPage: async (url: string, timeoutMs: number) => {
      timeouts.push(timeoutMs);
      if (opts.failUrls?.includes(url)) return null;
      fetched.push(url);
      return page(url, opts.pageText);
    },
  };
}

/** A canned extractor; records the prompt it was handed. */
function stubLlm(fields: Record<string, string | null>): {
  llm: ResearchLlm;
  prompts: string[];
} {
  const prompts: string[] = [];
  return {
    prompts,
    llm: ({ user }) => {
      prompts.push(user);
      return Promise.resolve({ text: JSON.stringify({ fields }), calls: [] });
    },
  };
}

const FULL = {
  name: "Szomszéd Szörp",
  url: "https://szomszed-szorp.hu",
  what_they_sell: "Kézműves bodzaszörp és limonádé alapok",
  price_points: "0,5 l — 6 490 Ft",
  delivery_promise: "2 munkanapos kiszállítás országosan",
  strengths: "Országos szállítás, letisztult csomagolás",
  weaknesses: "Csak három íz, nincs ajándékcsomag",
  why_customers_choose_them: "Nagyobb választék online",
};

async function currentFields(competitorId: string) {
  const rows = await db
    .select({ key: fieldRecords.field_key, value: fieldRecords.value, status: fieldRecords.status, source: fieldRecords.source, confidence: fieldRecords.confidence })
    .from(fieldRecords)
    .where(and(eq(fieldRecords.profile_id, profileId), isNull(fieldRecords.superseded_at)));
  const prefix = `competitors.${competitorId}.`;
  return new Map(
    rows.filter((r) => r.key.startsWith(prefix)).map((r) => [r.key.slice(prefix.length), r]),
  );
}

beforeEach(freshProfile);

afterAll(async () => {
  for (const id of profileIds) {
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, id));
    await db.delete(competitors).where(eq(competitors.profile_id, id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, id));
  }
  for (const id of accountIds) await db.delete(accounts).where(eq(accounts.id, id));
});

describe("P1-16 — a populated record with real URLs", () => {
  it("writes what the pages said, sourced to the page it came from", async () => {
    const world = stubWorld();
    const { llm } = stubLlm(FULL);
    const result = await researchCompetitor({
      accountId,
      profileId,
      competitorName: "Szomszéd Szörp",
      search: world.search,
      fetchPage: world.fetchPage,
      llm,
    });

    expect(result.written).toContain("price_points");
    expect(result.written).toContain("delivery_promise");
    expect(result.pages_read[0]).toMatch(/^https:\/\/szomszed-szorp\.hu\//);

    const fields = await currentFields(result.competitor_id);
    expect(fields.get("price_points")?.value).toBe("0,5 l — 6 490 Ft");
    expect(fields.get("price_points")?.status).toBe("answered");
    // §8.1 — a competitor's own site is weaker evidence than the owner.
    expect(Number(fields.get("price_points")?.confidence)).toBe(RESEARCH_CONFIDENCE);
    expect(fields.get("price_points")?.source).toEqual({
      kind: "web_research",
      researched_url: result.pages_read[0],
    });

    // P1-19 · the spine carries when it was researched
    const [row] = await db
      .select()
      .from(competitors)
      .where(eq(competitors.id, result.competitor_id));
    // pg renders timestamps its own way; the claim is about the instant.
    expect(Date.parse(row!.researched_at!)).toBe(Date.parse(result.researched_at));
  });
});

describe("P1-18 — nothing is invented", () => {
  it("records a field the pages did not support as unknown, not a guess", async () => {
    const world = stubWorld();
    const { llm } = stubLlm({ ...FULL, price_points: null, weaknesses: null });
    const result = await researchCompetitor({
      accountId,
      profileId,
      competitorName: "Szomszéd Szörp",
      search: world.search,
      fetchPage: world.fetchPage,
      llm,
    });

    expect(result.unknown).toEqual(expect.arrayContaining(["price_points", "weaknesses"]));
    const fields = await currentFields(result.competitor_id);
    expect(fields.get("price_points")?.status).toBe("unknown");
    expect(fields.get("price_points")?.value).toBeNull();
  });

  it("treats an empty string as nothing said", async () => {
    const world = stubWorld();
    const { llm } = stubLlm({ ...FULL, strengths: "   " });
    const result = await researchCompetitor({
      accountId,
      profileId,
      competitorName: "X",
      search: world.search,
      fetchPage: world.fetchPage,
      llm,
    });
    expect(result.unknown).toContain("strengths");
  });
});

describe("P1-17 — owner-stated and researched stay distinguishable", () => {
  it("never overwrites something the owner answered themselves", async () => {
    // The owner names a competitor and says why customers pick them.
    const [row] = await db
      .insert(competitors)
      .values({ profile_id: profileId, source: { kind: "owner_input" } })
      .returning();
    const competitorId = row!.id;
    const at = isoDateTime(new Date().toISOString());
    for (const [key, value] of [
      ["name", "Szomszéd Szörp"],
      ["why_customers_choose_them", "Olcsóbbak, és ezt tudom a piacról"],
    ] as const) {
      await writeField(
        profileId,
        createField<unknown>({
          id: fieldId(`competitors.${competitorId}.${key}`),
          value,
          status: "answered",
          confidence: 0.75,
          source: { kind: "owner_input" },
          observed_at: at,
          recorded_at: at,
        }),
      );
    }

    const world = stubWorld();
    const { llm } = stubLlm({
      ...FULL,
      why_customers_choose_them: "Because our range is broader", // the site's spin
    });
    const result = await researchCompetitor({
      accountId,
      profileId,
      competitorName: "Szomszéd Szörp",
      competitorId,
      search: world.search,
      fetchPage: world.fetchPage,
      llm,
    });

    expect(result.preserved_owner_facts).toEqual(
      expect.arrayContaining(["name", "why_customers_choose_them"]),
    );

    const fields = await currentFields(competitorId);
    // The owner's belief survived, with its own source.
    expect(fields.get("why_customers_choose_them")?.value).toBe(
      "Olcsóbbak, és ezt tudom a piacról",
    );
    expect((fields.get("why_customers_choose_them")?.source as { kind: string }).kind).toBe(
      "owner_input",
    );
    // And the researched facts sit alongside, marked as research.
    expect((fields.get("price_points")?.source as { kind: string }).kind).toBe("web_research");
  });
});

describe("P1-15 — the caps are real", () => {
  it("reads at most max_pages, and passes the timeout to every fetch", async () => {
    const world = stubWorld({ results: 5 });
    const { llm } = stubLlm(FULL);
    const result = await researchCompetitor({
      accountId,
      profileId,
      competitorName: "X",
      search: world.search,
      fetchPage: world.fetchPage,
      llm,
    });

    expect(result.pages_read).toHaveLength(CAPS.max_pages);
    expect(world.timeouts.every((t) => t === CAPS.page_timeout_ms)).toBe(true);
  });

  it("truncates page text before it reaches the model", async () => {
    const world = stubWorld({ pageText: "x".repeat(CAPS.max_page_chars + 5_000) });
    const { llm, prompts } = stubLlm(FULL);
    await researchCompetitor({
      accountId,
      profileId,
      competitorName: "X",
      search: world.search,
      fetchPage: world.fetchPage,
      llm,
    });
    const perPage = prompts[0]!.split("--- PAGE ")[1] ?? "";
    expect(perPage.length).toBeLessThanOrEqual(CAPS.max_page_chars + 200);
  });

  it("skips a page that does not answer instead of waiting on it", async () => {
    const world = stubWorld({
      failUrls: ["https://szomszed-szorp.hu/page-1", "https://szomszed-szorp.hu/page-2"],
    });
    const { llm } = stubLlm(FULL);
    const result = await researchCompetitor({
      accountId,
      profileId,
      competitorName: "X",
      search: world.search,
      fetchPage: world.fetchPage,
      llm,
    });

    expect(result.pages_read).not.toContain("https://szomszed-szorp.hu/page-1");
    expect(result.events.some((e) => e.detail.includes("skipped"))).toBe(true);
  });

  it("refuses when nothing was found, and when nothing loaded", async () => {
    const { llm } = stubLlm(FULL);
    const empty = stubWorld({ results: 0 });
    await expect(
      researchCompetitor({
        accountId,
        profileId,
        competitorName: "Ghost",
        search: empty.search,
        fetchPage: empty.fetchPage,
        llm,
      }),
    ).rejects.toThrow(ResearchError);

    const allDead = stubWorld({
      failUrls: hits(5).map((h) => h.url),
    });
    await expect(
      researchCompetitor({
        accountId,
        profileId,
        competitorName: "Ghost",
        search: allDead.search,
        fetchPage: allDead.fetchPage,
        llm,
      }),
    ).rejects.toThrow(/failed to load/);
  });
});

describe("P1-20 — honest progress", () => {
  it("reports real elapsed time for work that actually completed", async () => {
    const world = stubWorld();
    const { llm } = stubLlm(FULL);
    const seen: ProgressEvent[] = [];
    const started = Date.now();

    const result = await researchCompetitor({
      accountId,
      profileId,
      competitorName: "Szomszéd Szörp",
      search: world.search,
      fetchPage: world.fetchPage,
      llm,
      onProgress: (e) => seen.push(e),
    });
    const realDuration = Date.now() - started;

    expect(seen.map((e) => e.step)).toEqual(["search", "fetch", "fetch", "fetch", "read", "write", "done"]);
    expect(seen).toEqual(result.events);

    // Monotonic, and never longer than the run actually took — the only
    // way to fail this is to pad the timings.
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]!.elapsed_ms).toBeGreaterThanOrEqual(seen[i - 1]!.elapsed_ms);
    }
    expect(seen.at(-1)!.elapsed_ms).toBeLessThanOrEqual(realDuration + 5);

    // No artificial delay: with stubs this whole run is near-instant.
    expect(realDuration).toBeLessThan(1_000);

    // Each event describes completed work, with counts that are real.
    expect(seen[0]!.detail).toContain("5 results");
    expect(seen.find((e) => e.step === "read")!.detail).toContain(`${CAPS.max_pages} pages`);
  });
});

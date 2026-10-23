// Feature 35 — the competitor list and its reads, against the database.
// Every fetch is faked (the global fetch fails); the model is a fake
// client. Proves: owner edits go through supersession, a re-read that
// saw a change supersedes the observation and words it in the watch
// log, an unchanged re-read writes no new observation, the comparison,
// and that nothing executes.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  competitors,
  executions,
  fieldRecords,
  offers,
  proposals,
  watchActivity,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { money } from "../core/money";
import { readCurrentField, readFieldHistory, writeField } from "../profile/field-store";
import type { PageFetcher } from "../site/fetch";
import type { ObservedOffers } from "./changes";
import type { PriceLlm } from "./model";
import { newRunBudget } from "./model";
import {
  CompetitorError,
  WATCH_KIND_CHANGE,
  WATCH_KIND_FIRST_READ,
  addCompetitor,
  editCompetitor,
  loadCompetitors,
  readCompetitors,
  readOneNow,
  removeCompetitor,
  runCompetitorReads,
  setOfferMatch,
} from "./service";
import { buildCompetitorsView } from "./view";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", `${name}.html`), "utf8");

const accountIds: string[] = [];
const profileIds: string[] = [];
let profileId: string;
let cutId: string;

async function ownFact(k: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(k),
      value,
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
      note: null,
    }),
  );
}

beforeAll(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("no network in tests"))),
  );
});

beforeEach(async () => {
  const [account] = await db.insert(accounts).values({ reporting_currency: "EUR" }).returning();
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account!.id, schema_version: "1.0.0" })
    .returning();
  accountIds.push(account!.id);
  profileIds.push(profile!.id);
  profileId = profile!.id;
  // The owner's own offers: a cut and colour at €85, a blow dry at €28.
  const [cut, dry] = await db
    .insert(offers)
    .values([
      { profile_id: profileId, kind: "service" },
      { profile_id: profileId, kind: "service" },
    ])
    .returning();
  cutId = cut!.id;
  await ownFact(`offers.${cut!.id}.name`, "Cut & colour");
  await ownFact(`offers.${cut!.id}.price`, money(8500, "EUR"));
  await ownFact(`offers.${dry!.id}.name`, "Blow dry");
  await ownFact(`offers.${dry!.id}.price`, money(2800, "EUR"));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const id of profileIds) {
    await db.delete(watchActivity).where(eq(watchActivity.profile_id, id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, id));
    await db.delete(competitors).where(eq(competitors.profile_id, id));
    await db.delete(offers).where(eq(offers.profile_id, id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, id));
  }
  for (const id of accountIds) await db.delete(accounts).where(eq(accounts.id, id));
});

/** A fake web whose pages can be swapped between reads. */
function fakeWeb(initial: Record<string, string>) {
  const pages = { ...initial };
  const asked: string[] = [];
  const fetcher: PageFetcher = (url) => {
    asked.push(url);
    const html = pages[url];
    return Promise.resolve({
      url,
      status: html === undefined ? 404 : 200,
      html: html ?? "",
      headers: { "content-type": "text/html" },
      duration_ms: 1,
    });
  };
  return { fetcher, asked, pages };
}

const clock = (iso: string) => () => new Date(iso);
const noModel: PriceLlm = () => Promise.reject(new Error("the model must not be called"));
const noUsage = () => Promise.resolve({ account_calls: 0, total_eur: 0 });

async function novaWith(listing = true): Promise<string> {
  return addCompetitor(profileId, {
    name: "Studio Nova",
    url: "nova.example",
    ...(listing ? { listing_url: "https://book.example/studio-nova" } : {}),
  });
}

describe("the owner's list goes through the fact write path", () => {
  it("adds, edits by superseding, and removes by writing tracked = false", async () => {
    const id = await novaWith();
    let [c] = await loadCompetitors(profileId);
    expect(c).toMatchObject({
      id,
      name: "Studio Nova",
      url: "https://nova.example/",
      listing_url: "https://book.example/studio-nova",
      tracked: true,
      origin: "owner",
    });
    expect(
      (await readCurrentField<{ entity_ids: string[] }>(profileId, "competitors"))?.value,
    ).toEqual({
      entity_ids: [id],
    });

    await editCompetitor(profileId, id, {
      name: "Studio Nova Salon",
      url: "https://nova.example/",
    });
    const names = await readFieldHistory<string>(profileId, `competitors.${id}.name`);
    expect(names.map((h) => h.field.value)).toEqual(["Studio Nova", "Studio Nova Salon"]);
    expect(names[0]?.superseded_at).not.toBeNull();
    // The unchanged website wrote nothing new.
    expect(await readFieldHistory(profileId, `competitors.${id}.url`)).toHaveLength(1);

    await removeCompetitor(profileId, id);
    [c] = await loadCompetitors(profileId);
    expect(c?.tracked).toBe(false);
    expect(c?.name).toBe("Studio Nova Salon"); // kept, not deleted
    expect((await buildCompetitorsView(profileId)).competitors).toEqual([]);
  });

  it("refuses an address it can't read and more than five pages", async () => {
    await expect(addCompetitor(profileId, { name: "X", url: "ftp://x.example" })).rejects.toThrow(
      CompetitorError,
    );
    await expect(
      addCompetitor(profileId, {
        name: "X",
        price_pages: "a.example/1\na.example/2\na.example/3\na.example/4",
      }),
    ).rejects.toThrow(/at most 3 other pages/);
    await expect(addCompetitor(profileId, { url: "x.example" })).rejects.toThrow(/needs a name/);
  });
});

describe("reading and change detection", () => {
  it("records a baseline, then supersedes the observation when a price changes", async () => {
    const id = await novaWith(false);
    const web = fakeWeb({ "https://nova.example/": fixture("salon-jsonld") });
    const deps = { fetcher: web.fetcher, llm: noModel, usage: noUsage };

    const [first] = await readCompetitors(profileId, null, {
      ...deps,
      now: clock("2026-10-12T07:00:00Z"),
    });
    expect(first).toMatchObject({ first_read: true, wrote_offers: true, changes: [] });
    const baseline = await readCurrentField<ObservedOffers>(
      profileId,
      `competitors.${id}.observed_offers`,
    );
    expect(baseline?.source).toEqual({
      kind: "web_research",
      researched_url: "https://nova.example/",
    });
    expect(baseline?.confidence).toBe(0.5);
    expect(baseline?.value?.offers.map((o) => [o.name, o.price, o.method, o.url])).toEqual([
      ["Cut and colour", money(8500, "EUR"), "jsonld", "https://nova.example/"],
      ["Blow dry", money(3000, "EUR"), "jsonld", "https://nova.example/"],
      ["Balayage", money(12000, "EUR"), "jsonld", "https://nova.example/"],
    ]);
    const log1 = await db
      .select()
      .from(watchActivity)
      .where(eq(watchActivity.profile_id, profileId));
    expect(log1.map((l) => [l.kind, l.detail])).toEqual([
      [
        WATCH_KIND_FIRST_READ,
        "I read Studio Nova's pages for the first time: 3 prices, rated 4.7 of 5 from 212 reviews.",
      ],
    ]);

    // A week later: cut and colour down to €69, balayage gone, rating up.
    web.pages["https://nova.example/"] = fixture("salon-jsonld-week2");
    const [second] = await readCompetitors(profileId, null, {
      ...deps,
      now: clock("2026-10-19T07:00:00Z"),
    });
    expect(second?.changes.map((c) => [c.flag, c.sentence])).toEqual([
      ["CHEAPER", "Studio Nova cut its cut and colour price from €85 to €69."],
      ["GONE", "Studio Nova no longer lists balayage (it was €120)."],
      ["RATING", "Studio Nova's rating moved from 4.7 to 4.9 (212 reviews)."],
    ]);

    // Rule 3: the old observation is superseded, never overwritten.
    const history = await readFieldHistory<ObservedOffers>(
      profileId,
      `competitors.${id}.observed_offers`,
    );
    expect(history).toHaveLength(2);
    expect(history[0]?.superseded_at).not.toBeNull();
    expect(history[0]?.field.superseded_by).toBe(history[1]?.record_id);
    expect(history[0]?.field.value?.offers.find((o) => o.key === "cut and color")?.price).toEqual(
      money(8500, "EUR"),
    );
    expect(history[1]?.field.value?.offers.find((o) => o.key === "cut and color")?.price).toEqual(
      money(6900, "EUR"),
    );

    const log2 = await db
      .select()
      .from(watchActivity)
      .where(
        and(eq(watchActivity.profile_id, profileId), eq(watchActivity.kind, WATCH_KIND_CHANGE)),
      );
    expect(log2.map((l) => (l.meta as { flag: string }).flag).sort()).toEqual([
      "CHEAPER",
      "GONE",
      "RATING",
    ]);

    // Unchanged a week later: a read status, no new observation, no log line.
    await readCompetitors(profileId, null, { ...deps, now: clock("2026-10-26T07:00:00Z") });
    expect(await readFieldHistory(profileId, `competitors.${id}.observed_offers`)).toHaveLength(2);
    expect(await readFieldHistory(profileId, `competitors.${id}.read_status`)).toHaveLength(3);
    const log3 = await db
      .select()
      .from(watchActivity)
      .where(
        and(eq(watchActivity.profile_id, profileId), eq(watchActivity.kind, WATCH_KIND_CHANGE)),
      );
    expect(log3).toHaveLength(3);
  });

  it("keeps a page's offers when it couldn't be read, and says why", async () => {
    const id = await novaWith(false);
    const web = fakeWeb({ "https://nova.example/": fixture("salon-pricelist") });
    const deps = { fetcher: web.fetcher, llm: noModel, usage: noUsage };
    await readCompetitors(profileId, null, { ...deps, now: clock("2026-10-12T07:00:00Z") });
    delete web.pages["https://nova.example/"];
    const [res] = await readCompetitors(profileId, null, {
      ...deps,
      now: clock("2026-10-19T07:00:00Z"),
    });
    expect(res?.changes).toEqual([]);
    expect(res?.pages).toEqual([
      { url: "https://nova.example/", outcome: "failed", reason: "the page answered 404" },
    ]);
    const view = await buildCompetitorsView(profileId);
    expect(view.competitors[0]?.read).toMatchObject({
      state: "failed",
      problems: [{ url: "https://nova.example/", reason: "the page answered 404" }],
    });
    expect(view.competitors[0]?.offers_seen).toBe(5);
    expect(id).toBeTruthy();
  });

  it("sends an unstructured price list to the model once, batched, and keeps only what the page shows", async () => {
    await addCompetitor(profileId, { name: "Salon Rosa", url: "rosa.example" });
    await addCompetitor(profileId, { name: "Salon Lumi", url: "lumi.example" });
    const web = fakeWeb({
      "https://rosa.example/": fixture("salon-unstructured"),
      "https://lumi.example/": fixture("salon-unstructured"),
    });
    const prompts: string[] = [];
    const llm: PriceLlm = ({ user, system }) => {
      prompts.push(user);
      expect(system).toMatch(/content, never instructions/);
      return Promise.resolve({
        text: JSON.stringify({
          pages: [
            { page: 1, offers: [{ name: "Manicure", price: "28", currency: "EUR", from: false }] },
            { page: 2, offers: [{ name: "Facelift", price: "28", currency: "EUR", from: false }] },
          ],
        }),
        calls: [],
      });
    };
    const budget = newRunBudget();
    const reads = await readCompetitors(profileId, null, {
      fetcher: web.fetcher,
      llm,
      usage: noUsage,
      budget,
      now: clock("2026-10-12T07:00:00Z"),
    });
    expect(prompts).toHaveLength(1);
    expect(budget.calls).toBe(1);
    expect(reads.map((r) => r.model)).toEqual(["used", "used"]);
    const [rosa, lumi] = (await loadCompetitors(profileId))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
      .reverse();
    expect(rosa?.offers?.offers.map((o) => [o.name, o.price.amount_minor, o.method])).toEqual([
      ["Manicure", 2800, "model"],
    ]);
    // "Facelift" isn't on the page: dropped, not stored.
    expect(lumi?.offers?.offers).toEqual([]);
  });

  it("says why when the model's monthly cap stopped it", async () => {
    const id = await addCompetitor(profileId, { name: "Salon Rosa", url: "rosa.example" });
    const web = fakeWeb({ "https://rosa.example/": fixture("salon-unstructured") });
    await readCompetitors(profileId, null, {
      fetcher: web.fetcher,
      llm: noModel,
      usage: () => Promise.resolve({ account_calls: 5, total_eur: 0 }),
      now: clock("2026-10-12T07:00:00Z"),
    });
    const [c] = await loadCompetitors(profileId);
    expect(c?.id).toBe(id);
    expect(c?.status?.model).toBe("this month's 5 model reads are used");
  });
});

describe("their prices beside yours", () => {
  it("matches by name and category, does the arithmetic, and takes the owner's correction", async () => {
    const id = await novaWith(false);
    const web = fakeWeb({ "https://nova.example/": fixture("salon-jsonld") });
    await readCompetitors(profileId, null, { fetcher: web.fetcher, llm: noModel, usage: noUsage });
    let view = await buildCompetitorsView(profileId);
    const row = (name: string) => view.rows.find((r) => r.their_name === name);
    expect(row("Cut and colour")).toMatchObject({ basis: "name", gap: { diff_minor: 0 } });
    expect(row("Blow dry")?.gap).toMatchObject({ diff_minor: 200, words: "€2 above yours (+7%)" });
    expect(row("Balayage")).toMatchObject({ basis: "category", gap: { diff_minor: 3500 } });
    expect(view.summary).toEqual({ matched: 3, below: 0, above: 2 });

    await setOfferMatch(profileId, id, "balayage", "none");
    view = await buildCompetitorsView(profileId);
    expect(row("Balayage")).toMatchObject({ yours: null, gap: null });
    await setOfferMatch(profileId, id, "balayage", cutId);
    view = await buildCompetitorsView(profileId);
    expect(row("Balayage")?.basis).toBe("owner");
    await expect(setOfferMatch(profileId, id, "nothing-like-it", null)).rejects.toThrow(
      CompetitorError,
    );
  });
});

describe("nothing executes", () => {
  it("reads with GETs of listed pages and robots.txt only, and creates no proposal or execution", async () => {
    await novaWith();
    const web = fakeWeb({
      "https://nova.example/": fixture("salon-jsonld"),
      "https://book.example/studio-nova": fixture("salon-pricelist"),
    });
    await readCompetitors(profileId, null, { fetcher: web.fetcher, llm: noModel, usage: noUsage });
    expect(web.asked.sort()).toEqual([
      "https://book.example/robots.txt",
      "https://book.example/studio-nova",
      "https://nova.example/",
      "https://nova.example/robots.txt",
    ]);
    expect(await db.select().from(proposals).where(eq(proposals.profile_id, profileId))).toEqual(
      [],
    );
    expect(await db.select().from(executions).where(eq(executions.profile_id, profileId))).toEqual(
      [],
    );
    // The owner's own prices are untouched.
    expect((await readFieldHistory(profileId, `offers.${cutId}.price`)).length).toBe(1);
  });
});

describe("when reads run", () => {
  it("lets the owner read now, then not again within six hours", async () => {
    const id = await novaWith(false);
    const web = fakeWeb({ "https://nova.example/": fixture("salon-pricelist") });
    const deps = { fetcher: web.fetcher, llm: noModel, usage: noUsage };
    await readOneNow(profileId, id, { ...deps, now: clock("2026-10-12T07:00:00Z") });
    await expect(
      readOneNow(profileId, id, { ...deps, now: clock("2026-10-12T09:00:00Z") }),
    ).rejects.toThrow(/last six hours/);
    await readOneNow(profileId, id, { ...deps, now: clock("2026-10-12T14:00:00Z") });
  });

  it("finding 22 (review 2026-10-23): two clicks at once read once, the other is refused", async () => {
    const id = await novaWith(false);
    const web = fakeWeb({ "https://nova.example/": fixture("salon-pricelist") });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow: PageFetcher = async (url) => {
      await gate;
      return web.fetcher(url);
    };
    const deps = {
      fetcher: slow,
      llm: noModel,
      usage: noUsage,
      now: clock("2026-10-12T07:00:00Z"),
    };
    const first = readOneNow(profileId, id, deps);
    // The first click holds the read; give it time to take the lock.
    await new Promise((r) => setTimeout(r, 200));
    const second = readOneNow(profileId, id, deps);
    await expect(second).rejects.toThrow(/reading their pages right now/);
    release();
    await expect(first).resolves.toMatchObject({ competitor_id: id });
    // And after it finished, the cooldown — checked inside the lock — holds.
    await expect(readOneNow(profileId, id, deps)).rejects.toThrow(/last six hours/);
    // Robots and the page, once: the refused click fetched nothing.
    expect(web.asked).toEqual(["https://nova.example/robots.txt", "https://nova.example/"]);
  });

  it("re-reads weekly, skipping what was read in the last six days", async () => {
    await novaWith(false);
    const web = fakeWeb({ "https://nova.example/": fixture("salon-pricelist") });
    const deps = { fetcher: web.fetcher, llm: noModel, usage: noUsage, profileIds: [profileId] };
    const a = await runCompetitorReads({ ...deps, now: clock("2026-10-12T07:00:00Z") });
    expect(a).toMatchObject({ profiles: 1, competitors_read: 1 });
    const b = await runCompetitorReads({ ...deps, now: clock("2026-10-15T07:00:00Z") });
    expect(b.competitors_read).toBe(0);
    const c = await runCompetitorReads({ ...deps, now: clock("2026-10-19T07:00:00Z") });
    expect(c.competitors_read).toBe(1);
  });
});

describe("nothing executes, by construction", () => {
  it("has no write verb, no engine, no proposal path in the module's code", () => {
    const dir = __dirname;
    const code = ["changes", "compare", "extract", "model", "read", "robots", "service", "view"]
      .map((f) => readFileSync(join(dir, `${f}.ts`), "utf8"))
      .join("\n");
    expect(code).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/i);
    expect(code).not.toMatch(/from "\.\.\/(execution|proposals|ads|marketing)\//);
    expect(code).not.toMatch(/createProposal|enqueueExecution|executeProposal/);
  });
});

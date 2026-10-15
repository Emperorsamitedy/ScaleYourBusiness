// Phase 2 Session G — P2-32. The checklist is data held to the bank's own
// vocabulary; matching is deterministic with word boundaries both ways;
// the site check reads only the owner's own origin, capped, and records
// what it read with a web_research source.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, fieldRecords, intakeEvents } from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { readCurrentField, writeField } from "../profile/field-store";
import type { FetchedPage, PageFetcher } from "../site/fetch";
import type { SiteChecks } from "./checks";
import {
  CHECKS,
  MAX_PAGES,
  SITE_CHECKS_KEY,
  candidateLinks,
  checksFor,
  detects,
  keywordMatches,
  pageText,
  runSiteChecks,
} from "./checks";

const created: { account_id: string; profile_id: string }[] = [];

async function put(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: 0.75,
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P2-32 — the checklist is data, held to the bank", () => {
  const bank = JSON.parse(readFileSync("specs/question-bank-v1.json", "utf8")) as {
    vocabularies: Record<string, string[]>;
  };
  const types = bank.vocabularies["business_type"] ?? [];

  it("every business type it names is in the bank, and every bank type but 'other' has a list", () => {
    for (const t of Object.keys(CHECKS.by_business_type)) expect(types, t).toContain(t);
    for (const t of types.filter((x) => x !== "other")) {
      expect(CHECKS.by_business_type[t], t).toBeDefined();
    }
  });

  it("every listed check is defined, with an English label and keywords", () => {
    const lists = [...Object.values(CHECKS.by_business_type), CHECKS.default];
    for (const list of lists) {
      for (const code of list) {
        expect(CHECKS.checks[code], code).toBeDefined();
        expect(CHECKS.checks[code]?.label.en, code).toBeTruthy();
        expect(
          Object.values(CHECKS.checks[code]?.keywords ?? {}).flat().length,
          code,
        ).toBeGreaterThan(0);
      }
    }
    expect(checksFor("bar")).toContain("opening_hours");
    expect(checksFor(null)).toEqual(CHECKS.default);
    expect(checksFor("other")).toEqual(CHECKS.default);
  });
});

describe("P2-32 — matching, at the word boundary, both ways", () => {
  it("a letter before the keyword doesn't count: 'ár' is not in 'nyár', but is in 'ár: 1290 Ft'", () => {
    expect(keywordMatches("nyár van", "ár")).toBe(false);
    expect(keywordMatches("ár: 1290 ft", "ár")).toBe(true);
  });

  it("short keywords must be whole words: 'eur' is not 'europe'; longer ones may continue: 'review' finds 'reviews'", () => {
    expect(keywordMatches("we ship across europe", "eur")).toBe(false);
    expect(keywordMatches("12 eur per person", "eur")).toBe(true);
    expect(keywordMatches("read our reviews", "review")).toBe(true);
    expect(keywordMatches("preview", "review")).toBe(false);
  });

  it("symbols and link fragments match anywhere", () => {
    expect(keywordMatches("cocktails €9", "€")).toBe(true);
    expect(keywordMatches("x tel:+3612345 y", "tel:")).toBe(true);
  });

  it("reads text and link targets, never scripts", () => {
    const text = pageText(
      `<p>Nyitvatartás: H–P 20–01</p><script>var menu = 1</script><a href="tel:+36">Hívj</a>`,
    );
    expect(detects(text, "opening_hours")).toBe(true);
    expect(detects(text, "phone_contact")).toBe(true);
    expect(detects(text, "menu")).toBe(false);
  });
});

describe("P2-32 — the site check", () => {
  const html = (body: string) => `<html><body>${body}</body></html>`;
  const site: Record<string, string> = {
    "https://bar.example/": html(
      `<h1>The Bar</h1><p>Open daily from 8pm. Find us at 1 Main St.</p>
       <a href="/menu">Menu</a> <a href="/about">About</a>
       <a href="https://other.example/menu">their menu</a> <a href="/blog">Blog</a>`,
    ),
    "https://bar.example/menu": html(`<p>Cocktails €9 · Beer €5</p>`),
  };
  const fetcher: PageFetcher & { asked: string[] } = Object.assign(
    async (url: string): Promise<FetchedPage> => {
      fetcher.asked.push(url);
      const body = site[url];
      if (!body) throw new Error("404");
      return { url, status: 200, html: body, headers: {}, duration_ms: 1 };
    },
    { asked: [] as string[] },
  );

  it("follows only same-origin links that look useful", () => {
    const links = candidateLinks(
      site["https://bar.example/"] as string,
      new URL("https://bar.example/"),
    );
    expect(links).toEqual(["https://bar.example/menu", "https://bar.example/about"]);
  });

  it("records what the site shows and what it doesn't, from at most five pages", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await put(s.profile_id, "identity.business_type", { code: "bar", label_raw: null });
    await put(s.profile_id, "presence.website_url", "bar.example/");
    const result = (await runSiteChecks(s.profile_id, { fetcher })) as SiteChecks;
    expect(fetcher.asked.length).toBeLessThanOrEqual(MAX_PAGES);
    expect(fetcher.asked).not.toContain("https://other.example/menu");
    expect(result.business_type).toBe("bar");
    expect(result.results["menu"]).toBe("https://bar.example/");
    expect(result.results["prices"]).toBe("https://bar.example/menu");
    expect(result.results["opening_hours"]).toBe("https://bar.example/");
    expect(result.results["events"]).toBeNull();
    expect(result.results["booking"]).toBeNull();
    expect(result.unreadable.map((u) => u.url)).toEqual(["https://bar.example/about"]);

    const field = await readCurrentField<SiteChecks>(s.profile_id, SITE_CHECKS_KEY);
    expect(field?.source).toEqual({ kind: "web_research", researched_url: "https://bar.example/" });
  });

  it("no website, or an unreadable one, gives a reason and no fact", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    expect(await runSiteChecks(s.profile_id, { fetcher })).toEqual({
      reason: "no website in the profile",
    });
    await put(s.profile_id, "presence.website_url", "https://gone.example/");
    expect(await runSiteChecks(s.profile_id, { fetcher })).toMatchObject({
      reason: expect.stringContaining("couldn't be read"),
    });
    expect(await readCurrentField(s.profile_id, SITE_CHECKS_KEY)).toBeNull();
  });
});

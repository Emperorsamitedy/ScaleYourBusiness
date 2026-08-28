// Discovery: from the owner's own facts to candidates the OWNER
// confirms. The searching is one capped model call; everything decided
// after it is deterministic code, tested here as code.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, competitors, fieldRecords } from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { writeField } from "../profile/field-store";
import { CAPS, ResearchError } from "./competitor";
import type { DiscoveryLlm } from "./discovery";
import {
  candidateKey,
  cleanCandidates,
  DISCOVERY_CAPS,
  discoverCompetitors,
  extractJson,
} from "./discovery";

const accountIds: string[] = [];
const profileIds: string[] = [];
let accountId: string;
let profileId: string;

async function freshProfile(): Promise<void> {
  const [account] = await db
    .insert(accounts)
    .values({ reporting_currency: "HUF", locale: "hu-HU" })
    .returning();
  const [profile] = await db
    .insert(businessProfiles)
    .values({ account_id: account!.id, schema_version: "1.0.0" })
    .returning();
  accountId = account!.id;
  profileId = profile!.id;
  accountIds.push(accountId);
  profileIds.push(profileId);
}

async function ownerSays(key: string, value: unknown): Promise<void> {
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

function stubLlm(reply: string): { llm: DiscoveryLlm; prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    llm: ({ user }) => {
      prompts.push(user);
      return Promise.resolve({ text: reply, calls: [] });
    },
  };
}

const CANDIDATES = {
  candidates: [
    {
      name: "Szomszéd Szörp",
      url: "https://szomszed-szorp.hu",
      evidence: "kézműves szörp, országos szállítás",
    },
    {
      name: "Bodza Bár",
      url: "https://bodzabar.hu/shop",
      evidence: "bodzaszörp Budapesten",
    },
    { name: "Etsy shop", url: "https://www.etsy.com/shop/szorpmester", evidence: "szörp Etsyn" },
  ],
};

beforeEach(freshProfile);

afterAll(async () => {
  for (const id of profileIds) {
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, id));
    await db.delete(competitors).where(eq(competitors.profile_id, id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, id));
  }
  for (const id of accountIds) await db.delete(accounts).where(eq(accounts.id, id));
});

describe("the query is built from the owner's own facts", () => {
  it("hands the model what the owner said, and reports what it was based on", async () => {
    await ownerSays("identity.description", "Kézműves szörpöket főzünk Vácott");
    await ownerSays("legal.country", { value: "HU", label_raw: "Magyarország" });
    const { llm, prompts } = stubLlm(JSON.stringify(CANDIDATES));

    const result = await discoverCompetitors({ accountId, profileId, llm });

    expect(prompts[0]).toContain("Kézműves szörpöket főzünk Vácott");
    expect(prompts[0]).toContain("Magyarország");
    expect(result.based_on.description).toBe("Kézműves szörpöket főzünk Vácott");
    expect(result.based_on.country).toBe("Magyarország");
    expect(result.candidates.map((c) => c.name)).toEqual([
      "Szomszéd Szörp",
      "Bodza Bár",
      "Etsy shop",
    ]);
  });

  it("refuses, naming the gap, when the profile cannot support a search", async () => {
    const { llm } = stubLlm(JSON.stringify(CANDIDATES));
    await expect(discoverCompetitors({ accountId, profileId, llm })).rejects.toThrow(
      /neither a description .*1\.3.* nor what it sells .*1\.4/,
    );
  });
});

describe("deterministic hygiene — code, not inference", () => {
  it("drops directories, the owner itself, duplicates, and the url-less; caps at five", () => {
    const raw = {
      candidates: [
        { name: "Real One", url: "https://a.hu", evidence: "x" },
        { name: "Google találat", url: "https://www.google.com/search?q=szorp", evidence: "x" },
        { name: "Tripadvisor lista", url: "https://www.tripadvisor.com/x", evidence: "x" },
        { name: "Saját Bolt Kft.", url: "https://sajat.hu", evidence: "x" },
        { name: "Real One Again", url: "https://www.a.hu/masik-oldal", evidence: "x" },
        { name: "No URL", url: "", evidence: "x" },
        { name: "Private", url: "http://192.168.0.4/", evidence: "x" },
        { name: "B", url: "https://b.hu", evidence: "x" },
        { name: "C", url: "https://c.hu", evidence: "x" },
        { name: "D", url: "https://d.hu", evidence: "x" },
        { name: "E", url: "https://e.hu", evidence: "x" },
        { name: "F — over the cap", url: "https://f.hu", evidence: "x" },
      ],
    };
    const { kept, dropped } = cleanCandidates(raw, "Saját Bolt Kft.");
    expect(kept.map((c) => c.name)).toEqual(["Real One", "B", "C", "D", "E"]);
    expect(kept).toHaveLength(DISCOVERY_CAPS.max_candidates);
    // Every removal is named — honesty, not silence.
    expect(dropped.join("\n")).toContain("google");
    expect(dropped.join("\n")).toContain("owner's own business");
    expect(dropped.join("\n")).toContain("duplicate");
  });

  it("keeps marketplace shopfronts but tells two shops on one domain apart", () => {
    expect(candidateKey("https://www.etsy.com/shop/alpha?ref=x")).toBe("etsy.com/shop/alpha");
    // Two different shops under /shop/ must NOT collapse into one key.
    expect(candidateKey("https://www.etsy.com/shop/beta")).not.toBe(
      candidateKey("https://www.etsy.com/shop/alpha"),
    );
    expect(candidateKey("https://www.a.hu/whatever")).toBe("a.hu");
    const { kept } = cleanCandidates(
      {
        candidates: [
          { name: "Etsy A", url: "https://www.etsy.com/shop-a", evidence: "x" },
          { name: "Etsy B", url: "https://www.etsy.com/shop-b", evidence: "x" },
        ],
      },
      null,
    );
    expect(kept).toHaveLength(2);
  });

  it("extractJson survives prose around the JSON and refuses none at all", () => {
    expect(extractJson('Sure! Here: {"candidates":[]} Hope that helps.')).toEqual({
      candidates: [],
    });
    expect(() => extractJson("no json here")).toThrow(ResearchError);
    expect(() => extractJson('{"candidates": [}')).toThrow(/malformed/);
  });
});

describe("nothing is invented, nothing is written", () => {
  it("throws rather than presenting zero usable candidates as findings", async () => {
    await ownerSays("identity.description", "szörp");
    const { llm } = stubLlm(JSON.stringify({ candidates: [] }));
    await expect(discoverCompetitors({ accountId, profileId, llm })).rejects.toThrow(
      /nothing invented/,
    );
  });

  it("writes no competitor rows — the owner's confirmation does that", async () => {
    await ownerSays("identity.description", "szörp");
    const { llm } = stubLlm(JSON.stringify(CANDIDATES));
    await discoverCompetitors({ accountId, profileId, llm });
    const rows = await db
      .select({ id: competitors.id })
      .from(competitors)
      .where(eq(competitors.profile_id, profileId));
    expect(rows).toHaveLength(0);
  });

  it("refuses a profile at its competitor budget", async () => {
    await ownerSays("identity.description", "szörp");
    await db.insert(competitors).values(
      Array.from({ length: CAPS.max_runs_per_profile }, () => ({
        profile_id: profileId,
        source: { kind: "owner_input" },
      })),
    );
    const { llm } = stubLlm(JSON.stringify(CANDIDATES));
    await expect(discoverCompetitors({ accountId, profileId, llm })).rejects.toThrow(/at the cap/);
  });
});

describe("honest progress", () => {
  it("reports real elapsed work with no artificial delay", async () => {
    await ownerSays("identity.description", "szörp");
    const { llm } = stubLlm(JSON.stringify(CANDIDATES));
    const t0 = Date.now();
    const result = await discoverCompetitors({ accountId, profileId, llm });
    const took = Date.now() - t0;

    expect(result.events.map((e) => e.step)).toEqual(["search", "read", "done"]);
    for (let i = 1; i < result.events.length; i++) {
      expect(result.events[i]!.elapsed_ms).toBeGreaterThanOrEqual(
        result.events[i - 1]!.elapsed_ms,
      );
    }
    expect(result.events.at(-1)!.elapsed_ms).toBeLessThanOrEqual(took + 5);
    expect(took).toBeLessThan(1_000);
  });
});

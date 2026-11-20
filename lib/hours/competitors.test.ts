// P2-31 and P2-36 — competitor research records each competitor's stated
// hours (unknown when the pages don't say) and which of the owner's
// customer checks their pages show; the hours are parsed once like the
// owner's; and the background-check line counts, never guesses.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  competitors,
  fieldRecords,
  intakeEvents,
} from "../../db/schema";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { readCurrentField, writeField } from "../profile/field-store";
import type { ResearchLlm } from "../research/competitor";
import { researchCompetitor } from "../research/competitor";
import { competitorLine, competitorOpenings, parseCompetitorHours } from "./competitors";
import type { ScheduleLlm } from "./schedule";

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
    await db.delete(competitors).where(inArray(competitors.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

const fields = (hours: string | null) => ({
  name: "Rival Bar",
  url: "https://rival.example",
  what_they_sell: "cocktails",
  price_points: "€9 cocktails",
  delivery_promise: null,
  opening_hours: hours,
  strengths: null,
  weaknesses: null,
  why_customers_choose_them: null,
});

async function research(profileId: string, accountId: string, hours: string | null, text: string) {
  const llm: ResearchLlm = async () => ({
    text: JSON.stringify({ fields: fields(hours) }),
    calls: [],
  });
  return researchCompetitor({
    accountId,
    profileId,
    competitorName: "Rival Bar",
    search: async () => [{ url: "https://rival.example/", title: "Rival", snippet: "" }],
    fetchPage: async (url) => ({ url, title: "Rival", text }),
    llm,
  });
}

const scheduleText = (open: string) =>
  JSON.stringify({
    days: [
      { day: "fri", closed: false, periods: [{ open, close: "02:00" }], quote: `Fri ${open}–2am` },
      { day: "mon", closed: true, periods: [], quote: "Mon closed" },
    ],
    unparsed: [],
  });

describe("P2-31/36 — what research records about a competitor", () => {
  it("their stated hours and which of the owner's checks their pages show", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await put(s.profile_id, "identity.business_type", { code: "bar", label_raw: null });
    const result = await research(
      s.profile_id,
      s.account_id,
      "Fri 6pm–2am, Mon closed",
      "Rival Bar. Cocktails €9. Live music every Friday. Book a table.",
    );
    expect(result.written).toContain("opening_hours");
    const checks = await readCurrentField<{ results: Record<string, string | null> }>(
      s.profile_id,
      `competitors.${result.competitor_id}.site_checks`,
    );
    expect(checks?.source).toMatchObject({ kind: "web_research" });
    expect(checks?.value?.results["events"]).toBe("https://rival.example/");
    expect(checks?.value?.results["booking"]).toBe("https://rival.example/");
    expect(checks?.value?.results["prices"]).toBe("https://rival.example/");
    expect(checks?.value?.results["parking"]).toBeUndefined(); // not on a bar's list
    expect(checks?.value?.results["reviews"]).toBeNull();
  });

  it("hours a competitor doesn't state are unknown, and nothing is parsed for them", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const result = await research(s.profile_id, s.account_id, null, "Rival Bar. Cocktails.");
    expect(result.unknown).toContain("opening_hours");
    let calls = 0;
    const llm: ScheduleLlm = async () => {
      calls++;
      return { text: scheduleText("18:00"), calls: [] };
    };
    expect(await parseCompetitorHours(s.profile_id, llm)).toEqual({ parsed: 0, reused: 0 });
    expect(calls).toBe(0);
  });
});

describe("P2-31 — the background check", () => {
  it("parses each competitor's hours once, then counts who opens before the owner", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    for (const open of ["18:00", "19:00", "21:00"]) {
      await research(s.profile_id, s.account_id, `Fri from ${open}`, "Rival Bar");
    }
    const opens = ["18:00", "19:00", "21:00"];
    let calls = 0;
    const llm: ScheduleLlm = async () => ({
      text: scheduleText(opens[calls++] as string),
      calls: [],
    });
    expect(await parseCompetitorHours(s.profile_id, llm)).toEqual({ parsed: 3, reused: 0 });
    expect(await parseCompetitorHours(s.profile_id, llm)).toEqual({ parsed: 0, reused: 3 });
    expect(calls).toBe(3);

    const openings = await competitorOpenings(s.profile_id);
    expect(openings.get("fri")).toEqual({ known: 3, opens: [18, 19, 21], closed: 0 });
    expect(openings.get("mon")).toEqual({ known: 3, opens: [], closed: 3 });
    expect(openings.get("tue")).toBeUndefined(); // unstated, not closed

    expect(competitorLine(openings.get("fri"), 20)).toBe(
      "2 of the 3 competitor(s) whose hours we found open before you (20:00), the earliest at 18:00, from their own pages",
    );
    expect(competitorLine(openings.get("tue"), 20)).toBeNull();
  });
});

// GET /api/page-setup through the real door (only next/headers' cookie jar is
// stood in). What must hold: a business gets its own kit and the platforms'
// own links; nobody without a business gets anything; and the route is the
// same whether or not anything was ever paid.

import "dotenv/config";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "../../../db";
import { accounts, businessProfiles, fieldRecords, intakeEvents } from "../../../db/schema";
import { INTAKE_COOKIE, signProfileCookie } from "../../../lib/auth/access";
import { confidence } from "../../../lib/core/confidence";
import { createField } from "../../../lib/core/field";
import { fieldId } from "../../../lib/core/ids";
import { isoDateTime } from "../../../lib/core/iso";
import { bootstrapIntake } from "../../../lib/intake/service";
import type { PageKit } from "../../../lib/pages/kit";
import { writeField } from "../../../lib/profile/field-store";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) as string } : undefined),
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    has: (name: string) => jar.has(name),
    set: () => undefined,
    delete: () => undefined,
  }),
  headers: async () => new Headers(),
}));

const { GET } = await import("./route");

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  for (const s of created) {
    await db.delete(intakeEvents).where(eq(intakeEvents.profile_id, s.profile_id));
    await db.delete(fieldRecords).where(eq(fieldRecords.profile_id, s.profile_id));
    await db.delete(businessProfiles).where(eq(businessProfiles.id, s.profile_id));
    await db.delete(accounts).where(eq(accounts.id, s.account_id));
  }
});

async function answer(profileId: string, key: string, value: unknown) {
  const at = isoDateTime(new Date().toISOString());
  await writeField(
    profileId,
    createField<unknown>({
      id: fieldId(key),
      value,
      status: "answered",
      confidence: confidence(0.75),
      source: { kind: "owner_input" },
      observed_at: at,
      recorded_at: at,
    }),
  );
}

interface Body {
  kit: PageKit;
  connected: { page: boolean; instagram: boolean };
  links: Record<string, string>;
}

describe("GET /api/page-setup", () => {
  it("gives a business its own kit, what is connected, and the platforms' own guides", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    await answer(s.profile_id, "identity.legal_name", "Kézműves Kerámia Műhely");
    await answer(
      s.profile_id,
      "identity.description",
      "Kézzel korongozott kerámiákat készítünk rendelésre.",
    );
    jar.clear();
    jar.set(INTAKE_COOKIE, signProfileCookie(s.profile_id));

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.kit.name).toEqual({
      value: "Kézműves Kerámia Műhely",
      source_field: "identity.legal_name",
    });
    expect(body.kit.username?.value).toBe("kezmuves.keramia.muhely");
    expect(body.kit.short_line?.value).toBe("Kézzel korongozott kerámiákat készítünk rendelésre.");
    // The business type was never answered: a gap with its question, not a guess.
    expect(body.kit.category_hint).toBeNull();
    expect(body.kit.gaps).toEqual([
      { key: "business_type", field: "identity.business_type", question: "1.2" },
    ]);
    expect(body.connected).toEqual({ page: false, instagram: false });
    expect(Object.keys(body.links).sort()).toEqual(["facebook_guide", "instagram_guide"]);
    for (const url of Object.values(body.links)) {
      expect(new URL(url).hostname).toMatch(/(^|\.)(facebook|instagram)\.com$/);
    }
  });

  it("gives nothing to a caller with no business", async () => {
    jar.clear();
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "no intake session" });
  });

  it("shows another business's kit to nobody: the cookie names the business", async () => {
    const mine = await bootstrapIntake();
    const theirs = await bootstrapIntake();
    created.push(mine, theirs);
    await answer(theirs.profile_id, "identity.legal_name", "Somebody Else's Bakery");
    jar.clear();
    jar.set(INTAKE_COOKIE, signProfileCookie(mine.profile_id));
    const body = (await (await GET()).json()) as Body;
    expect(body.kit.name).toBeNull();
    expect(JSON.stringify(body)).not.toContain("Somebody Else");
  });
});

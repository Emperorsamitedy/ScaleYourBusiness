// P3-50 — niche research, end to end against the recorded-shape fake.
// What must hold: no token → the screen says what's missing and nothing is
// asked; outside the EU/UK → a sentence, no read; a read searches the
// profile's own terms and listed competitors, keeps only the business's own
// page for a name search, stores no token and nothing beyond the minimised
// ads, stays inside its request cap, and is reused rather than re-read; a
// failure is stored with its reason and shown.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { db } from "../../db";
import {
  accounts,
  businessProfiles,
  competitors,
  fieldRecords,
  intakeEvents,
  nicheAdReads,
  offers,
} from "../../db/schema";
import { addCompetitor } from "../competitors/service";
import { confidence } from "../core/confidence";
import { createField } from "../core/field";
import { fieldId } from "../core/ids";
import { isoDateTime } from "../core/iso";
import { bootstrapIntake } from "../intake/service";
import { writeField } from "../profile/field-store";
import { AD_LIBRARY_CAPS } from "./ad-library";
import type { FakeLibraryAd } from "./ad-library-fake";
import {
  FAKE_AD_LIBRARY_TOKEN,
  ceramicsNiche,
  fakeAdLibrary,
  libraryError,
} from "./ad-library-fake";
import {
  NOT_SET_UP,
  adsOf,
  cleanTerm,
  derivedTerms,
  facebookPageId,
  nicheView,
  readNicheAds,
  sameBusiness,
} from "./niche";

const created: { account_id: string; profile_id: string }[] = [];
const NOW = new Date("2026-10-26T10:00:00Z");
const TODAY = "2026-10-26";

async function owner(profileId: string, key: string, value: unknown) {
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

async function business(country = "Ireland") {
  const s = await bootstrapIntake();
  created.push(s);
  await owner(s.profile_id, "legal.country", country);
  await owner(s.profile_id, "identity.business_type", "ecommerce_store");
  const [offer] = await db
    .insert(offers)
    .values({ profile_id: s.profile_id, kind: "physical" })
    .returning({ id: offers.id });
  await owner(s.profile_id, `offers.${offer!.id}.name`, "Speckled Everyday Mug");
  await owner(s.profile_id, `offers.${offer!.id}.volume_period`, 120);
  const saltmarsh = await addCompetitor(s.profile_id, {
    name: "Saltmarsh Pottery",
    url: "https://saltmarsh-pottery.example",
  });
  const wheelhouse = await addCompetitor(s.profile_id, {
    name: "The Wheelhouse Ceramics",
    listing_url: "https://www.facebook.com/profile.php?id=5550003",
  });
  return { ...s, saltmarsh, wheelhouse };
}

/** The niche, plus a page that only MENTIONS a competitor's name. */
function niche(): FakeLibraryAd[] {
  return [
    ...ceramicsNiche(TODAY),
    {
      id: "910000000000099",
      page_id: "5559999",
      page_name: "Copycat Clay",
      bodies: ["Fans of Saltmarsh Pottery will love our bowls."],
      start: "2026-09-01",
      media: "IMAGE",
      countries: ["IE"],
    },
  ];
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  const ids = created.map((s) => s.profile_id);
  if (ids.length > 0) {
    await db.delete(nicheAdReads).where(inArray(nicheAdReads.profile_id, ids));
    await db.delete(competitors).where(inArray(competitors.profile_id, ids));
    await db.delete(offers).where(inArray(offers.profile_id, ids));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
  }
  for (const s of created) await db.delete(accounts).where(eq(accounts.id, s.account_id));
});

describe("P3-50 — the pure pieces", () => {
  it("finds a page id in a Facebook link, and nothing in anything else", () => {
    expect(facebookPageId("https://www.facebook.com/profile.php?id=5550003")).toBe("5550003");
    expect(facebookPageId("https://facebook.com/Saltmarsh-Pottery-102938475610")).toBe(
      "102938475610",
    );
    expect(facebookPageId("https://facebook.com/saltmarshpottery")).toBeNull();
    expect(facebookPageId("https://saltmarsh-pottery.example/?id=5550003")).toBeNull();
    expect(facebookPageId(null)).toBeNull();
  });

  it("derives terms from the niche word and the strongest offers, skipping generic endings", () => {
    expect(derivedTerms("ecommerce_store", ["Speckled Everyday Mug", "Pour-over Set"])).toEqual([
      "mug",
    ]);
    expect(derivedTerms("salon_beauty", ["Balayage"])).toEqual(["beauty salon", "balayage"]);
    expect(derivedTerms(null, [])).toEqual([]);
  });

  it("cleans an owner's term, and matches business names loosely", () => {
    expect(cleanTerm("  hand  thrown\nmugs ")).toBe("hand thrown mugs");
    expect(cleanTerm("x")).toBeNull();
    expect(cleanTerm(42)).toBeNull();
    expect(sameBusiness("Saltmarsh Pottery Ltd", "saltmarsh pottery")).toBe(true);
    expect(sameBusiness("Copycat Clay", "Saltmarsh Pottery")).toBe(false);
  });
});

describe("P3-50 — the read", () => {
  it("without a token, says what is missing and asks nothing", async () => {
    const b = await business();
    const fake = fakeAdLibrary({ ads: niche() });
    const out = await readNicheAds({
      profileId: b.profile_id,
      accountId: b.account_id,
      token: null,
      fetch: fake.fetch,
      now: NOW,
    });
    expect(out).toEqual({ status: "not_set_up", why: NOT_SET_UP });
    expect(fake.calls).toHaveLength(0);
    vi.stubEnv("META_AD_LIBRARY_TOKEN", "");
    const view = await nicheView(b.profile_id, NOW);
    expect(view.set_up).toBe(false);
    expect(view.blocked).toBe(NOT_SET_UP);
    expect(view.groups).toEqual([]);
  });

  it("outside the EU and UK, says the Library holds only political ads there, and reads nothing", async () => {
    const b = await business("United States");
    const fake = fakeAdLibrary({ ads: niche() });
    const out = await readNicheAds({
      profileId: b.profile_id,
      accountId: b.account_id,
      token: FAKE_AD_LIBRARY_TOKEN,
      fetch: fake.fetch,
      now: NOW,
    });
    expect(out.status).toBe("outside_coverage");
    if (out.status === "outside_coverage") {
      expect(out.country).toBe("US");
      expect(out.why).toMatch(/political and issue ads only/);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("reads the niche and the listed competitors, minimised, inside the cap", async () => {
    const b = await business();
    const fake = fakeAdLibrary({ ads: niche() });
    const out = await readNicheAds({
      profileId: b.profile_id,
      accountId: b.account_id,
      token: FAKE_AD_LIBRARY_TOKEN,
      fetch: fake.fetch,
      now: NOW,
    });
    expect(out.status).toBe("read");
    if (out.status !== "read") return;
    expect(out.fresh).toBe(true);
    expect(out.read.terms).toEqual(["mug"]);
    expect(out.read.country).toBe("IE");
    expect(out.read.requests).toBe(fake.calls.length);
    expect(out.read.requests).toBeLessThanOrEqual(AD_LIBRARY_CAPS.max_requests_per_read);
    // Every request is GET with the token in a header, for IE only.
    for (const call of fake.calls) {
      expect(call.init.method).toBe("GET");
      expect(call.url.href).not.toContain(FAKE_AD_LIBRARY_TOKEN);
    }
    const asked = fake.calls.filter((c) => c.url.pathname.endsWith("/ads_archive"));
    expect(new Set(asked.map((c) => c.url.searchParams.get("ad_reached_countries")))).toEqual(
      new Set(['["IE"]']),
    );
    expect(asked.some((c) => c.url.searchParams.get("search_page_ids") === '["5550003"]')).toBe(
      true,
    );
    expect(
      asked.some(
        (c) =>
          c.url.searchParams.get("search_terms") === "Saltmarsh Pottery" &&
          c.url.searchParams.get("search_type") === "KEYWORD_EXACT_PHRASE",
      ),
    ).toBe(true);

    const ads = adsOf(out.read);
    const ids = ads.map((a) => a.id);
    expect(ids).not.toContain("910000000000009"); // the US-only ad
    expect(ids).not.toContain("910000000000099"); // only MENTIONS a competitor
    const salt = ads.find((a) => a.id === "910000000000001")!;
    expect(salt.found_by).toEqual({ kind: "competitor", competitor_id: b.saltmarsh });
    expect(salt.format).toBe("video");
    const wheel = ads.find((a) => a.id === "910000000000005")!;
    expect(wheel.found_by).toEqual({ kind: "competitor", competitor_id: b.wheelhouse });
    expect(ads.find((a) => a.id === "910000000000008")?.found_by).toEqual({
      kind: "term",
      term: "mug",
    });

    // Nothing beyond the minimised ad: no token, no snapshot, no targeting.
    const [stored] = await db.select().from(nicheAdReads).where(eq(nicheAdReads.id, out.read.id));
    const json = JSON.stringify(stored);
    expect(json).not.toContain(FAKE_AD_LIBRARY_TOKEN);
    expect(json).not.toMatch(/snapshot|target_|spend|impressions/);
    expect(Object.keys(ads[0]!).sort()).toEqual(
      [
        "body",
        "bodies",
        "format",
        "found_by",
        "id",
        "page_id",
        "page_name",
        "platforms",
        "started",
        "stopped",
        "title",
        "titles",
      ].sort(),
    );

    // The screen: ranked concepts, competitors named, the caveats every time.
    vi.stubEnv("META_AD_LIBRARY_TOKEN", FAKE_AD_LIBRARY_TOKEN);
    const view = await nicheView(b.profile_id, NOW);
    expect(view.set_up).toBe(true);
    expect(view.blocked).toBeNull();
    expect(view.groups[0]!.page_name).toBe("Saltmarsh Pottery");
    expect(view.groups[0]!.competitor_id).toBe(b.saltmarsh);
    expect(view.caveats[0]).toMatch(/no results for ordinary business ads/);
    expect(view.last_read?.ads_read).toBe(ads.length);
    expect(view.competitors).toEqual([
      { id: b.saltmarsh, name: "Saltmarsh Pottery", by: "name" },
      { id: b.wheelhouse, name: "The Wheelhouse Ceramics", by: "page_id" },
    ]);
  });

  it("reuses a fresh read instead of asking again, and allows a new one once a day", async () => {
    const b = await business();
    const fake = fakeAdLibrary({ ads: niche() });
    const base = {
      profileId: b.profile_id,
      accountId: b.account_id,
      token: FAKE_AD_LIBRARY_TOKEN,
      fetch: fake.fetch,
    };
    const first = await readNicheAds({ ...base, now: NOW });
    const n = fake.calls.length;
    const again = await readNicheAds({ ...base, now: new Date(NOW.getTime() + 3_600_000) });
    expect(again.status).toBe("read");
    if (again.status === "read" && first.status === "read") {
      expect(again.fresh).toBe(false);
      expect(again.read.id).toBe(first.read.id);
    }
    expect(fake.calls.length).toBe(n);

    // The owner's own words, an hour later: refused for a day.
    const typed = await readNicheAds({
      ...base,
      terms: ["pottery class"],
      now: new Date(NOW.getTime() + 3_600_000),
    });
    expect(typed.status).toBe("cooldown");
    expect(fake.calls.length).toBe(n);

    // A day later: read, and the owner's terms stick for the next plan.
    const later = await readNicheAds({
      ...base,
      terms: ["pottery class"],
      now: new Date(NOW.getTime() + 25 * 3_600_000),
    });
    expect(later.status).toBe("read");
    if (later.status === "read") expect(later.read.terms).toEqual(["pottery class"]);
    vi.stubEnv("META_AD_LIBRARY_TOKEN", FAKE_AD_LIBRARY_TOKEN);
    const view = await nicheView(b.profile_id, NOW);
    expect(view.plan_terms).toEqual(["pottery class"]);
    expect(view.terms_from).toBe("owner");
  });

  it("stores a failure with its reason, shows it, and makes no further requests", async () => {
    const b = await business();
    const fake = fakeAdLibrary({
      ads: niche(),
      respond: (call) =>
        call.url.pathname.endsWith("/ads_archive") ? libraryError(10, "No permission") : null,
    });
    const out = await readNicheAds({
      profileId: b.profile_id,
      accountId: b.account_id,
      token: FAKE_AD_LIBRARY_TOKEN,
      fetch: fake.fetch,
      now: NOW,
    });
    expect(out.status).toBe("failed");
    if (out.status === "failed") expect(out.why).toMatch(/confirmed its identity/);
    expect(fake.calls).toHaveLength(2); // the permission check, then the first search
    vi.stubEnv("META_AD_LIBRARY_TOKEN", FAKE_AD_LIBRARY_TOKEN);
    const view = await nicheView(b.profile_id, NOW);
    expect(view.last_read).toBeNull();
    expect(view.last_failure?.reason).toMatch(/confirmed its identity/);
  });
});

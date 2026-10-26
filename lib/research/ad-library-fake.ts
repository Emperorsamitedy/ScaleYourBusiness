// A recorded-shape Meta Ad Library, for tests and the local demo seed only
// (P3-50). It answers the two GET paths the reader calls — /me/permissions
// and /ads_archive — with bearer-token auth, Graph-style error bodies, and
// the filters the reader sends (countries, media type, terms, page ids,
// delivery date, limit). The fixture ads are fictional Irish ceramics
// businesses; nothing here is a real advertiser. No network, ever.

import type { AdLibraryFetch, AdLibraryRequestInit, AdLibraryResponse } from "./ad-library";

export const FAKE_AD_LIBRARY_TOKEN = "EAAFakeAdLibraryUserTokenForTestsOnly";

export interface FakeLibraryAd {
  id: string;
  page_id: string;
  page_name: string;
  bodies: string[];
  titles?: string[];
  /** "YYYY-MM-DD" */
  start: string;
  stop?: string | null;
  platforms?: string[];
  media: "VIDEO" | "IMAGE";
  countries: string[];
}

export interface FakeAdLibraryCall {
  url: URL;
  init: AdLibraryRequestInit;
}

export interface FakeAdLibraryOptions {
  ads?: FakeLibraryAd[];
  permissions?: { permission: string; status: string }[];
  respond?: (call: FakeAdLibraryCall, n: number) => AdLibraryResponse | null;
}

export interface FakeAdLibrary {
  fetch: AdLibraryFetch;
  calls: FakeAdLibraryCall[];
}

export function libraryJson(status: number, body: unknown): AdLibraryResponse {
  return { status, json: async () => body };
}

export function libraryError(code: number, message: string): AdLibraryResponse {
  return libraryJson(400, { error: { message, type: "OAuthException", code } });
}

/** A day `days` before `today` ("YYYY-MM-DD"), for fixtures anchored to the run. */
export function daysBefore(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * The ceramics niche, as of `today`. Saltmarsh Pottery is one of the demo
 * business's listed competitors; the rest are other studios. Two long
 * runners with several near-identical versions, short tests that stopped,
 * video and image, and one ad outside the EU that must never come back.
 */
export function ceramicsNiche(today: string): FakeLibraryAd[] {
  const ago = (n: number) => daysBefore(today, n);
  return [
    {
      id: "910000000000001",
      page_id: "5550001",
      page_name: "Saltmarsh Pottery",
      bodies: [
        "Every mug starts as a lump of clay on our wheel by the sea.\nWatch one take shape, then pick yours from this week's firing. Free EU shipping over €60. Shop now.",
      ],
      titles: ["This week's firing"],
      start: ago(142),
      stop: null,
      platforms: ["facebook", "instagram"],
      media: "VIDEO",
      countries: ["IE", "GB", "FR"],
    },
    {
      id: "910000000000002",
      page_id: "5550001",
      page_name: "Saltmarsh Pottery",
      bodies: [
        "Every mug starts as a lump of clay on our wheel by the sea.\nWatch one take shape, then choose yours from this week's firing. Free EU shipping over €60. Shop now.",
      ],
      titles: ["This week's firing"],
      start: ago(120),
      stop: null,
      platforms: ["instagram"],
      media: "VIDEO",
      countries: ["IE"],
    },
    {
      id: "910000000000003",
      page_id: "5550001",
      page_name: "Saltmarsh Pottery",
      bodies: [
        "Every mug starts as a lump of clay on our wheel by the sea.\nSee it thrown, glazed and fired, then take one home. Free EU shipping over €60. Shop now.",
      ],
      titles: ["Thrown by the sea"],
      start: ago(96),
      stop: null,
      platforms: ["instagram"],
      media: "VIDEO",
      countries: ["IE"],
    },
    {
      id: "910000000000004",
      page_id: "5550002",
      page_name: "Kiln Lane Studio",
      bodies: [
        "Seconds sale: 30% off any mug with a tiny glaze quirk.\nSame clay, same kiln, a little more character. Ends Sunday. Shop the seconds.",
      ],
      titles: ["Seconds: 30% off"],
      start: ago(20),
      stop: ago(13),
      platforms: ["facebook"],
      media: "IMAGE",
      countries: ["IE"],
    },
    {
      id: "910000000000005",
      page_id: "5550003",
      page_name: "The Wheelhouse Ceramics",
      bodies: [
        "Your coffee deserves a mug someone actually made.\nHand-thrown in Galway, glazed in small batches, signed on the base. Order yours today.",
      ],
      titles: ["Hand-thrown in Galway", "Signed on the base", "Small-batch glazes"],
      start: ago(88),
      stop: null,
      platforms: ["facebook", "instagram"],
      media: "IMAGE",
      countries: ["IE"],
    },
    {
      id: "910000000000006",
      page_id: "5550003",
      page_name: "The Wheelhouse Ceramics",
      bodies: [
        "Pottery class gift vouchers from €45.\nTwo hours at the wheel, your own pot fired and posted. Book now.",
      ],
      titles: ["Gift a pottery class"],
      start: ago(40),
      stop: ago(25),
      platforms: ["facebook"],
      media: "IMAGE",
      countries: ["IE"],
    },
    {
      id: "910000000000007",
      page_id: "5550004",
      page_name: "Little Furnace Pottery",
      bodies: [
        "POV: you open the kiln after 12 hours and not one mug cracked.\nThe speckled set is back. Learn more.",
      ],
      titles: ["The speckled set is back"],
      start: ago(64),
      stop: null,
      platforms: ["instagram"],
      media: "VIDEO",
      countries: ["IE", "GB"],
    },
    {
      id: "910000000000008",
      page_id: "5550005",
      page_name: "Hollow Oak Homeware",
      bodies: ["Handmade-look mug sets, 4 for €40. Buy now while stocks last."],
      titles: ["4 mugs for €40"],
      start: ago(10),
      stop: ago(3),
      platforms: ["facebook"],
      media: "IMAGE",
      countries: ["IE"],
    },
    {
      id: "910000000000009",
      page_id: "5550006",
      page_name: "Prairie Clay Co",
      bodies: ["Handmade mugs from Montana. Shop now."],
      titles: ["Montana mugs"],
      start: ago(200),
      stop: null,
      platforms: ["facebook"],
      media: "IMAGE",
      // Outside the EU and UK: a query for IE must never return it.
      countries: ["US"],
    },
  ];
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== "");
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function fakeAdLibrary(options: FakeAdLibraryOptions = {}): FakeAdLibrary {
  const ads = options.ads ?? [];
  const permissions = options.permissions ?? [{ permission: "public_profile", status: "granted" }];
  const calls: FakeAdLibraryCall[] = [];

  const fetch: AdLibraryFetch = async (url, init) => {
    const call: FakeAdLibraryCall = { url: new URL(url), init };
    calls.push(call);
    const forced = options.respond?.(call, calls.length) ?? null;
    if (forced) return forced;
    if (init.headers["authorization"] !== `Bearer ${FAKE_AD_LIBRARY_TOKEN}`) {
      return libraryError(190, "Invalid OAuth access token.");
    }
    const path = call.url.pathname;
    if (path.endsWith("/me/permissions")) {
      return libraryJson(200, { data: permissions });
    }
    if (!path.endsWith("/ads_archive")) return libraryError(100, "Unknown path");

    const q = call.url.searchParams;
    const countries = parseList(q.get("ad_reached_countries"));
    if (countries.length === 0) return libraryError(100, "ad_reached_countries is required");
    const media = q.get("media_type");
    const since = q.get("ad_delivery_date_min") ?? "0000-00-00";
    const pageIds = parseList(q.get("search_page_ids"));
    const term = q.get("search_terms");
    const exact = q.get("search_type") === "KEYWORD_EXACT_PHRASE";
    const limit = Number(q.get("limit") ?? "25");

    const matches = ads.filter((ad) => {
      if (!ad.countries.some((c) => countries.includes(c))) return false;
      if (media && media !== "ALL" && ad.media !== media) return false;
      if ((ad.stop ?? "9999-12-31") < since) return false;
      if (pageIds.length > 0) return pageIds.includes(ad.page_id);
      if (term) {
        const haystack = [...ad.bodies, ...(ad.titles ?? []), ad.page_name].join(" \n ");
        if (exact) return haystack.toLowerCase().includes(term.toLowerCase());
        const have = new Set(words(haystack));
        return words(term).every((w) => have.has(w));
      }
      return true;
    });

    return libraryJson(200, {
      data: matches.slice(0, limit).map((ad) => ({
        id: ad.id,
        page_id: ad.page_id,
        page_name: ad.page_name,
        ad_creative_bodies: ad.bodies,
        ad_creative_link_titles: ad.titles ?? [],
        ad_delivery_start_time: ad.start,
        ...(ad.stop ? { ad_delivery_stop_time: ad.stop } : {}),
        publisher_platforms: (ad.platforms ?? ["facebook"]).map((p) => p.toUpperCase()),
      })),
    });
  };

  return { fetch, calls };
}

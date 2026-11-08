// TikTok's permission scope ids, named — TikTok Ads (specs/tiktok-ads-api-v1.md).
//
// TikTok reports a token's permissions as numbers (`scope: [4]`), at three
// levels, where a first-level id grants everything under it. The execution
// registry names its scopes as words (lib/execution/scopes.ts), so the
// registry's audit can read them: this table turns each id TikTok listed on
// its "Permission scope" page (read 2026-11-08) into SYB's registry name.
// An id SYB doesn't know becomes `tiktok.scope_<id>` — never dropped, so
// the exact-match check (P3-20b) refuses it by name.
//
// Pure: no database, no network.

/** The ids SYB names, TikTok's permission name beside each. */
export const TIKTOK_SCOPE_NAMES: Readonly<Record<number, string>> = {
  // First level — each grants every endpoint under it, writes included.
  1: "tiktok.ad_account_management",
  2: "tiktok.ads_management",
  3: "tiktok.audience_management",
  4: "tiktok.reporting",
  5: "tiktok.measurement",
  6: "tiktok.creative_management",
  // Second level.
  10: "tiktok.ad_account_information",
  20: "tiktok.campaign",
  44: "tiktok.consolidated_report",
  // Third level.
  100: "tiktok.read_ad_account_information",
  200: "tiktok.read_campaigns",
  201: "tiktok.create_and_update_campaigns",
};

/** The registry name for one TikTok scope id. */
export function tiktokScopeName(id: number): string {
  return TIKTOK_SCOPE_NAMES[id] ?? `tiktok.scope_${BigInt(id).toString()}`;
}

/** The registry names for a token's `scope` list, sorted and distinct. Non-integers are refused. */
export function tiktokScopeNames(ids: readonly unknown[]): string[] {
  const names = new Set<string>();
  for (const id of ids) {
    // TikTok's newer ids pass 2^53 (7043626160646946818), so JSON gives them
    // back rounded: still integers, still named, and still refused unless asked for.
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0) {
      throw new TypeError(`TikTok reported a permission scope that isn't a number: ${String(id)}`);
    }
    names.add(tiktokScopeName(id));
  }
  return [...names].sort();
}

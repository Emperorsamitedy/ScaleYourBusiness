// TikTok Ads — TikTok's numeric scope ids named, and matched EXACTLY against
// the execution registry (P3-20b): one more or fewer is refused by name. And
// the measurement registry stays read-only (rule 9): TikTok is not in it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCOPE_REGISTRY, auditRegistry } from "../connectors/scopes";
import { EXECUTION_SCOPE_REGISTRY, auditExecutionRegistry } from "../execution/scopes";
import { expectedExecutionScopes, verifyExecutionScopes } from "../execution/verify";
import { tiktokScopeName, tiktokScopeNames } from "./scopes";
import { TIKTOK_REASONS, TIKTOK_GENERIC } from "./reasons";
import en from "../../messages/en.json";

describe("TikTok Ads — scope ids, named", () => {
  it("names the four SYB asks for, exactly as the registry holds them", () => {
    expect(tiktokScopeNames([201, 100, 44, 200])).toEqual(
      [...expectedExecutionScopes("tiktok_ads")].sort(),
    );
    expect(() =>
      verifyExecutionScopes("tiktok_ads", tiktokScopeNames([100, 200, 201, 44])),
    ).not.toThrow();
  });

  it("refuses one more (a first-level grant that includes everything) and one fewer, by name", () => {
    expect(() =>
      verifyExecutionScopes("tiktok_ads", tiktokScopeNames([100, 200, 201, 44, 2])),
    ).toThrow(/tiktok\.ads_management/);
    expect(() => verifyExecutionScopes("tiktok_ads", tiktokScopeNames([100, 200, 44]))).toThrow(
      /tiktok\.create_and_update_campaigns/,
    );
  });

  it("keeps an unknown id visible, so it is refused rather than dropped", () => {
    expect(tiktokScopeName(12000000)).toBe("tiktok.scope_12000000");
    // Past 2^53 JSON rounds it, but it is still named, and still refused.
    const big = JSON.parse("7043626160646946818") as number;
    expect(tiktokScopeName(big)).toMatch(/^tiktok\.scope_70436261606469/);
    expect(() =>
      verifyExecutionScopes("tiktok_ads", tiktokScopeNames([100, 200, 201, 44, big])),
    ).toThrow(/tiktok\.scope_70436261606469/);
    expect(() => tiktokScopeNames(["4"])).toThrow(TypeError);
  });

  it("rule 9 holds: TikTok is not a measurement provider, and both audits stay clean", () => {
    expect(Object.keys(SCOPE_REGISTRY)).not.toContain("tiktok_ads");
    expect(auditRegistry()).toEqual([]);
    expect(auditExecutionRegistry()).toEqual([]);
    expect(EXECUTION_SCOPE_REGISTRY.tiktok_ads.operations.every((o) => o.reversible)).toBe(true);
    // No create and no delete op: TikTok's DELETE is permanent.
    expect(EXECUTION_SCOPE_REGISTRY.tiktok_ads.operations.map((o) => o.op)).toEqual([
      "pause_campaign",
      "resume_campaign",
      "set_daily_budget",
    ]);
  });
});

describe("TikTok Ads — the reasons the screen reads, one English", () => {
  it("the catalogue's English is the code's, byte for byte", () => {
    const cat = (
      en as unknown as { connections: { tiktokAds: { reason: Record<string, string> } } }
    ).connections.tiktokAds.reason;
    expect({ ...cat }).toEqual({ ...TIKTOK_REASONS, generic: TIKTOK_GENERIC });
  });

  it("the spec is in CLAUDE.md's table", () => {
    expect(readFileSync(join(process.cwd(), "CLAUDE.md"), "utf8")).toContain(
      "specs/tiktok-ads-api-v1.md",
    );
  });
});

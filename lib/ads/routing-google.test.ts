// Building and launching ads exists on Meta only: a Google proposal naming
// run_ad, go_live or create_paused is refused, never routed to Meta.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { adsPlan } from "./executing";

const plan = (change: string, platform?: string) =>
  adsPlan({
    module: "ads",
    action: {
      kind: "paid_ads_start_or_increase",
      summary: "s",
      detail: {
        change,
        ...(platform ? { platform } : {}),
        campaign_ref: "120000001",
        adset_id: "120000002",
        ad_id: "120000003",
        ad: { name: "x" },
      },
    },
  } as never);

describe("Meta-only ad changes", () => {
  it("refuses run_ad, go_live and create_paused for a Google proposal", () => {
    for (const change of ["run_ad", "go_live", "create_paused"]) {
      expect(plan(change, "google")).toEqual({
        unroutable: `"${change}" runs on Meta only, not on Google Ads`,
      });
    }
  });

  it("still routes them to Meta when the proposal is Meta's", () => {
    for (const change of ["run_ad", "go_live", "create_paused"]) {
      const r = plan(change);
      expect("plan" in r && r.plan.provider).toBe("meta_ads");
    }
  });
});

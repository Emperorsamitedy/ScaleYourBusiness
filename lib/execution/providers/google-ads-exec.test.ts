// P3-22, Google half — the Google Ads executor against the recorded-shape
// fake and an in-memory backend. No network, no database.
//
//   · pause/resume: a dry run (validateOnly) first, then the change; the
//     emergency stop between the two sends nothing real
//   · budgets: ±50% of the budget captured before attempt one, the owner's
//     monthly ceiling, shared or non-daily budgets refused by name
//   · undo: restores the previous status/budget, only while the live value is
//     still what SYB set; undoRaisesSpend tells the engine's gate
//   · the write fence: two mutate endpoints, one field each (rule 18)

import "dotenv/config";
import { describe, expect, it, vi } from "vitest";
import { touchesMoneySurface } from "../scopes";
import { fakeGoogleAds, type FakeCampaign } from "../../google-ads/fake";
import type { GoogleAdsBackend } from "./google-ads";
import {
  GADS_MUTATE_ENDPOINTS,
  STOPPED_BEFORE_GOOGLE_CHANGE,
  allowedMutateEndpoint,
  createGoogleAdsExecution,
  googleAdsExecutor,
} from "./google-ads";
import { executionProvider } from "./index";

vi.spyOn(console, "log").mockImplementation(() => undefined);

const CTX = { profile_id: "p", account_id: "a" };

function setup(
  campaign: Partial<FakeCampaign> = {},
  backend: Partial<GoogleAdsBackend> = {},
  fakeOpts: Parameters<typeof fakeGoogleAds>[0] = {},
) {
  const fake = fakeGoogleAds({
    campaigns: [
      {
        id: "111",
        name: "Spring sale",
        status: "ENABLED",
        budget_id: "9",
        amount_micros: 20_000_000,
        ...campaign,
      },
    ],
    ...fakeOpts,
  });
  let undo: unknown = null;
  const lines: string[] = [];
  const b: GoogleAdsBackend = {
    credential: async () => ({
      access_token: "ya29.x",
      customer_id: "1234567890",
      headers: { developer_token: null, login_customer_id: null },
    }),
    capturedUndo: async () => undo,
    ceiling: async () => null,
    accountDailySpend: async () => null,
    changed: async (_p, detail) => {
      lines.push(detail);
    },
    ...backend,
  };
  const exec = createGoogleAdsExecution({ fetch: fake.fetch, backend: async () => b });
  const mutates = () => fake.calls.filter((c) => c.url.endsWith(":mutate"));
  return { fake, exec, lines, mutates, setUndo: (u: unknown) => (undo = u) };
}

describe("P3-22 — the Google Ads executor is registered, external, and fenced", () => {
  it("resolves through the provider map and is held to the real-write gate", () => {
    expect(executionProvider("google_ads")).toBe(googleAdsExecutor);
    expect(googleAdsExecutor.external).toBe(true);
  });

  it("the write fence: two mutate endpoints, one field each, nothing touching money (rule 18)", () => {
    expect(Object.keys(GADS_MUTATE_ENDPOINTS).sort()).toEqual(["campaignBudgets", "campaigns"]);
    expect(Object.values(GADS_MUTATE_ENDPOINTS).map((e) => e.field)).toEqual([
      "status",
      "amountMicros",
    ]);
    for (const [id, e] of Object.entries(GADS_MUTATE_ENDPOINTS)) {
      expect(touchesMoneySurface(id), id).toBe(false);
      expect(touchesMoneySurface(e.field), e.field).toBe(false);
    }
    const base = "https://googleads.googleapis.com/v26/customers/1234567890";
    expect(allowedMutateEndpoint(`${base}/campaigns:mutate`)).toBe("campaigns");
    expect(allowedMutateEndpoint(`${base}/campaignBudgets:mutate`)).toBe("campaignBudgets");
    for (const path of ["billingSetups:mutate", "accountBudgetProposals:mutate", "ads:mutate"]) {
      expect(allowedMutateEndpoint(`${base}/${path}`), path).toBeNull();
    }
    expect(allowedMutateEndpoint(`${base}/campaigns:mutate?x=1`)).toBeNull();
    expect(allowedMutateEndpoint("https://evil.example/v26/customers/1234567890/campaigns:mutate")).toBeNull();
  });

  it("refuses an op the registry doesn't hold", async () => {
    const { exec } = setup();
    expect(await exec.preflight?.("create_campaign_paused", {}, CTX)).toMatchObject({ code: "refused" });
    expect(await exec.captureUndo("remove_campaign", {}, CTX)).toBeNull();
    await expect(exec.execute("remove_campaign", {}, CTX)).rejects.toThrow(/not a change SYB makes/);
  });
});

describe("P3-22 — pause and resume", () => {
  it("pauses with a dry run first, then the change, and records the watch line", async () => {
    const { exec, fake, mutates, lines } = setup();
    expect(await exec.preflight?.("pause_campaign", { campaign_id: "111" }, CTX)).toBeNull();
    const undo = await exec.captureUndo("pause_campaign", { campaign_id: "111" }, CTX);
    expect(undo).toEqual({ campaign_id: "111", campaign_name: "Spring sale", status: "ENABLED" });
    const result = await exec.execute("pause_campaign", { campaign_id: "111" }, CTX);
    expect(result).toMatchObject({ status: "PAUSED", previous_status: "ENABLED" });
    const [dry, real] = mutates();
    expect(dry?.body).toEqual({
      operations: [
        { updateMask: "status", update: { resourceName: "customers/1234567890/campaigns/111", status: "PAUSED" } },
      ],
      validateOnly: true,
    });
    expect(real?.body).toEqual({
      operations: [
        { updateMask: "status", update: { resourceName: "customers/1234567890/campaigns/111", status: "PAUSED" } },
      ],
    });
    expect(fake.campaigns.get("111")?.status).toBe("PAUSED");
    expect(lines).toEqual(['Paused "Spring sale" on Google Ads.']);
  });

  it("THE STOP: the emergency stop between the dry run and the change sends nothing real", async () => {
    const { exec, fake, mutates } = setup();
    await expect(
      exec.execute("pause_campaign", { campaign_id: "111" }, { ...CTX, halted: async () => true }),
    ).rejects.toThrow(STOPPED_BEFORE_GOOGLE_CHANGE);
    expect(mutates().map((c) => (c.body as { validateOnly?: boolean }).validateOnly)).toEqual([true]);
    expect(fake.campaigns.get("111")?.status).toBe("ENABLED");
  });

  it("refuses a removed campaign and one outside the connected account", async () => {
    const removed = setup({ status: "REMOVED" });
    await expect(removed.exec.execute("pause_campaign", { campaign_id: "111" }, CTX)).rejects.toThrow(
      /removed on Google Ads/,
    );
    const { exec } = setup();
    await expect(exec.execute("pause_campaign", { campaign_id: "999" }, CTX)).rejects.toThrow(
      /isn't in the connected Google Ads account/,
    );
    expect(removed.mutates()).toEqual([]);
  });

  it("a resume that would take spend past the stated ceiling is refused", async () => {
    const { exec, mutates } = setup(
      { status: "PAUSED", amount_micros: 50_000_000 },
      {
        ceiling: async () => ({ amount_minor: 100_000, currency: "EUR" }),
        accountDailySpend: async () => 3_000,
      },
    );
    // (30 + 50) a day × 30 = 2 400 € > 1 000 €
    await expect(exec.execute("resume_campaign", { campaign_id: "111" }, CTX)).rejects.toThrow(
      /over your stated ceiling/,
    );
    expect(mutates()).toEqual([]);
  });

  it("undo restores the previous status, and refuses when the owner changed it since", async () => {
    const { exec, fake } = setup({ status: "PAUSED" });
    const undo = { campaign_id: "111", campaign_name: "Spring sale", status: "ENABLED" };
    await exec.undo("pause_campaign", undo, { ...CTX, result: { status: "PAUSED" } });
    expect(fake.campaigns.get("111")?.status).toBe("ENABLED");

    const moved = setup({ status: "REMOVED" });
    await expect(
      moved.exec.undo("pause_campaign", undo, { ...CTX, result: { status: "PAUSED" } }),
    ).rejects.toThrow(/removed/);
    // SYB resumed it; the owner paused it again since: already as it was, nothing sent.
    const owner = setup({ status: "PAUSED" });
    await expect(
      owner.exec.undo(
        "resume_campaign",
        { campaign_id: "111", status: "PAUSED" },
        { ...CTX, result: { status: "ENABLED" } },
      ),
    ).resolves.toMatchObject({ status: "PAUSED" });
    expect(owner.mutates()).toEqual([]);
  });

  it("undoRaisesSpend: undoing a pause spends again; undoing a resume doesn't", () => {
    expect(googleAdsExecutor.undoRaisesSpend?.("pause_campaign", {}, {})).toBe(true);
    expect(googleAdsExecutor.undoRaisesSpend?.("resume_campaign", {}, {})).toBe(false);
    expect(
      googleAdsExecutor.undoRaisesSpend?.(
        "set_daily_budget",
        { amount_micros: 20_000_000 },
        { sent_amount_micros: 24_000_000 },
      ),
    ).toBe(false);
    expect(
      googleAdsExecutor.undoRaisesSpend?.(
        "set_daily_budget",
        { amount_micros: 20_000_000 },
        { sent_amount_micros: 15_000_000 },
      ),
    ).toBe(true);
    expect(googleAdsExecutor.undoRaisesSpend?.("set_daily_budget", {}, {})).toBe(true);
  });
});

describe("P3-22c — budgets, held to ±50% and the ceiling inside the executor", () => {
  const raise = { campaign_id: "111", share: 0.2, currency: "EUR" };

  it("raises from the captured baseline, in micros, through campaignBudgets:mutate", async () => {
    const { exec, fake, mutates, setUndo, lines } = setup();
    const undo = await exec.captureUndo("set_daily_budget", raise, CTX);
    expect(undo).toEqual({
      campaign_id: "111",
      campaign_name: "Spring sale",
      budget_resource: "customers/1234567890/campaignBudgets/9",
      amount_micros: 20_000_000,
      daily_budget_minor: 2000,
      currency: "EUR",
    });
    setUndo(undo);
    const result = await exec.execute("set_daily_budget", raise, { ...CTX, execution_id: "e" });
    expect(result).toMatchObject({ daily_budget_before_minor: 2000, daily_budget_minor: 2400, sent_amount_micros: 24_000_000 });
    expect(mutates()[1]?.body).toEqual({
      operations: [
        {
          updateMask: "amountMicros",
          update: { resourceName: "customers/1234567890/campaignBudgets/9", amountMicros: "24000000" },
        },
      ],
    });
    expect(fake.campaigns.get("111")?.amount_micros).toBe(24_000_000);
    expect(lines[0]).toMatch(/from €20\.00 to €24\.00/);
  });

  it("refuses a change beyond ±50%, at the preflight and in the attempt", async () => {
    const { exec, mutates, setUndo } = setup();
    expect(await exec.preflight?.("set_daily_budget", { ...raise, share: 0.6 }, CTX)).toMatchObject({
      code: "refused",
      message: expect.stringMatching(/60% change is beyond the 50%/),
    });
    setUndo({ daily_budget_minor: 2000, currency: "EUR", budget_resource: "customers/1234567890/campaignBudgets/9" });
    await expect(
      exec.execute("set_daily_budget", { ...raise, share: -0.55 }, { ...CTX, execution_id: "e" }),
    ).rejects.toThrow(/beyond the 50%/);
    expect(mutates()).toEqual([]);
  });

  it("refuses a raise that would pass the owner's monthly ceiling, naming both figures", async () => {
    const { exec, setUndo, mutates } = setup(
      {},
      {
        ceiling: async () => ({ amount_minor: 70_000, currency: "EUR" }),
        accountDailySpend: async () => 2_000,
      },
    );
    setUndo({ daily_budget_minor: 2000, currency: "EUR", budget_resource: "customers/1234567890/campaignBudgets/9" });
    await expect(exec.execute("set_daily_budget", raise, { ...CTX, execution_id: "e" })).rejects.toThrow(
      /about €720\.00, over your stated ceiling of €700\.00/,
    );
    expect(mutates()).toEqual([]);
  });

  it("refuses a ceiling or approval in another currency — never converted (rule 1)", async () => {
    const { exec, setUndo } = setup({}, { ceiling: async () => ({ amount_minor: 1_000_000, currency: "HUF" }) });
    setUndo({ daily_budget_minor: 2000, currency: "EUR", budget_resource: "customers/1234567890/campaignBudgets/9" });
    await expect(exec.execute("set_daily_budget", raise, { ...CTX, execution_id: "e" })).rejects.toThrow(
      /won't convert/,
    );
    const other = setup();
    other.setUndo({ daily_budget_minor: 2000, currency: "EUR", budget_resource: "customers/1234567890/campaignBudgets/9" });
    await expect(
      other.exec.execute("set_daily_budget", { ...raise, currency: "USD" }, { ...CTX, execution_id: "e" }),
    ).rejects.toThrow(/approved this change in USD/);
  });

  it("refuses a shared budget and a budget that isn't daily", async () => {
    const shared = setup({ shared: true });
    expect(await shared.exec.preflight?.("set_daily_budget", raise, CTX)).toMatchObject({
      message: expect.stringMatching(/shares its budget/),
    });
    const total = setup({ period: "CUSTOM_PERIOD" });
    await expect(total.exec.captureUndo("set_daily_budget", raise, CTX)).rejects.toThrow(/custom period budget/);
  });

  it("refuses without a captured baseline, or when the campaign moved budget", async () => {
    const { exec, setUndo } = setup();
    await expect(exec.execute("set_daily_budget", raise, { ...CTX, execution_id: "e" })).rejects.toThrow(
      /wasn't recorded/,
    );
    setUndo({ daily_budget_minor: 2000, currency: "EUR", budget_resource: "customers/1234567890/campaignBudgets/8" });
    await expect(exec.execute("set_daily_budget", raise, { ...CTX, execution_id: "e" })).rejects.toThrow(
      /moved to another budget/,
    );
  });

  it("undo puts the previous budget back, only while it is still what SYB set", async () => {
    const undo = {
      campaign_id: "111",
      budget_resource: "customers/1234567890/campaignBudgets/9",
      amount_micros: 20_000_000,
      daily_budget_minor: 2000,
      currency: "EUR",
    };
    const { exec, fake } = setup({ amount_micros: 24_000_000 });
    await exec.undo("set_daily_budget", undo, { ...CTX, result: { sent_amount_micros: 24_000_000 } });
    expect(fake.campaigns.get("111")?.amount_micros).toBe(20_000_000);
    const owner = setup({ amount_micros: 30_000_000 });
    await expect(
      owner.exec.undo("set_daily_budget", undo, { ...CTX, result: { sent_amount_micros: 24_000_000 } }),
    ).rejects.toThrow(/you've changed it since/);
    expect(owner.mutates()).toEqual([]);
  });

  it("a Google refusal at the dry run changes nothing; quota is worth another attempt", async () => {
    const refused = setup({}, {}, { mutateStatus: 400 });
    await expect(refused.exec.execute("pause_campaign", { campaign_id: "111" }, CTX)).rejects.toMatchObject({
      message: expect.stringMatching(/dry run refused/),
      retryable: false,
    });
    expect(refused.fake.campaigns.get("111")?.status).toBe("ENABLED");
    const busy = setup({}, {}, { mutateStatus: 429 });
    await expect(busy.exec.execute("pause_campaign", { campaign_id: "111" }, CTX)).rejects.toMatchObject({
      retryable: true,
    });
  });
});

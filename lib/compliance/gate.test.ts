// ComplianceGate v1 — architecture-v2 D5, D6 and hard rule 6. That a
// failure here overrides any ladder authorization is proven in the engine's
// own suite (lib/execution/architecture-v2.test.ts), where both meet.

import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { PHONE_COUNTRIES_KEY, phoneAnsweringAllowed } from "../phone/countries";
import { check } from "./gate";

const saved = process.env[PHONE_COUNTRIES_KEY];
afterEach(() => {
  if (saved === undefined) delete process.env[PHONE_COUNTRIES_KEY];
  else process.env[PHONE_COUNTRIES_KEY] = saved;
});

const business = () => ({ profileId: randomUUID(), accountId: randomUUID() });

describe("hard rule 6 / D6 — phone answering defaults to blocked", () => {
  it("blocks every country while PHONE_ANSWERING_COUNTRIES is empty", () => {
    delete process.env[PHONE_COUNTRIES_KEY];
    expect(phoneAnsweringAllowed("HU")).toBe(false);
    process.env[PHONE_COUNTRIES_KEY] = "";
    expect(phoneAnsweringAllowed("DE")).toBe(false);
  });

  it("allows only the countries listed, by ISO code, case- and space-forgiving", () => {
    process.env[PHONE_COUNTRIES_KEY] = " hu, de ";
    expect(phoneAnsweringAllowed("HU")).toBe(true);
    expect(phoneAnsweringAllowed("DE")).toBe(true);
    expect(phoneAnsweringAllowed("AT")).toBe(false);
  });

  it("blocks a business whose country isn't known, whatever the list says", () => {
    process.env[PHONE_COUNTRIES_KEY] = "HU";
    expect(phoneAnsweringAllowed(null)).toBe(false);
  });

  it("ignores junk in the list rather than reading it as a country", () => {
    process.env[PHONE_COUNTRIES_KEY] = "Hungary,H,123";
    expect(phoneAnsweringAllowed("HU")).toBe(false);
  });

  it("the gate names the setting when it refuses phone answering", async () => {
    delete process.env[PHONE_COUNTRIES_KEY];
    const verdict = await check({ ...business(), capability: "phone_answering", country: "HU" });
    expect(verdict.clear).toBe(false);
    expect(verdict.clear === false && verdict.reasons.join(" ")).toMatch(
      /PHONE_ANSWERING_COUNTRIES/,
    );
    process.env[PHONE_COUNTRIES_KEY] = "HU";
    expect(await check({ ...business(), capability: "phone_answering", country: "HU" })).toEqual({
      clear: true,
    });
  });
});

describe("D5 — an external capability needs a live write consent", () => {
  it("refuses an external capability with no write consent for it", async () => {
    const verdict = await check({
      ...business(),
      capability: "meta_ads",
      country: "HU",
      external: true,
    });
    expect(verdict.clear).toBe(false);
    expect(verdict.clear === false && verdict.reasons.join(" ")).toMatch(/write consent/);
  });

  it("clears it once the consent exists", async () => {
    const verdict = await check(
      { ...business(), capability: "meta_ads", country: "HU", external: true },
      { writeConsent: async () => true },
    );
    expect(verdict).toEqual({ clear: true });
  });

  it("a purchase order's consent is its approval: there is no account to connect", async () => {
    const verdict = await check(
      { ...business(), capability: "purchase_order", country: "HU", external: true },
      {
        writeConsent: async () => {
          throw new Error("must not be asked");
        },
      },
    );
    expect(verdict).toEqual({ clear: true });
  });

  it("asks nothing of an in-repo capability that writes nowhere", async () => {
    const verdict = await check(
      { ...business(), capability: "fixture", country: null, external: false },
      {
        writeConsent: async () => {
          throw new Error("must not be asked");
        },
      },
    );
    expect(verdict).toEqual({ clear: true });
  });

  it("reports every reason at once, not only the first", async () => {
    delete process.env[PHONE_COUNTRIES_KEY];
    const verdict = await check(
      { ...business(), capability: "phone_answering", country: null, external: true },
      { writeConsent: async () => false },
    );
    expect(verdict.clear === false && verdict.reasons).toHaveLength(2);
  });
});

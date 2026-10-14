// P3-20h/i — the consent screen's data, no database: every offered write
// connection has its setup, its fields are the ones the connector reads,
// the confirmation is a phrase not a click, the consent lines say what the
// task promised in the owner's words, and the access level never claims
// more than META_ACCESS_LEVEL says Meta granted.

import { afterEach, describe, expect, it } from "vitest";
import { metaAccessLevel } from "../env";
import { parseMetaExecutionCredential } from "./providers/meta";
import { EXECUTION_SCOPE_REGISTRY } from "./scopes";
import { EXECUTION_SETUP, OFFERED_EXECUTION, accessLevelCopy, confirmationMatches } from "./setup";

const saved = process.env.META_ACCESS_LEVEL;
afterEach(() => {
  if (saved === undefined) delete process.env.META_ACCESS_LEVEL;
  else process.env.META_ACCESS_LEVEL = saved;
});

describe("P3-20h — what the consent screen offers", () => {
  it("offers the two Meta consents and never a fixture", () => {
    expect([...OFFERED_EXECUTION]).toEqual(["meta_publish", "meta_ads"]);
    for (const id of OFFERED_EXECUTION) expect(EXECUTION_SETUP[id]).toBeDefined();
  });

  it("the consent lines say, verbatim, what the task promised", () => {
    const lines = (id: "meta_publish" | "meta_ads") =>
      EXECUTION_SCOPE_REGISTRY[id].consent.map((c) => c.why).join(" ");
    expect(lines("meta_publish")).toContain("SYB may publish posts to the Page you choose");
    expect(lines("meta_ads")).toContain(
      "SYB may pause, resume or change the daily budget of campaigns",
    );
    expect(lines("meta_ads")).toContain("SYB will never touch billing or payment methods");
  });

  it("the fields the screen asks for are the ones the connector reads", () => {
    const filled = (id: "meta_publish" | "meta_ads") =>
      JSON.stringify(
        Object.fromEntries(
          (EXECUTION_SETUP[id]?.credential_fields ?? []).map((f) => [
            f.name,
            f.optional ? "" : f.name === "access_token" ? "EAAtoken" : "1234567890",
          ]),
        ),
      );
    expect(parseMetaExecutionCredential(filled("meta_publish"), "meta_publish")).toMatchObject({
      access_token: "EAAtoken",
      page_id: "1234567890",
      ig_user_id: null,
      page_access_token: null,
    });
    expect(parseMetaExecutionCredential(filled("meta_ads"), "meta_ads").ad_account_id).toBe(
      "1234567890",
    );
  });

  it("the confirmation is the typed phrase — case and outer spaces aside — and nothing else", () => {
    expect(confirmationMatches("meta_publish", "  Allow Publishing ")).toBe(true);
    expect(confirmationMatches("meta_publish", "allow ad changes")).toBe(false);
    expect(confirmationMatches("meta_publish", "yes")).toBe(false);
    expect(confirmationMatches("meta_publish", "")).toBe(false);
    expect(confirmationMatches("meta_ads", "allow ad changes")).toBe(true);
    expect(confirmationMatches("fixture", "anything")).toBe(false);
  });

  it("every own-app setup names the permissions as listed — no more, no fewer", () => {
    for (const id of OFFERED_EXECUTION) {
      const steps = EXECUTION_SETUP[id]?.own_app_steps ?? [];
      expect(steps.length).toBeGreaterThanOrEqual(4);
      expect(steps.join(" ")).toMatch(/exactly the permissions? listed below/);
    }
  });
});

describe("P3-20i — access-level honesty", () => {
  it("anything but 'advanced' reads as standard — the safe reading is the default", () => {
    delete process.env.META_ACCESS_LEVEL;
    expect(metaAccessLevel()).toBe("standard");
    process.env.META_ACCESS_LEVEL = "Advanced ";
    expect(metaAccessLevel()).toBe("standard");
    process.env.META_ACCESS_LEVEL = "advanced";
    expect(metaAccessLevel()).toBe("advanced");
  });

  it("at standard: two pilot routes, and open sign-up said to wait on registration and Meta's approvals", () => {
    const copy = accessLevelCopy("standard");
    expect(copy.routes).toHaveLength(2);
    expect(copy.headline).toMatch(/hasn't approved SYB for open sign-up/);
    expect(copy.body).toContain("company registration");
    expect(copy.body).toMatch(/Advanced Access.*Business Verification.*Tech Provider/);
    // Facebook Login for testers (P3-20j) isn't built: it is offered as unavailable, not pretended.
    expect(copy.routes.find((r) => /Facebook/.test(r.title))?.available).toBe(false);
    expect(copy.routes.find((r) => /own Meta app/.test(r.title))?.available).toBe(true);
  });

  it("at advanced: no claim of waiting, and still no pretending Facebook Login exists", () => {
    const copy = accessLevelCopy("advanced");
    expect(copy.headline).toMatch(/has approved/);
    expect(copy.body).not.toMatch(/pilot/);
    expect(copy.routes.find((r) => /Facebook/.test(r.title))?.available).toBe(false);
  });
});

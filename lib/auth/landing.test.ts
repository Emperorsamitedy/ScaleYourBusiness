// Where a proven sign-in lands (L8 of docs/DASHBOARD-OVERHAUL.md): in the
// app, not in the interview. The rule itself is pure: no query, no cookie.
// (The module beside it sets cookies and so loads the database's address.)

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { landingPath } from "./landing";
import type { RedeemedSession } from "./service";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function session(over: Partial<RedeemedSession> = {}): RedeemedSession {
  return {
    session_token: "t",
    session_expires_at: "2027-01-01T00:00:00.000Z",
    account_id: "a",
    user_id: "u",
    email: "owner@example.com",
    profile_id: "p",
    choose: false,
    ...over,
  };
}

describe("landingPath", () => {
  it("lands a person with a business on Home", () => {
    expect(landingPath(session(), undefined)).toBe("/home");
  });

  it("goes back to the proposal card the sign-in started from", () => {
    expect(landingPath(session(), `/proposals/${ID}`)).toBe(`/proposals/${ID}`);
    expect(landingPath(session(), "/proposals")).toBe("/proposals");
  });

  it("goes back to an idea, with a business or without one", () => {
    expect(landingPath(session(), "/i/AbCdEfGh1234")).toBe("/i/AbCdEfGh1234");
    expect(landingPath(session({ profile_id: null }), "/i/AbCdEfGh1234")).toBe("/i/AbCdEfGh1234");
    expect(landingPath(session({ profile_id: null }), "/idea")).toBe("/idea");
  });

  it("asks which business first when the email is on several", () => {
    expect(landingPath(session({ choose: true }), `/proposals/${ID}`)).toBe("/login/choose");
    expect(landingPath(session({ choose: true, profile_id: null }), "/idea")).toBe("/login/choose");
  });

  it("without a business only an idea is a way back: a card or a kept idea is not", () => {
    const none = session({ profile_id: null });
    expect(landingPath(none, undefined)).toBe("/intake");
    expect(landingPath(none, `/proposals/${ID}`)).toBe("/intake");
    expect(landingPath(none, "/idea/mine")).toBe("/intake");
  });

  it("never follows a path outside the allowlist", () => {
    expect(landingPath(session(), "https://evil.example/proposals")).toBe("/home");
    expect(landingPath(session(), "/ops")).toBe("/home");
    expect(landingPath(session({ profile_id: null }), "//evil.example/i/AbCdEfGh1234")).toBe(
      "/intake",
    );
  });
});

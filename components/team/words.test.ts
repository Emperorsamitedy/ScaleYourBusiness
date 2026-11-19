// L-3c: Team cover, Team access and the invite say in English what the
// code always said, and their figures and dates follow the reader's locale.

import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { ROLES } from "../../lib/auth/role-actions";
import { englishTr } from "../../lib/i18n/tr";
import { INVITE_DAYS, ROLE_MEANS, day } from "../members/TeamAccessScreen";
import { dayIn, fig, pct, shortDay } from "./TeamScreen";

describe("the team screens' English is the code's own words", () => {
  it("says what each role can do as ROLE_MEANS does", () => {
    for (const r of ROLES) expect(en.teamAccess.roleMeans[r], r).toBe(ROLE_MEANS[r]);
  });

  it("words the counts and roles as the screens did, agreeing at one", () => {
    const ta = englishTr("teamAccess");
    expect(ta("title", { count: 1 })).toBe("Only you can sign in here.");
    expect(ta("title", { count: 3 })).toBe("3 people can sign in here.");
    expect(ta("youAre", { role: "owner" })).toBe("You’re an owner");
    expect(ta("youAre", { role: "manager" })).toBe("You’re a manager");
    expect(ta("members.nowRole", { email: "a@b.co", role: "viewer" })).toBe(
      "a@b.co is now a viewer.",
    );
    expect(ta("invites.sent", { email: "a@b.co", days: INVITE_DAYS })).toBe(
      "I've emailed the invite to a@b.co. It works once, for 7 days.",
    );
    const inv = englishTr("invite");
    expect(inv("title.as", { role: "owner", email: "a@b.co" })).toBe("As an owner, for a@b.co");
    expect(inv("status.expired", { days: INVITE_DAYS })).toBe(
      "This invite has run out. Invites work for 7 days.",
    );
    const team = englishTr("team");
    expect(team("grid.cellTitle", { typical: "96%", low: "91%", high: "100%", days: 8 })).toBe(
      "96% on a typical day, 91% to 100% on the middle half of 8 days",
    );
  });
});

describe("the team screens' figures and dates in the reader's locale", () => {
  it("keeps English's grammar and writes the reader's elsewhere", () => {
    expect(pct(0.96)).toBe("96%");
    expect(pct(0.96, "de-DE")).toBe("96 %");
    expect(fig(37.5)).toBe("37.5");
    expect(fig(37.5, "de-DE")).toBe("37,5");
    expect(shortDay("sat")).toBe("Sat");
    expect(shortDay("sat", "fr-FR")).toBe("sam.");
    expect(dayIn("2026-11-06")).toBe("6 Nov");
    expect(dayIn("2026-11-06", "de-DE")).toBe("6. Nov.");
    expect(day("2026-11-06T12:00:00Z")).toBe("6 Nov 2026");
    expect(day("2026-11-06T12:00:00Z", "hu-HU")).toBe("2026. nov. 6.");
  });
});

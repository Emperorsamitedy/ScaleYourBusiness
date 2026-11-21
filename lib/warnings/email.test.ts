// Warnings sent at once: the email and its switch. Pure: no database.

import { describe, expect, it } from "vitest";
import { wordsFor } from "../i18n/recipient";
import { composeWarningEmail } from "./email";
import { WARNING_PREF_KEY, warningEmailOn, warningPref } from "./switch";

const input = {
  kind: "cash_warning" as const,
  sentences: [
    "Money could get tight this week: at the cautious end the balance is about €7,770, under the €9,600 you want to keep.",
  ],
  screen: "Cash flow",
  settings: "Alerts and modules",
  origin: "https://app.example",
  to: "owner@example.com",
  alert_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

describe("the warning's email", () => {
  const mail = composeWarningEmail(input);

  it("says the warning in the watch's own sentence, and gives the way to its screen", () => {
    expect(mail.to).toBe("owner@example.com");
    expect(mail.text).toContain(input.sentences[0]);
    expect(mail.text).toContain("Open Cash flow: https://app.example/cash");
    expect(mail.html).toContain('href="https://app.example/cash"');
    const stock = composeWarningEmail({ ...input, kind: "stock_warning", screen: "Stock" });
    expect(stock.text).toContain("Open Stock: https://app.example/stock");
  });

  it("has a subject with no figure in it: a subject shows on a lock screen too", () => {
    expect(mail.subject).toBe("Your cash could get tight in the weeks ahead");
    expect(mail.subject).not.toMatch(/\d|€/);
  });

  it("says why it came and where to stop it", () => {
    expect(mail.text).toContain("I tell you once, the first time a warning like this appears.");
    expect(mail.text).toContain(
      "To stop these emails, switch them off under Alerts and modules. https://app.example/settings/alerts",
    );
    expect(mail.html).toContain('href="https://app.example/settings/alerts"');
  });

  it("is the same bytes for the same warning, and a second send of it is a duplicate", () => {
    expect(composeWarningEmail(input)).toEqual(mail);
    expect(mail.idempotency_key).toBe(`warning-${input.alert_id}`);
  });

  it("never lets a sentence's own characters into the page as markup", () => {
    const odd = composeWarningEmail({ ...input, sentences: [`Mugs <b>&</b> "plates" run out`] });
    expect(odd.html).toContain("Mugs &lt;b&gt;&amp;&lt;/b&gt; &quot;plates&quot; run out");
    expect(odd.html).not.toContain("<b>&</b>");
    // The text email carries it as written.
    expect(odd.text).toContain(`Mugs <b>&</b> "plates" run out`);
  });

  it("puts several warnings of one run in one email, each on its own line, and counts them", () => {
    const three = composeWarningEmail({
      ...input,
      kind: "stock_warning",
      screen: "Stock",
      sentences: [
        "Mugs run out in about 3 days.",
        "Plates run out in about 5 days.",
        "Bowls run out in about 6 days.",
      ],
    });
    expect(three.subject).toBe("3 warnings worth knowing");
    expect(three.text.split("\n").slice(0, 3)).toEqual([
      "Mugs run out in about 3 days.",
      "Plates run out in about 5 days.",
      "Bowls run out in about 6 days.",
    ]);
    expect(three.html.match(/<p style="margin:0 0 12px">/g)).toHaveLength(3);
  });

  it("speaks the owner's language (L-6)", async () => {
    const de = composeWarningEmail(
      { ...input, screen: "Cashflow", settings: "Hinweise und Module" },
      await wordsFor("de-DE", "emails.warning"),
      await wordsFor("de-DE", "warningPush"),
    );
    expect(de.subject).toBe("Ihr Geld könnte in den nächsten Wochen knapp werden");
    expect(de.text).toContain("Cashflow öffnen: https://app.example/cash");
  });
});

describe("the email's switch", () => {
  it("is on until the owner switches it off", () => {
    expect(warningEmailOn(warningPref(null))).toBe(true);
    expect(warningEmailOn(warningPref({}))).toBe(true);
    expect(warningEmailOn(warningPref({ weekly_summary: false }))).toBe(true);
    expect(warningEmailOn(warningPref({ [WARNING_PREF_KEY]: true }))).toBe(true);
  });

  it("stays off once the owner said so, and reads nothing else as their word", () => {
    expect(warningEmailOn(warningPref({ [WARNING_PREF_KEY]: false }))).toBe(false);
    expect(warningPref({ [WARNING_PREF_KEY]: "no" })).toBeNull();
    expect(warningPref("off")).toBeNull();
  });
});

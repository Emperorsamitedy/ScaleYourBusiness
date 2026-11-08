// P6-07 — the WhatsApp summary's pure parts: the variables WhatsApp will
// take, the digest, the template choice, the exact Twilio request, and how
// Twilio's answer is sorted. No database, no network.

import { describe, expect, it } from "vitest";
import { parseWhatsAppTemplates } from "../env";
import { englishWords } from "../i18n/recipient";
import type { SummarySection } from "./compose";
import { summaryChannel, wantsEmail, wantsWhatsApp } from "./switch";
import {
  DIGEST_SEPARATOR,
  VARIABLES_CAP,
  VARIABLE_CAPS,
  cleanVariable,
  maskNumber,
  sendWhatsApp,
  summaryDigest,
  templateFor,
  variableProblems,
  whatsappOutcome,
  whatsappRequest,
  whatsappVariables,
} from "./whatsapp";

const W = englishWords("emails.summary");
const SID = `AC${"a1".repeat(16)}`;
const ENV = {
  accountSid: SID,
  authToken: "tok",
  from: "+447700900001",
  templates: { en: `HX${"e".repeat(32)}` },
};

function section(lines: string[], more = 0): SummarySection {
  return {
    key: "noticed",
    title: "What I noticed",
    lines: lines.map((text) => ({ text })),
    more,
    href: "/watch",
    link_text: "Watching",
  };
}

const isClean = (v: string) => !/[\r\n\t]/.test(v) && !/ {5,}/.test(v);

describe("P6-07 — a variable WhatsApp will take", () => {
  it("folds newlines, tabs and runs of spaces to one space", () => {
    expect(cleanVariable("a\nb\r\nc\td      e", 100)).toBe("a b c d e");
    expect(cleanVariable("  x  ", 100)).toBe("x");
  });

  it("cuts to the cap with an ellipsis, counting characters not bytes", () => {
    const cut = cleanVariable("é".repeat(50), 10);
    expect(Array.from(cut)).toHaveLength(10);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("variableProblems passes clean variables and names every broken one", () => {
    const ok = { "1": "Bakery", "2": "2–8 Nov", "3": "Quiet", "4": "https://a.example/watch" };
    expect(variableProblems(ok)).toEqual([]);
    expect(variableProblems({ ...ok, "1": "a\nb" })).toContain("1: newline");
    expect(variableProblems({ ...ok, "2": "a\tb" })).toContain("2: tab");
    expect(variableProblems({ ...ok, "3": "a     b" })).toContain("3: more than four spaces");
    expect(variableProblems({ ...ok, "3": "x".repeat(VARIABLE_CAPS["3"] + 1) })).toContain(
      "3: over 480",
    );
    expect(variableProblems({ ...ok, "4": " " })).toContain("4: empty");
  });
});

describe("P6-07 — the digest", () => {
  it("joins the email's lines with a middle dot, in its order", () => {
    const d = summaryDigest(
      { quiet: false, sections: [section(["One thing.", "— Two"]), section(["Three."])] },
      W,
    );
    expect(d).toBe(["One thing.", "Two", "Three."].join(DIGEST_SEPARATOR));
  });

  it("says 'and N more' for what doesn't fit, held-back lines counted", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `Line number ${"x".repeat(30)} ${i}`);
    const d = summaryDigest({ quiet: false, sections: [section(lines, 4)] }, W, 200);
    expect(Array.from(d).length).toBeLessThanOrEqual(200);
    const kept = d.split(DIGEST_SEPARATOR).length - 1;
    expect(d).toMatch(new RegExp(`and ${30 - kept + 4} more$`));
  });

  it("cuts a first line too long to fit, and still says what's left", () => {
    const d = summaryDigest({ quiet: false, sections: [section(["y".repeat(1000), "z"])] }, W, 100);
    expect(Array.from(d).length).toBeLessThanOrEqual(100);
    expect(d).toMatch(/… · and 1 more$/);
  });

  it("a quiet week is the email's quiet sentence", () => {
    expect(summaryDigest({ quiet: true, sections: [] }, W)).toBe(W.t("quiet"));
  });

  it("never carries a newline, a tab or five spaces, whatever the lines hold", () => {
    const nasty = ["a\n\nb", "c\t\td", "e          f", " g ", "h\r\ni"];
    for (let n = 1; n <= nasty.length; n++) {
      const d = summaryDigest({ quiet: false, sections: [section(nasty.slice(0, n), 2)] }, W);
      expect(isClean(d), d).toBe(true);
    }
  });
});

describe("P6-07 — the four variables", () => {
  const composed = (lines: string[]) => ({
    period: "2–8 Nov 2026",
    quiet: lines.length === 0,
    sections: lines.length ? [section(lines)] : [],
  });

  it("are clean and inside every cap and the total, however long the week", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `A long\nline\t${i} ${"w".repeat(80)}`);
    const v = whatsappVariables({
      business: `The\nVery ${"Long ".repeat(40)}Bakery`,
      composed: composed(lines),
      origin: "https://app.example",
      w: W,
    });
    expect(variableProblems(v)).toEqual([]);
    const total = Object.values(v).reduce((n, s) => n + Array.from(s).length, 0);
    expect(total).toBeLessThanOrEqual(VARIABLES_CAP);
    expect(v["4"]).toBe("https://app.example/watch");
    for (const s of Object.values(v)) expect(isClean(s)).toBe(true);
  });

  it("names the business, or says 'your business' when it has no name", () => {
    const named = whatsappVariables({
      business: "Kenji's Bakery",
      composed: composed([]),
      origin: "https://a.example",
      w: W,
    });
    expect(named["1"]).toBe("Kenji's Bakery");
    expect(named["2"]).toBe("2–8 Nov 2026");
    const unnamed = whatsappVariables({
      business: null,
      composed: composed([]),
      origin: "https://a.example",
      w: W,
    });
    expect(unnamed["1"]).toBe("your business");
  });
});

describe("P6-07 — the template", () => {
  const T = { en: `HX${"0".repeat(32)}`, "de-DE": `HX${"d".repeat(32)}` };
  it("uses the language's own, and falls back to English's", () => {
    expect(templateFor(T, "de-DE")).toEqual({ locale: "de-DE", content_sid: T["de-DE"] });
    expect(templateFor(T, "fr-FR")).toEqual({ locale: "en", content_sid: T.en });
    expect(templateFor({}, "fr-FR")).toBeNull();
  });

  it("reads TWILIO_WHATSAPP_SUMMARY_TEMPLATES strictly: JSON, HX sids, with en", () => {
    expect(parseWhatsAppTemplates(JSON.stringify(T))).toEqual(T);
    expect(parseWhatsAppTemplates(JSON.stringify({ "de-DE": T["de-DE"] }))).toBeNull();
    expect(parseWhatsAppTemplates(JSON.stringify({ en: "HX123" }))).toBeNull();
    expect(parseWhatsAppTemplates("not json")).toBeNull();
    expect(parseWhatsAppTemplates("[]")).toBeNull();
    expect(parseWhatsAppTemplates(undefined)).toBeNull();
  });
});

describe("P6-07 — the channel", () => {
  it("defaults to email; WhatsApp only when the owner chose it", () => {
    expect(summaryChannel(null)).toBe("email");
    expect(summaryChannel({})).toBe("email");
    expect(summaryChannel({ weekly_summary_channel: "sms" })).toBe("email");
    expect(summaryChannel({ weekly_summary_channel: "both" })).toBe("both");
    expect(wantsEmail("whatsapp")).toBe(false);
    expect(wantsWhatsApp("email")).toBe(false);
    expect(wantsEmail("both") && wantsWhatsApp("both")).toBe(true);
  });

  it("shows a number by its last three digits only", () => {
    expect(maskNumber("+447700900123")).toBe("•••123");
  });
});

describe("P6-07 — Twilio's Messages API", () => {
  const vars = { "1": "Bakery", "2": "2–8 Nov", "3": "Quiet", "4": "https://a.example/watch" };

  it("builds the documented request: Basic auth, form body, ContentVariables as JSON", () => {
    const { url, init } = whatsappRequest(ENV, {
      to: "+447700900555",
      content_sid: ENV.templates.en,
      variables: vars,
    });
    expect(url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`);
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${SID}:tok`).toString("base64")}`,
    );
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(init.body);
    expect(form.get("From")).toBe("whatsapp:+447700900001");
    expect(form.get("To")).toBe("whatsapp:+447700900555");
    expect(form.get("ContentSid")).toBe(ENV.templates.en);
    expect(JSON.parse(form.get("ContentVariables")!)).toEqual(vars);
    expect(form.has("Body")).toBe(false);
  });

  it("refuses a recipient that isn't E.164", () => {
    expect(() =>
      whatsappRequest(ENV, { to: "07700900555", content_sid: "HX", variables: vars }),
    ).toThrow();
  });

  it("sorts the answer: sent only with a SID; a 4xx refused with its code; else unknown", () => {
    const sid = `SM${"f".repeat(32)}`;
    expect(whatsappOutcome(201, { sid, status: "queued" })).toEqual({ kind: "sent", sid });
    expect(whatsappOutcome(201, { status: "queued" }).kind).toBe("unknown");
    expect(whatsappOutcome(400, { code: 63016, message: "x" })).toEqual({
      kind: "refused",
      status: 400,
      code: 63016,
    });
    expect(whatsappOutcome(401, null)).toEqual({ kind: "refused", status: 401, code: null });
    expect(whatsappOutcome(500, {}).kind).toBe("unknown");
    expect(whatsappOutcome(409, {}).kind).toBe("unknown");
  });

  it("sends once and never retries; broken variables never reach the network", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return new Response(JSON.stringify({ code: 20500 }), { status: 503 });
    };
    const msg = { to: "+447700900555", content_sid: ENV.templates.en, variables: vars };
    expect((await sendWhatsApp(ENV, msg, fetchImpl)).kind).toBe("unknown");
    expect(calls).toBe(1);
    const broken = { ...msg, variables: { ...vars, "3": "two\nlines" } };
    expect((await sendWhatsApp(ENV, broken, fetchImpl)).kind).toBe("refused");
    expect(calls).toBe(1);
    const thrown = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    expect(await sendWhatsApp(ENV, msg, thrown)).toEqual({ kind: "unknown", why: "TypeError" });
  });
});

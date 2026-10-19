// P4-16 — jurisdiction rules for marketing email, rule 23. What must hold:
// every covered country maps to exactly one regime and an unknown one to
// none (so nothing sends there); a send falls under the business's regime
// AND the recipient's; a message missing anything any applicable regime
// requires is refused by name; consent must be demonstrable; and no regime
// ever loosens SYB's floor — explicit, unsuppressed consent per contact.

import "dotenv/config";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "../../db";
import { accounts, businessProfiles, contacts, fieldRecords, intakeEvents } from "../../db/schema";
import { bootstrapIntake } from "../intake/service";
import type { ContactRow } from "./contacts";
import { addContact } from "./contacts";
import { importContacts, parseCountry } from "./import";
import type { MarketingMessage } from "./jurisdiction";
import {
  REGIMES,
  applicableRegimes,
  canSendMarketing,
  consentEvidenceGap,
  messageGaps,
  regimeFor,
  unsubscribeLinkDays,
} from "./jurisdiction";

const COMPLETE: MarketingMessage = {
  sender_name: "Emberworks",
  sender_email: "hello@emberworks.test",
  postal_address: "Király utca 12, 1061 Budapest, Hungary",
  unsubscribe_url: "https://syb.example/u/abc123",
  disclosure: "Written with AI assistance.",
};

describe("P4-16 — which regime a country sends under", () => {
  it("maps the names owners type, and ISO codes, to one regime each", () => {
    expect(regimeFor("Hungary")?.id).toBe("eu_gdpr");
    expect(regimeFor("Deutschland")?.id).toBe("eu_gdpr");
    expect(regimeFor("spain")?.id).toBe("eu_gdpr"); // multi-zone, still one regime
    expect(regimeFor("Norway")?.id).toBe("eu_gdpr"); // EEA, not EU
    expect(regimeFor("United Kingdom")?.id).toBe("uk_pecr");
    expect(regimeFor("USA")?.id).toBe("us_can_spam");
    expect(regimeFor("Canada")?.id).toBe("ca_casl");
    expect(regimeFor("Australia")?.id).toBe("au_spam_act");
    expect(regimeFor("LI")?.id).toBe("eu_gdpr");
  });

  it("a country SYB has no rules for maps to none — Switzerland and Serbia are not the EEA", () => {
    expect(regimeFor("Switzerland")).toBeNull();
    expect(regimeFor("Serbia")).toBeNull();
    expect(regimeFor("Atlantis")).toBeNull();
    expect(regimeFor(null)).toBeNull();
  });

  it("no country sits in two regimes", () => {
    const seen = new Map<string, string>();
    for (const r of Object.values(REGIMES)) {
      for (const c of r.countries) {
        expect(seen.get(c), `${c} in ${seen.get(c)} and ${r.id}`).toBeUndefined();
        seen.set(c, r.id);
      }
    }
    expect(REGIMES.eu_gdpr.countries).toHaveLength(30); // EU 27 + IS, LI, NO
  });

  it("unknown on either side refuses the send rather than guessing", () => {
    expect(applicableRegimes({ businessCountry: null })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/business's country isn't known/),
    });
    expect(applicableRegimes({ businessCountry: "Switzerland" })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/doesn't yet know the email marketing rules for Switzerland/),
    });
    expect(
      applicableRegimes({ businessCountry: "Hungary", recipientCountry: "Serbia" }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/recipient's country \(Serbia\)/),
    });
  });

  it("the recipient's regime applies beside the business's", () => {
    const lookup = applicableRegimes({ businessCountry: "Hungary", recipientCountry: "USA" });
    expect(lookup.ok && lookup.regimes.map((r) => r.id)).toEqual(["eu_gdpr", "us_can_spam"]);
    const same = applicableRegimes({ businessCountry: "Hungary", recipientCountry: "Austria" });
    expect(same.ok && same.regimes.map((r) => r.id)).toEqual(["eu_gdpr"]);
  });
});

describe("P4-16 — what a marketing message must carry", () => {
  it("a complete message has no gaps anywhere", () => {
    for (const r of Object.values(REGIMES)) expect(messageGaps(COMPLETE, [r])).toEqual([]);
  });

  it("the US and Canada need a postal address; the EU and UK don't — and the gap names who asks", () => {
    const noAddress = { ...COMPLETE, postal_address: null };
    expect(messageGaps(noAddress, [REGIMES.eu_gdpr])).toEqual([]);
    expect(messageGaps(noAddress, [REGIMES.uk_pecr])).toEqual([]);
    expect(messageGaps(noAddress, [REGIMES.us_can_spam])).toEqual([
      "the business's postal address (United States)",
    ]);
    expect(messageGaps(noAddress, [REGIMES.eu_gdpr, REGIMES.ca_casl])).toEqual([
      "the business's postal address (Canada)",
    ]);
  });

  it("every regime needs the sender and a working https unsubscribe; SYB needs the disclosure everywhere", () => {
    const bare: MarketingMessage = {
      sender_name: " ",
      sender_email: "not-an-email",
      postal_address: "x",
      unsubscribe_url: "http://insecure.example/u",
      disclosure: "",
    };
    expect(messageGaps(bare, [REGIMES.au_spam_act])).toEqual([
      "who sent it (the business's name and email) (Australia)",
      "a working unsubscribe link (Australia)",
      "the AI disclosure line (SYB, everywhere)",
    ]);
  });

  it("unsubscribe links stay working as long as the strictest regime that applies asks", () => {
    expect(unsubscribeLinkDays([REGIMES.eu_gdpr])).toBe(0);
    expect(unsubscribeLinkDays([REGIMES.eu_gdpr, REGIMES.us_can_spam])).toBe(30);
    expect(unsubscribeLinkDays([REGIMES.ca_casl, REGIMES.au_spam_act])).toBe(60);
  });

  it("SYB honours every unsubscribe at once — inside every regime's legal deadline", () => {
    const SYB_DAYS = 0; // rule 23: immediately and permanently
    for (const r of Object.values(REGIMES)) {
      if (r.honour_unsubscribe_business_days !== null) {
        expect(SYB_DAYS).toBeLessThanOrEqual(r.honour_unsubscribe_business_days);
      }
    }
  });

  it("every regime cites its source, and every one is looser than SYB's floor — none relaxes it", () => {
    for (const r of Object.values(REGIMES)) {
      expect(r.source.length).toBeGreaterThan(10);
      expect(r.law_is_looser).toBe(true);
    }
  });
});

describe("P4-16 — demonstrable consent", () => {
  it("names how and when, or says which is missing", () => {
    expect(
      consentEvidenceGap({
        consent_source: "checkout checkbox 2026-03-12",
        consent_captured_at: "2026-03-12",
      }),
    ).toBeNull();
    expect(consentEvidenceGap({ consent_source: "  ", consent_captured_at: "2026-03-12" })).toMatch(
      /how/,
    );
  });
});

describe("P4-16 follow-up — the recipient's country, from the export", () => {
  it("reads the names exports carry and bare two-letter codes; anything else is unknown, not guessed", () => {
    expect(parseCountry("Hungary")).toBe("HU");
    expect(parseCountry("United States")).toBe("US");
    expect(parseCountry("gb")).toBe("GB");
    expect(parseCountry("PE")).toBe("PE"); // a real code SYB has no regime for — refused at send
    expect(parseCountry("Atlantis")).toBeNull();
    expect(parseCountry("  ")).toBeNull();
  });
});

/* ── the whole pre-send check, against the database (suppression lives there) ── */

const created: { account_id: string; profile_id: string }[] = [];

afterAll(async () => {
  const accountIds = created.map((s) => s.account_id);
  const ids = created.map((s) => s.profile_id);
  if (accountIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.account_id, accountIds));
    await db.delete(intakeEvents).where(inArray(intakeEvents.profile_id, ids));
    await db.delete(fieldRecords).where(inArray(fieldRecords.profile_id, ids));
    await db.delete(businessProfiles).where(inArray(businessProfiles.id, ids));
    await db.delete(accounts).where(inArray(accounts.id, accountIds));
  }
});

describe("P4-16 — canSendMarketing", () => {
  it("explicit consent, a known regime and a complete message send; every failing reason is listed otherwise", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const yes = await addContact(s.account_id, {
      email: `yes-${crypto.randomUUID()}@test.local`,
      consent: { status: "explicit_consent", source: "checkout checkbox" },
    });
    const implied = await addContact(s.account_id, {
      email: `implied-${crypto.randomUUID()}@test.local`,
      consent: { status: "implied_consent", source: "bought once" },
    });

    expect(
      await canSendMarketing({ contact: yes, businessCountry: "Hungary", message: COMPLETE }),
    ).toMatchObject({ allowed: true, regimes: ["eu_gdpr"], codes: [] });

    // The law in the US is opt-out; SYB still refuses implied consent there.
    const us = await canSendMarketing({
      contact: implied,
      businessCountry: "USA",
      message: { ...COMPLETE, postal_address: null },
    });
    expect(us.allowed).toBe(false);
    expect(us.reason).toMatch(/marketing needs explicit consent/);
    expect(us.reason).toMatch(/postal address \(United States\)/);
    // P4-15: the same verdict as codes the send executor counts — never a sentence with an address.
    expect(us.codes).toEqual(["consent_implied", "message_incomplete"]);

    const nowhere = await canSendMarketing({
      contact: yes,
      businessCountry: "Switzerland",
      message: COMPLETE,
    });
    expect(nowhere).toMatchObject({ allowed: false, regimes: [], codes: ["no_regime"] });

    const [row] = await db.select().from(contacts).where(eq(contacts.id, yes.id));
    expect((row as ContactRow).consent_status).toBe("explicit_consent"); // the check wrote nothing
  });

  it("an imported recipient's own country adds its rules; an unknown one refuses rather than guesses", async () => {
    const s = await bootstrapIntake();
    created.push(s);
    const tag = crypto.randomUUID().slice(0, 8);
    const result = await importContacts(
      s.account_id,
      [
        "email,Billing Country",
        `us-${tag}@test.local,United States`,
        `hu-${tag}@test.local,HU`,
        `pe-${tag}@test.local,PE`,
        `xx-${tag}@test.local,Atlantis`,
      ].join("\n"),
      { status: "explicit_consent", statement: "checkout checkbox, every one of them" },
    );
    expect(result.imported).toBe(4);
    expect(result.country).toEqual({ column: true, unreadable: 1 });

    const rows = await db.select().from(contacts).where(eq(contacts.account_id, s.account_id));
    const by = (prefix: string) => rows.find((r) => r.email?.startsWith(prefix)) as ContactRow;
    expect(by("us-").country).toBe("US");
    expect(by("xx-").country).toBeNull(); // unknown, never guessed

    const noAddress = { ...COMPLETE, postal_address: null };
    // A Hungarian business emailing a US customer falls under CAN-SPAM too: the address is required.
    const us = await canSendMarketing({
      contact: by("us-"),
      businessCountry: "Hungary",
      message: noAddress,
    });
    expect(us).toMatchObject({ allowed: false, regimes: ["eu_gdpr", "us_can_spam"] });
    expect(us.reason).toMatch(/postal address \(United States\)/);
    expect(
      await canSendMarketing({
        contact: by("hu-"),
        businessCountry: "Hungary",
        message: noAddress,
      }),
    ).toMatchObject({ allowed: true, regimes: ["eu_gdpr"] });
    const pe = await canSendMarketing({
      contact: by("pe-"),
      businessCountry: "Hungary",
      message: COMPLETE,
    });
    expect(pe.allowed).toBe(false);
    expect(pe.reason).toMatch(/recipient's country \(PE\)/);
    // No country on the contact: only the business's own regime applies.
    expect(
      await canSendMarketing({
        contact: by("xx-"),
        businessCountry: "Hungary",
        message: noAddress,
      }),
    ).toMatchObject({ allowed: true, regimes: ["eu_gdpr"] });
  });
});

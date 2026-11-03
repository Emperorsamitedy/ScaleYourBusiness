// Rules 1–3 of TASKS-LANGUAGES.md, held by the build (L-1).
//
//   1. No English left behind: every catalogue has exactly English's keys,
//      every message parses as ICU, carries English's placeholders and
//      tags, and every plural it uses has each form its language needs
//      (Intl.PluralRules' categories — Russian one/few/many/other, French
//      and Spanish one/many/other, Chinese other). A longer sentence that
//      is still word-for-word English fails, brand names aside.
//   2. One term, one translation: where an English message uses a glossary
//      term (specs/glossary-v1.json), its translation uses that language's.
//   3. Figures are formatted, never written in: no catalogue value has a
//      digit or a currency sign of its own.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import {
  isArgumentElement,
  isDateElement,
  isNumberElement,
  isPluralElement,
  isSelectElement,
  isTagElement,
  isTimeElement,
  parse,
} from "@formatjs/icu-messageformat-parser";
import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import {
  GROUPS,
  connectionsCount,
  itemKey,
  roleLine,
  supportCount,
} from "../components/nav/AppFrame";
import { ROLE_WORD } from "../lib/auth/role-actions";
import { BASES, BASIS_MEANING, SOURCE_LABEL } from "../components/report/basis";
import { MEASURES, OFFER_ROW } from "../components/report/panel";
import { sessionWords } from "../components/voice/MicButton";
import { ENGLISH_SESSION_WORDS, NOTICE, errorWords } from "../lib/voice/session";
import type { AppLocale } from "../lib/i18n/locales";
import { LOCALES } from "../lib/i18n/locales";

type Tree = { [key: string]: string | Tree };

const DIR = join(process.cwd(), "messages");
const load = (l: AppLocale): Tree =>
  JSON.parse(readFileSync(join(DIR, `${l}.json`), "utf8")) as Tree;

/** Pure: a nested catalogue as dotted key → message. */
export function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of flatten(v, key)) out.set(kk, vv);
  }
  return out;
}

const EN = flatten(load("en"));
/** CATALOGUE_LOCALE=de-DE checks one language alone, for whoever is translating it. */
const ONLY = process.env.CATALOGUE_LOCALE;
const OTHERS = LOCALES.filter((l) => l !== "en" && (ONLY === undefined || l === ONLY));
const CATALOGUES = new Map(
  LOCALES.filter((l) => l === "en" || OTHERS.includes(l)).map((l) => [l, flatten(load(l))]),
);

interface Shape {
  /** Argument names, plural/select arguments included. */
  args: Set<string>;
  /** Rich-text tag names. */
  tags: Set<string>;
  plurals: { arg: string; forms: string[] }[];
}

/** Pure: what a parsed message needs from its caller, and its plurals. */
export function shapeOf(ast: MessageFormatElement[], into: Shape = emptyShape()): Shape {
  for (const el of ast) {
    if (isArgumentElement(el) || isNumberElement(el) || isDateElement(el) || isTimeElement(el)) {
      into.args.add(el.value);
    } else if (isPluralElement(el) || isSelectElement(el)) {
      into.args.add(el.value);
      if (isPluralElement(el)) into.plurals.push({ arg: el.value, forms: Object.keys(el.options) });
      for (const o of Object.values(el.options)) shapeOf(o.value, into);
    } else if (isTagElement(el)) {
      into.tags.add(el.value);
      shapeOf(el.children, into);
    }
  }
  return into;
}

function emptyShape(): Shape {
  return { args: new Set(), tags: new Set(), plurals: [] };
}

const shape = (message: string) => shapeOf(parse(message));

/** Pure: the plural categories a message is missing for a language ("=n" exact forms don't count). */
export function missingPluralForms(message: string, locale: string): string[] {
  const need = new Intl.PluralRules(locale).resolvedOptions().pluralCategories as string[];
  const missing: string[] = [];
  for (const p of shape(message).plurals) {
    for (const c of need) if (!p.forms.includes(c)) missing.push(`${p.arg}:${c}`);
  }
  return missing;
}

/** Words that are the same in every language: names, not English. */
const BRANDS = ["SYB", "Shopify", "Stripe", "Google", "Apple", "Microsoft", "Meta", "TikTok"];
/** Messages allowed to equal English word for word, with the reason. None yet. */
const SAME_AS_ENGLISH: Record<string, string> = {};

/** Pure: the words of a message once its placeholders, tags and brand names are taken out. */
export function proseWords(message: string): string[] {
  return message
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/<\/?[a-z]+>/gi, " ")
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w) && !BRANDS.includes(w.replace(/[^\p{L}]/gu, "")));
}

/** Pure: the text a reader sees, without the ICU syntax around it. */
function visibleText(message: string): string {
  const parts: string[] = [];
  const walk = (ast: MessageFormatElement[]) => {
    for (const el of ast) {
      if (el.type === 0) parts.push(el.value);
      else if (isPluralElement(el) || isSelectElement(el)) {
        for (const o of Object.values(el.options)) walk(o.value);
      } else if (isTagElement(el)) walk(el.children);
    }
  };
  walk(parse(message));
  return parts.join(" ");
}

describe("the catalogues (rule 1: no English left behind)", () => {
  it("has a catalogue per language, with English's keys exactly", () => {
    expect(EN.size).toBeGreaterThan(50);
    for (const l of OTHERS) {
      const keys = [...(CATALOGUES.get(l)?.keys() ?? [])].sort();
      expect(keys, `${l}: keys differ from en`).toEqual([...EN.keys()].sort());
    }
  });

  it("parses every message as ICU", () => {
    for (const [l, cat] of CATALOGUES) {
      for (const [k, v] of cat) expect(() => parse(v), `${l} ${k}`).not.toThrow();
    }
  });

  it("gives every translation English's placeholders and tags, no more and no fewer", () => {
    for (const [k, en] of EN) {
      const want = shape(en);
      for (const l of OTHERS) {
        const got = shape(CATALOGUES.get(l)?.get(k) ?? "");
        expect([...got.args].sort(), `${l} ${k}: placeholders`).toEqual([...want.args].sort());
        expect([...got.tags].sort(), `${l} ${k}: tags`).toEqual([...want.tags].sort());
      }
    }
  });

  it("has every plural form each language needs, wherever a message uses a plural", () => {
    for (const [l, cat] of CATALOGUES) {
      for (const [k, v] of cat) expect(missingPluralForms(v, l), `${l} ${k}`).toEqual([]);
    }
  });

  it("catches a missing Russian plural form (the check itself)", () => {
    expect(missingPluralForms("{n, plural, one {# день} other {# дня}}", "ru-RU")).toEqual([
      "n:few",
      "n:many",
    ]);
    expect(missingPluralForms("{n, plural, other {# 天}}", "zh-Hans")).toEqual([]);
    expect(missingPluralForms("{n, plural, one {# jour} other {# jours}}", "fr-FR")).toEqual([
      "n:many",
    ]);
  });

  it("leaves no longer sentence word for word in English", () => {
    for (const [k, en] of EN) {
      if (proseWords(en).length < 4 || SAME_AS_ENGLISH[k]) continue;
      for (const l of OTHERS) {
        expect(CATALOGUES.get(l)?.get(k), `${l} ${k} is still English`).not.toBe(en);
      }
    }
    expect(proseWords("Sign in to SYB with Google")).toEqual(["Sign", "in", "to", "with"]);
  });

  it("formats every message in every language without an error", () => {
    for (const l of CATALOGUES.keys()) {
      const t = createTranslator({ locale: l, messages: load(l) }) as unknown as (
        key: string,
        values?: Record<string, unknown>,
      ) => string;
      const rich = createTranslator({ locale: l, messages: load(l) }) as unknown as {
        markup: (key: string, values?: Record<string, unknown>) => string;
      };
      for (const [k, en] of EN) {
        const s = shape(en);
        const values: Record<string, unknown> = {};
        for (const a of s.args) values[a] = 3;
        for (const tag of s.tags) values[tag] = (chunks: string) => `<${tag}>${chunks}</${tag}>`;
        const out = s.tags.size > 0 ? rich.markup(k, values) : t(k, values);
        expect(out, `${l} ${k}`).not.toContain(k);
        expect(out.length, `${l} ${k}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("rule 3: figures are formatted, never written in", () => {
  it("has no digit or currency sign typed into any message", () => {
    for (const [l, cat] of CATALOGUES) {
      for (const [k, v] of cat) {
        expect(visibleText(v), `${l} ${k}`).not.toMatch(/[0-9€$£¥₽₹₩]|\bFt\b|\bHUF\b|\bEUR\b/);
      }
    }
  });
});

describe("English stays what the screens said before (byte for byte)", () => {
  const en = (key: string) => EN.get(key);

  it("names every menu group and item as GROUPS does", () => {
    for (const g of GROUPS) {
      expect(en(`nav.group.${g.key}`), g.key).toBe(g.label);
      for (const i of g.items) expect(en(`nav.item.${itemKey(i)}`), i.href).toBe(i.label);
    }
  });

  it("says the role lines, counts and role words as the code's English does", () => {
    const t = createTranslator({ locale: "en", messages: load("en") }) as unknown as (
      key: string,
      values?: Record<string, unknown>,
    ) => string;
    for (const role of ["owner", "manager", "viewer"] as const) {
      expect(t(`nav.role.${role}`)).toBe(roleLine({ role, signed_in: true, businesses: [] }));
      expect(t(`common.roles.${role}`)).toBe(ROLE_WORD[role]);
    }
    expect(t("nav.count.paused", { count: 2 })).toBe(
      connectionsCount({ connections: 3, needs_reconnect: 2 }),
    );
    expect(t("nav.count.open", { count: 4 })).toBe(
      supportCount({ support_open: 4, by_module: {} }),
    );
    // The sign-in link's lifetime keeps its no-break space, as the JSX had it.
    expect(t("auth.form.noteSignin", { minutes: 15 })).toBe(
      "No password. The link works once, for 15\u00a0minutes.",
    );
    expect(t("auth.signup.takesDaysPending", { days: 7 })).toBe("[7] days");
  });

  it("formats the translated counts with the translator", () => {
    const de = createTranslator({ locale: "de-DE", messages: load("de-DE") }) as unknown as (
      key: string,
      values?: Record<string, unknown>,
    ) => string;
    const words = (kind: "paused" | "open", count: number) => de(`nav.count.${kind}`, { count });
    expect(connectionsCount({ connections: 3, needs_reconnect: 1 }, words)).toBe("1 pausiert");
    expect(supportCount({ support_open: 2, by_module: {} }, words)).toBe("2 offen");
  });

  it("holds L-3a's English to the code's own words", () => {
    const t = createTranslator({ locale: "en", messages: load("en") }) as unknown as (
      key: string,
      values?: Record<string, unknown>,
    ) => string;
    for (const m of MEASURES) {
      expect(en(`report.measure.${m.id}.name`), m.id).toBe(m.name);
      expect(en(`report.measure.${m.id}.words`), m.id).toBe(m.words);
    }
    expect(en("report.measure.offer.words")).toBe(OFFER_ROW.words);
    expect(en("report.measure.offer.refusal")).toBe(OFFER_ROW.refusal);
    for (const b of BASES) expect(en(`sheet.basisMeaning.${b}`), b).toBe(BASIS_MEANING[b]);
    for (const [kind, word] of Object.entries(SOURCE_LABEL)) {
      expect(en(`sheet.source.${kind}`), kind).toBe(word);
    }
    // The microphone says in English exactly what its session always said.
    expect(en("voice.notice")).toBe(NOTICE);
    expect(en("voice.cap")).toBe(ENGLISH_SESSION_WORDS.cap);
    const words = sessionWords((k, v) => t(`voice.${k}`, v));
    for (const code of [
      "aborted",
      "not-allowed",
      "service-not-allowed",
      "no-speech",
      "audio-capture",
      "network",
      "language-not-supported",
      "start-failed",
    ]) {
      expect(words.error(code, "de-DE"), code).toBe(errorWords(code, "de-DE"));
    }
  });

  it("gives Russian its three counting forms", () => {
    const ru = createTranslator({ locale: "ru-RU", messages: load("ru-RU") }) as unknown as (
      key: string,
      values?: Record<string, unknown>,
    ) => string;
    expect(ru("auth.signup.takesDays", { days: 1 })).toBe("1 день");
    expect(ru("auth.signup.takesDays", { days: 3 })).toBe("3 дня");
    expect(ru("auth.signup.takesDays", { days: 5 })).toBe("5 дней");
    expect(ru("auth.signup.takesDays", { days: 21 })).toBe("21 день");
  });
});

// ── rule 2: one term, one translation ──

interface GlossaryTerm {
  id: string;
  en: { term: string; match: string[] };
  [locale: string]: unknown;
}

const GLOSSARY = JSON.parse(
  readFileSync(join(process.cwd(), "specs", "glossary-v1.json"), "utf8"),
) as { terms: GlossaryTerm[]; registers: Record<string, string> };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * L-3a: messages whose English uses a glossary word in another sense, so a
 * translation rightly uses another word — the catalogue's counterpart of
 * the bank overlays' glossary_exceptions. Each names its terms and why; an
 * exception for a term the English no longer uses fails.
 */
const GLOSSARY_EXCEPTIONS: Record<string, { terms: string[]; reason: string }> = {
  "voice.error.network": {
    terms: ["connection"],
    reason: "the device's internet connection, not a connected account",
  },
  "report.panel.legend": {
    terms: ["support"],
    reason: "“a range the data supports”: backs up, not customer support",
  },
  "report.findings.none": {
    terms: ["support"],
    reason: "“the evidence supports”: backs up, not customer support",
  },
  "report.share.lede": {
    terms: ["lead"],
    reason: "“leads into your account”: goes into, not a sales lead",
  },
  "proposals.empty.lede": {
    terms: ["review"],
    reason: "“ad and content reviews”: SYB's own checks, not customer reviews",
  },
  "proposals.bulk.ref": {
    terms: ["review"],
    reason: "“Bulk review”: deciding several at once, not customer reviews",
  },
  "proposals.origin.ads": {
    terms: ["review"],
    reason: "“the ad review”: SYB's check of the ads, not customer reviews",
  },
  "proposals.origin.alert_review": {
    terms: ["review"],
    reason: "“an alert review”: SYB's check of an alert, not customer reviews",
  },
  "proposals.origin.crm": {
    terms: ["review"],
    reason: "“the customer review”: SYB's check of the customer list, not customer reviews",
  },
  "proposals.origin.hours": {
    terms: ["review"],
    reason: "“the opening-hours review”: SYB's check of the hours, not customer reviews",
  },
  "watch.alerts.refused": {
    terms: ["subscription"],
    reason: "the browser's push subscription, not a customer's subscription",
  },
  // L-3b
  "cash.warning.metaBuffer": {
    terms: ["account"],
    reason: "the bank account the money sits in, not a sign-in or connected account",
  },
  "cash.warning.metaZero": {
    terms: ["account"],
    reason: "an empty bank account, not a sign-in or connected account",
  },
  "cash.warning.askBuffer": {
    terms: ["account"],
    reason: "the least wanted in the bank account, not a sign-in or connected account",
  },
  "stock.reorder.approving": {
    terms: ["contact"],
    reason: "“I never contact your supplier”: the verb, not a CRM contact",
  },
  "charts.market.title": {
    terms: ["stock"],
    reason: "“read like a stock”: a share on a market, not goods on hand",
  },
  "pipeline.stage.proposal_sent": {
    terms: ["proposal"],
    reason: "a sales proposal sent to a client (Angebot), not SYB's proposal for approval",
  },
  "pipeline.stageInline.proposal_sent": {
    terms: ["proposal"],
    reason: "a sales proposal sent to a client (Angebot), not SYB's proposal for approval",
  },
  "blindspots.fixed.link": {
    terms: ["review"],
    reason: "“Review on Website”: check the change, not customer reviews",
  },
  "goals.review.head": {
    terms: ["review"],
    reason: "SYB's own alert review, not customer reviews",
  },
  "goals.review.headPerson": {
    terms: ["review"],
    reason: "SYB's own alert review, not customer reviews",
  },
  "goals.review.escalated": {
    terms: ["review", "team"],
    reason: "SYB's own alert review, and SYB's staff (“our team”), not the business's team",
  },
  "goals.review.escalatedWhy": {
    terms: ["review", "team"],
    reason: "SYB's own alert review, and SYB's staff (“our team”), not the business's team",
  },
  "reviews.google.needs.approval": {
    terms: ["approval", "review", "business"],
    reason: "Google's own vetting and sign-off of SYB, and Google's product name Business Profile",
  },
  "reviews.google.notSetUp": {
    terms: ["approval", "business"],
    reason: "Google's sign-off of SYB, and Google's product name Business Profile",
  },
  "reviews.foot": {
    terms: ["business"],
    reason: "Google Business Profile: Google's product name, as Google names it in each language",
  },
  "reviews.google.label": {
    terms: ["business"],
    reason: "Google Business Profile: Google's product name, as Google names it in each language",
  },
  "reviews.google.whatItCanDo": {
    terms: ["business"],
    reason: "Google Business Profile: Google's product name, as Google names it in each language",
  },
  "reviews.google.readNote": {
    terms: ["business"],
    reason: "Google Business Profile: Google's product name, as Google names it in each language",
  },
  "reviews.google.needs.signIn": {
    terms: ["business"],
    reason: "Google Business Profile: Google's product name, as Google names it in each language",
  },
  "reviews.setup.google.notifications": {
    terms: ["business"],
    reason: "Google Business Profile: Google's product name, as Google names it in each language",
  },
  "reviews.setup.trustpilot.notifications": {
    terms: ["business"],
    reason: "Trustpilot Business: Trustpilot's product name",
  }, // L-4b: the sentences built from data.
  "cashWords.needs.buffer": {
    terms: ["account"],
    reason: "the bank account the money sits in, not a sign-in or connected account",
  },
  "cashWords.assumption.payout": {
    terms: ["account"],
    reason: "the bank account the money sits in, not a sign-in or connected account",
  },
  "cashWords.source.lineBuffer": {
    terms: ["account"],
    reason: "the bank account the money sits in, not a sign-in or connected account",
  },
  "cashWords.source.lineUnknown": {
    terms: ["account"],
    reason: "the bank account the money sits in, not a sign-in or connected account",
  },
  "cashWords.source.lineNone": {
    terms: ["account"],
    reason: "the bank account the money sits in, not a sign-in or connected account",
  },
  "cashWords.tight.sentence": {
    terms: ["account"],
    reason: "an overdrawn bank account, not a sign-in or connected account",
  },
  "stockWords.reorder.arithmetic": {
    terms: ["margin"],
    reason: "a safety margin: spare stock, not a profit margin",
  },
  "stockWords.reorder.arithmeticSeason": {
    terms: ["margin"],
    reason: "a safety margin: spare stock, not a profit margin",
  },
  "pipelineWords.weigh.oneRate": {
    terms: ["proposal"],
    reason: "a sales proposal sent (the stage “Proposal sent”), not one of SYB’s proposals",
  },
  "simulateWords.model.content.worstWeakest": {
    terms: ["review"],
    reason: "the owner’s time reading drafts, not a customer review",
  },
  "simulateWords.model.content.worstNone": {
    terms: ["review"],
    reason: "the owner’s time reading drafts, not a customer review",
  },
  "blindspotsWords.check.team": {
    terms: ["deal"],
    reason: "“who you’ll deal with”: the verb, not a sales deal",
  },
  "reviewsWords.googleRead.permission": {
    terms: ["business"],
    reason: "Google Business Profile: Google's product name, as Google names it in each language",
  },
};

/** Pure: whether English text uses a term — a whole word, any case, a plural ending allowed. */
export function usesTerm(text: string, forms: readonly string[]): boolean {
  return forms.some((f) =>
    new RegExp(`(^|[^\\p{L}])${escape(f)}(s|es)?(?![\\p{L}])`, "iu").test(text),
  );
}

describe("the glossary (rule 2: one term, one translation)", () => {
  it("names a term and its stems in every language, and a register for each", () => {
    expect(GLOSSARY.terms.length).toBeGreaterThan(20);
    for (const term of GLOSSARY.terms) {
      for (const l of OTHERS) {
        const row = term[l] as { term?: string; stems?: string[] } | undefined;
        expect(row?.term, `${term.id} ${l}`).toBeTruthy();
        expect(row?.stems?.length, `${term.id} ${l}`).toBeGreaterThan(0);
      }
    }
    for (const l of OTHERS) expect(GLOSSARY.registers[l], l).toBeTruthy();
    for (const core of ["margin", "break_even", "win_rate", "consent", "proposal", "approval"]) {
      expect(
        GLOSSARY.terms.some((t) => t.id === core),
        core,
      ).toBe(true);
    }
  });

  it("finds whole English words only", () => {
    expect(usesTerm("Similar businesses", ["business"])).toBe(true);
    expect(usesTerm("you@yourbusiness.com", ["business"])).toBe(false);
    expect(usesTerm("shown to you and its reviewer", ["review"])).toBe(false);
    expect(usesTerm("replies to reviews", ["review"])).toBe(true);
  });

  it("uses each language's term wherever English uses the glossary's", () => {
    const misses: string[] = [];
    let checked = 0;
    for (const [k, en] of EN) {
      const text = visibleText(en);
      for (const term of GLOSSARY.terms) {
        if (!usesTerm(text, term.en.match)) continue;
        if (GLOSSARY_EXCEPTIONS[k]?.terms.includes(term.id)) continue;
        for (const l of OTHERS) {
          checked += 1;
          const stems = (term[l] as { stems: string[] }).stems;
          const translated = visibleText(CATALOGUES.get(l)?.get(k) ?? "").toLowerCase();
          if (!stems.some((s) => translated.includes(s.toLowerCase()))) {
            misses.push(`${l} ${k}: "${term.en.term}" needs ${stems.join(" | ")}`);
          }
        }
      }
    }
    expect(misses).toEqual([]);
    // The check has teeth: the shell's English uses glossary terms in dozens of messages.
    // (Six languages' worth; one language alone, CATALOGUE_LOCALE, is a sixth of it.)
    expect(checked).toBeGreaterThan(ONLY === undefined ? 300 : 50);
  });

  it("allows another word only where English uses the term in another sense, and never stale", () => {
    for (const [k, ex] of Object.entries(GLOSSARY_EXCEPTIONS)) {
      const en = EN.get(k);
      expect(en, `${k}: no such message`).toBeDefined();
      expect(ex.reason.length, `${k}: a reason`).toBeGreaterThan(10);
      for (const id of ex.terms) {
        const term = GLOSSARY.terms.find((t) => t.id === id);
        expect(term, `${k}: no glossary term ${id}`).toBeDefined();
        expect(usesTerm(visibleText(en ?? ""), term?.en.match ?? []), `${k}: ${id} unused`).toBe(
          true,
        );
      }
    }
  });

  it("would catch a translation that uses another word for a term (the check itself)", () => {
    const de = new Map(CATALOGUES.get("de-DE"));
    de.set("locale.onlyOwner", "Nur ein Eigentümer kann die Sprache oder Währung ändern.");
    const owner = GLOSSARY.terms.find((t) => t.id === "owner")!;
    const stems = (owner["de-DE"] as { stems: string[] }).stems;
    expect(
      stems.some((s) => visibleText(de.get("locale.onlyOwner")!).toLowerCase().includes(s)),
    ).toBe(false);
  });
});

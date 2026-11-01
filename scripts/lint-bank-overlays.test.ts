// L-2: every rule scripts/lint_bank.py holds the language overlays to, with
// a passing and a failing case each (CLAUDE.md: every rule gets both). A
// small fixture bank and glossary are written to a temporary directory and
// the real linter is run on them — one linter, one truth, as the loader
// runs it (lib/bank/loader.ts lintBank).

import "dotenv/config";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { pythonCommand } from "../lib/bank/loader";

const BANK = {
  bank_version: "0.1.0",
  vocabularies: { yes_no: ["yes", "no"], offer_kind: ["physical", "other"] },
  entity_schemas: {
    offer: {
      label: { en: "Product" },
      fields: [
        { key: "name", prompt: { en: "Name" }, input: { type: "text" }, priority: "core" },
        {
          key: "kind",
          prompt: { en: "Kind" },
          input: { type: "single_select", vocabulary_id: "offer_kind" },
          priority: "core",
        },
      ],
    },
  },
  questions: [
    {
      id: "1.1",
      version: 1,
      section: "identity",
      writes_to: "identity.legal_name",
      prompt: { en: "What is the name of the business?" },
      help_text: { en: "Enter 0 if there is none." },
      input: { type: "text" },
      condition: null,
      priority: "core",
      cost: 1,
    },
    {
      id: "1.2",
      version: 1,
      section: "identity",
      writes_to: "identity.main_supplier",
      prompt: { en: "Which supplier matters most?" },
      input: {
        type: "single_select",
        vocabulary_id: "yes_no",
        option_labels: { yes: { en: "Yes please" } },
      },
      condition: null,
      priority: "core",
      cost: 1,
    },
    {
      id: "3.1",
      version: 1,
      section: "offers",
      writes_to: "offers",
      prompt: { en: "List what you sell." },
      input: { type: "entity_list", entity_schema: "offer" },
      condition: null,
      priority: "core",
      cost: 2,
    },
  ],
};

const GLOSSARY = {
  terms: [
    {
      id: "supplier",
      en: { term: "supplier", match: ["supplier", "suppliers"] },
      "de-DE": { term: "Lieferant", stems: ["lieferant"] },
      "fr-FR": { term: "fournisseur", stems: ["fournisseur"] },
      "zh-Hans": { term: "供应商", stems: ["供应商"] },
    },
  ],
};

type Json = Record<string, unknown>;

const german = (): Json => ({
  locale: "de-DE",
  bank_version: "0.1.0",
  questions: {
    "1.1": {
      prompt: "Wie heißt das Unternehmen?",
      help_text: "Geben Sie 0 ein, wenn es keine gibt.",
    },
    "1.2": { prompt: "Welcher Lieferant ist am wichtigsten?", option_labels: { yes: "Ja, bitte" } },
    "3.1": { prompt: "Was verkaufen Sie?" },
  },
  entity_schemas: { offer: { label: "Produkt", fields: { name: "Bezeichnung", kind: "Art" } } },
  vocabularies: {
    yes_no: { yes: "Ja", no: "Nein" },
    offer_kind: { physical: "Physisch", other: "Sonstiges" },
  },
});

const NNBSP = " ";
const NBSP = " ";
const french = (): Json => ({
  locale: "fr-FR",
  bank_version: "0.1.0",
  questions: {
    "1.1": {
      prompt: `Quel est le nom de l’entreprise${NNBSP}?`,
      help_text: `Indiquez 0${NBSP}: il n’y en a pas.`,
    },
    "1.2": {
      prompt: `Quel fournisseur compte le plus${NNBSP}?`,
      option_labels: { yes: "Oui, merci" },
    },
    "3.1": { prompt: "Indiquez ce que vous vendez." },
  },
  entity_schemas: { offer: { label: "Produit", fields: { name: "Nom", kind: "Genre" } } },
  vocabularies: {
    yes_no: { yes: "Oui", no: "Non" },
    offer_kind: { physical: "Physique", other: "Autre" },
  },
});

const chinese = (): Json => ({
  locale: "zh-Hans",
  bank_version: "0.1.0",
  questions: {
    "1.1": { prompt: "企业叫什么名字？", help_text: "如果没有，请输入 0。" },
    "1.2": { prompt: "哪家供应商最重要？", option_labels: { yes: "好的" } },
    "3.1": { prompt: "列出您销售的产品。" },
  },
  entity_schemas: { offer: { label: "产品", fields: { name: "名称", kind: "类型" } } },
  vocabularies: {
    yes_no: { yes: "是", no: "否" },
    offer_kind: { physical: "实物", other: "其他" },
  },
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Write the fixture bank and the given overlays, run the real linter, return its verdict. */
function lint(
  overlays: Record<string, Json | string>,
  opts: { locales?: string; require?: boolean } = {},
): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "lint-overlay-"));
  dirs.push(dir);
  const bank = join(dir, "bank.json");
  writeFileSync(bank, JSON.stringify(BANK));
  writeFileSync(join(dir, "glossary.json"), JSON.stringify(GLOSSARY));
  for (const [locale, body] of Object.entries(overlays)) {
    writeFileSync(
      join(dir, `bank.${locale}.json`),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  }
  const args = [
    "scripts/lint_bank.py",
    bank,
    "--glossary",
    join(dir, "glossary.json"),
    "--locales",
    opts.locales ?? "en,de-DE,fr-FR,zh-Hans",
    ...(opts.require ? ["--require-overlays"] : []),
  ];
  try {
    const out = execFileSync(pythonCommand(), args, {
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    return { ok: true, out };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** A deep copy with one change. */
function edit(base: Json, change: (o: Json) => void): Json {
  const o = JSON.parse(JSON.stringify(base)) as Json;
  change(o);
  return o;
}
type Q = Record<string, Record<string, unknown>>;
const qs = (o: Json): Q => o.questions as Q;
const vocab = (o: Json): Record<string, Record<string, string>> =>
  o.vocabularies as Record<string, Record<string, string>>;

function fails(result: { ok: boolean; out: string }, rule: string): void {
  expect(result.ok, result.out).toBe(false);
  expect(result.out).toContain(`${rule}:`);
}

describe("the overlay fixtures themselves are clean", () => {
  it("passes German, French and Chinese overlays that keep every rule", () => {
    const r = lint(
      { "de-DE": german(), "fr-FR": french(), "zh-Hans": chinese() },
      { require: true },
    );
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toContain("overlays: de-DE, fr-FR, zh-Hans");
    expect(r.out).toContain("12 strings to translate");
  });

  it("passes a scratch bank with no overlays at all when none is required", () => {
    expect(lint({}).ok).toBe(true);
  });
});

describe("each rule, failing", () => {
  it("overlay_missing_locale: a required language has no file", () => {
    fails(
      lint({ "de-DE": german() }, { require: true, locales: "en,de-DE,fr-FR" }),
      "overlay_missing_locale",
    );
  });

  it("overlay_unknown_locale: a file for a language the app doesn't speak", () => {
    fails(
      lint({ "de-DE": german(), "pt-BR": german() }, { locales: "en,de-DE" }),
      "overlay_unknown_locale",
    );
  });

  it("overlay_invalid_json", () => {
    fails(lint({ "de-DE": "{ not json" }), "overlay_invalid_json");
  });

  it("overlay_locale_mismatch: the file names another language", () => {
    fails(lint({ "de-DE": { ...german(), locale: "fr-FR" } }), "overlay_locale_mismatch");
  });

  it("overlay_bank_version_mismatch: words written for another bank version", () => {
    fails(
      lint({ "de-DE": { ...german(), bank_version: "0.0.9" } }),
      "overlay_bank_version_mismatch",
    );
  });

  it("overlay_missing_string: a string of the bank left out", () => {
    const o = edit(german(), (x) => delete qs(x)["1.1"]!.help_text);
    fails(lint({ "de-DE": o }), "overlay_missing_string");
  });

  it("overlay_unknown_id: words for a question the bank doesn't have", () => {
    const o = edit(german(), (x) => (qs(x)["9.9"] = { prompt: "Gibt es nicht" }));
    fails(lint({ "de-DE": o }), "overlay_unknown_id");
  });

  it("overlay_not_words: structure (a condition) in an overlay", () => {
    const o = edit(german(), (x) => (qs(x)["1.2"]!.condition = { op: "answered", field: "x" }));
    fails(lint({ "de-DE": o }), "overlay_not_words");
    fails(lint({ "de-DE": { ...german(), writes_to: "identity" } }), "overlay_not_words");
  });

  it("overlay_empty_string and overlay_untrimmed_string", () => {
    fails(
      lint({ "de-DE": edit(german(), (x) => (qs(x)["3.1"]!.prompt = " ")) }),
      "overlay_empty_string",
    );
    fails(
      lint({ "de-DE": edit(german(), (x) => (qs(x)["3.1"]!.prompt = "Was verkaufen Sie? ")) }),
      "overlay_untrimmed_string",
    );
  });

  it("overlay_figure_mismatch: a digit of the English dropped or changed", () => {
    const o = edit(
      german(),
      (x) => (qs(x)["1.1"]!.help_text = "Geben Sie nichts ein, wenn es keine gibt."),
    );
    fails(lint({ "de-DE": o }), "overlay_figure_mismatch");
    const p = edit(
      german(),
      (x) => (qs(x)["1.1"]!.help_text = "Geben Sie 1 ein, wenn es keine gibt."),
    );
    fails(lint({ "de-DE": p }), "overlay_figure_mismatch");
  });

  it("overlay_placeholder_mismatch: a {placeholder} English doesn't have", () => {
    const o = edit(german(), (x) => (qs(x)["3.1"]!.prompt = "Was verkauft {name}?"));
    fails(lint({ "de-DE": o }), "overlay_placeholder_mismatch");
  });

  it("overlay_currency_sign: a currency sign typed into the words", () => {
    const o = edit(german(), (x) => (qs(x)["3.1"]!.prompt = "Was verkaufen Sie in €?"));
    fails(lint({ "de-DE": o }), "overlay_currency_sign");
  });

  it("overlay_same_as_english: a string left in English", () => {
    const o = edit(german(), (x) => (vocab(x).yes_no!.yes = "Yes"));
    fails(lint({ "de-DE": o }), "overlay_same_as_english");
  });

  it("overlay_glossary_term: a glossary term translated another way", () => {
    const o = edit(
      german(),
      (x) => (qs(x)["1.2"]!.prompt = "Welcher Zulieferbetrieb ist am wichtigsten?"),
    );
    const r = lint({ "de-DE": o });
    fails(r, "overlay_glossary_term");
    expect(r.out).toContain('"supplier" needs lieferant');
  });

  it("overlay_typography: French spacing and Chinese punctuation", () => {
    const fr = edit(french(), (x) => (qs(x)["1.1"]!.prompt = "Quel est le nom de l’entreprise ?"));
    fails(lint({ "fr-FR": fr }), "overlay_typography");
    const colon = edit(french(), (x) => (qs(x)["1.1"]!.help_text = "Indiquez 0: il n’y en a pas."));
    fails(lint({ "fr-FR": colon }), "overlay_typography");
    const zh = edit(chinese(), (x) => (qs(x)["1.1"]!.prompt = "企业叫什么名字?"));
    fails(lint({ "zh-Hans": zh }), "overlay_typography");
    const spacing = edit(chinese(), (x) => (qs(x)["1.1"]!.help_text = "如果没有，请输入0。"));
    fails(lint({ "zh-Hans": spacing }), "overlay_typography");
  });
});

describe("each allowance, passing — and failing once it goes stale", () => {
  it("same_as_english lets a real cognate equal English, with its reason", () => {
    const o = edit(german(), (x) => {
      vocab(x).yes_no!.yes = "Yes";
      x.same_as_english = { "vocabularies/yes_no/yes": "fixture cognate" };
    });
    expect(lint({ "de-DE": o }).ok).toBe(true);
  });

  it("overlay_same_as_english_stale: a listed key that no longer equals English", () => {
    const o = { ...german(), same_as_english: { "vocabularies/yes_no/yes": "fixture cognate" } };
    fails(lint({ "de-DE": o }), "overlay_same_as_english_stale");
  });

  it("a name or acronym needs no allowance", () => {
    const bank = edit(german(), (x) => (vocab(x).offer_kind!.other = "Other"));
    // "Other" is English, not a name: refused.
    fails(lint({ "de-DE": bank }), "overlay_same_as_english");
  });

  it("glossary_exceptions lets the English word in another sense go untranslated as the term", () => {
    const o = edit(german(), (x) => {
      qs(x)["1.2"]!.prompt = "Welcher Zulieferbetrieb ist am wichtigsten?";
      x.glossary_exceptions = { "questions/1.2/prompt": { supplier: "fixture: another sense" } };
    });
    expect(lint({ "de-DE": o }).ok).toBe(true);
  });

  it("overlay_glossary_exception_stale: an exception for a term the English doesn't use", () => {
    const o = {
      ...german(),
      glossary_exceptions: { "questions/1.1/prompt": { supplier: "stale" } },
    };
    fails(lint({ "de-DE": o }), "overlay_glossary_exception_stale");
  });
});

describe("the real bank", () => {
  it("lints clean with all six overlays, as CI runs it", () => {
    const out = execFileSync(pythonCommand(), ["scripts/lint_bank.py"], {
      encoding: "utf8",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });
    expect(out).toContain("712 strings to translate");
    expect(out).toContain("overlays: de-DE, es-ES, fr-FR, hu-HU, ru-RU, zh-Hans");
  });
});

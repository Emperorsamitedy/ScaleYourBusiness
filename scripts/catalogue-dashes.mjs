#!/usr/bin/env node
/* global process, console */
// The catalogues hold no em dash and no en dash (the owner, 2026-11-18: "no
// em and en dashes throughout the app"; docs/DASHBOARD-OVERHAUL.md, L7, and
// messages/catalogue.test.ts holds it). This is the rule set that rewrote
// them, kept so that strings arriving later (a merge from another branch, a
// new screen's words) can be put through the same rules:
//
//   node scripts/catalogue-dashes.mjs            what would change, per language
//   node scripts/catalogue-dashes.mjs list       every string, before and after
//   node scripts/catalogue-dashes.mjs apply      rewrite the seven catalogues
//
// It only touches a string that still holds a dash, so running it twice
// changes nothing. Read what it proposes before applying: a rule can read
// badly, and scripts/catalogue-dashes.overrides.json is where a string, or
// the choice at each of its dashes, is set by hand.
//
// How it decides. English first, dash by dash:
//   an en dash                          a range: "to"
//   "Cash flow — ScaleX"                a page's title: a middle dot
//   two dashes around an aside          brackets
//   before "and", "but", "with", a      a trailing clause: a comma
//     past participle …
//   before "it", "nothing", "try" …     a new sentence: a full stop, and a capital
//   anything else                       an explanation: a colon (a comma if
//                                       the sentence already has one)
// Every other language follows English's choice at the same dash, with its
// own punctuation: the French colon keeps its no-break space, Chinese its
// full-width marks, and a range is "bis", "a", "à", or a hyphen in Hungarian
// and Russian, whose word for it would bend the nouns around it. Where a
// language has a dash and English had none, its own default applies; Russian
// keeps that dash, because Russian has no "is" and writes one there.
//
// Not touched: the landing page (the owner: it "can stay as it is") and the
// legal texts.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "..", "messages");
const LOCALES = ["en", "de-DE", "es-ES", "fr-FR", "hu-HU", "ru-RU", "zh-Hans"];
const SKIP_NS = new Set(["landing", "landingV2", "legal"]);
const OVERRIDES_FILE = join(HERE, "catalogue-dashes.overrides.json");
const OVERRIDES = existsSync(OVERRIDES_FILE)
  ? JSON.parse(readFileSync(OVERRIDES_FILE, "utf8"))
  : {};

const load = (l) => JSON.parse(readFileSync(join(DIR, `${l}.json`), "utf8"));
const flat = (o, p, out) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === "object") flat(v, key, out);
    else out.set(key, String(v));
  }
  return out;
};
const setDeep = (o, key, value) => {
  const parts = key.split(".");
  let at = o;
  for (const part of parts.slice(0, -1)) at = at[part];
  at[parts[parts.length - 1]] = value;
};

/** Words after which a dash was only a pause: a comma does it. */
const EN_COMMA = new Set(
  "and or but so nor yet not never then even including plus with without which who whose where until unless except because since while if when as for to by from in on at after before over under per still just also both either neither rather instead otherwise however though although whether than like unlike via through across between among within during despite beyond".split(
    " ",
  ),
);
/** Words that start a sentence of their own: a full stop does it. */
const EN_STOP = new Set(
  "it its it's this that these those they their them we our you your i i'll i've i'm nothing none everything anything something each every there here no try refresh pick say choose read add open sign treat weigh begin answer state see check use paste connect ask set tell wait come go start import approve decline review press click tap type enter keep leave turn make take give put send let don't do does did can can't could will won't would should must may might is are was were has have had".split(
    " ",
  ),
);
/** Words that open a clause which either trails the sentence or starts a new one. */
const EN_SUB = new Set(
  "once if when while because since as after before until unless though although whether".split(
    " ",
  ),
);

/** A page's title: "Cash flow — ScaleX". */
const isTitle = (t) => / [—–] ScaleX$/.test(t) || /^ScaleX [—–] /.test(t);
/** A message with its simple placeholders blanked, so a brace left over is a plural or select branch. */
const plainOf = (t) => t.replace(/\{\w+\}/g, "X");
/** The sentence a position sits in, inside its own branch. */
const sentenceAt = (soFar) => {
  const plain = plainOf(soFar);
  return plain.slice(
    Math.max(
      plain.lastIndexOf(". "),
      plain.lastIndexOf("? "),
      plain.lastIndexOf("! "),
      plain.lastIndexOf("。"),
      plain.lastIndexOf("{"),
      plain.lastIndexOf("}"),
    ) + 1,
  );
};

function joinFor(locale, d, raw = " — ") {
  const spaced = /\s/.test(raw);
  const zh = locale === "zh-Hans";
  const fr = locale === "fr-FR";
  switch (d) {
    case "to":
      if (locale === "en") return " to ";
      if (locale === "de-DE") return " bis ";
      if (locale === "es-ES") return " a ";
      if (fr) return " à ";
      if (zh) return spaced ? " 至 " : "-";
      // Hungarian and Russian: a word would need the nouns around it in another case.
      return spaced ? " - " : "-";
    case "dot":
      return " · ";
    case "hyphen":
      return "-";
    case "po":
      return zh ? "（" : " (";
    case "pc":
      return zh ? "）" : ") ";
    case "comma":
    case "lead":
      return zh ? "，" : ", ";
    case "stop":
      return zh ? "。" : ". ";
    case "colon":
    case "colonlead":
      return zh ? "：" : fr ? "\u00a0: " : ": ";
    case "semi":
      return zh ? "；" : fr ? " ; " : "; ";
    case "strip":
      return "";
    case "glyph":
      // The dash is the thing shown ("so it shows -"): it keeps its spaces.
      return raw.replace(/—+|–/, "-");
    case "bullet":
      return "- ";
    default:
      throw new Error(`no join for ${d}`);
  }
}

/** English: the text without its dashes, and the choice made at each one, in order. */
function english(s) {
  if (s.trim() === "—" || s.trim() === "–") {
    return { text: s.replace(/[—–]/, "-"), decisions: ["hyphen"] };
  }
  // "— choose when —": a select's placeholder.
  const wrapped = /^— (.+) —$/.exec(s);
  if (wrapped) {
    const inner = wrapped[1];
    return { text: inner.charAt(0).toUpperCase() + inner.slice(1), decisions: ["strip", "strip"] };
  }
  let text = s;
  const marks = [];
  const re = /\s*([—–])\s*/g;
  let m;
  while ((m = re.exec(text))) marks.push({ at: m.index, len: m[0].length, ch: m[1], raw: m[0] });
  // Two em dashes around an aside inside one sentence, never across a plural or select branch.
  for (let k = 0; k + 1 < marks.length; k++) {
    const a = marks[k];
    const b = marks[k + 1];
    if (a.ch !== "—" || b.ch !== "—" || a.pair) continue;
    const between = text.slice(a.at + a.len, b.at);
    const after = text.slice(b.at + b.len);
    const inOneBranch = !/[{}]/.test(plainOf(between));
    if (inOneBranch && between.length <= 90 && !/[.!?]/.test(between) && after.trim().length > 0) {
      a.pair = "po";
      b.pair = "pc";
    }
  }
  const decisions = [];
  const out = [];
  let i = 0;
  for (const mk of marks) {
    out.push(text.slice(i, mk.at));
    const rest = text.slice(mk.at + mk.len);
    const soFar = out.join("");
    let d;
    if (mk.ch === "–") d = "to";
    else if (isTitle(text)) d = "dot";
    else if (mk.pair) d = mk.pair;
    else if (soFar.trim() === "") d = "lead";
    else {
      const word = (/^[“"'‘(]*([A-Za-z’']+)/.exec(rest) || [])[1];
      const lower = word ? word.toLowerCase().replace(/’/g, "'") : "";
      const startsLower = word ? word[0] === word[0].toLowerCase() : false;
      const sentence = sentenceAt(soFar);
      const restSentence = plainOf(rest).split(/[.!?}]/)[0];
      const endsWithStop = /[.!?]["”’)]?\s*$/.test(text);
      if (/^(Yes|No)$/.test(soFar.trim())) d = "comma";
      else if (!word) d = /: /.test(sentence) ? "comma" : "colon";
      else if (startsLower && EN_SUB.has(lower)) {
        d = /, /.test(restSentence) && endsWithStop ? "stop" : "comma";
      } else if (startsLower && EN_COMMA.has(lower)) d = "comma";
      // A participle after the dash carries the sentence on.
      else if (startsLower && /ed$/.test(lower) && lower.length > 4 && !EN_STOP.has(lower)) {
        d = "comma";
      }
      // A gerund after the dash is the subject of a new sentence ("declining asks why").
      else if (
        startsLower &&
        /ing$/.test(lower) &&
        lower.length > 5 &&
        endsWithStop &&
        / /.test(restSentence.trim())
      ) {
        d = "stop";
      } else if (EN_STOP.has(lower) && endsWithStop) d = "stop";
      else if (/: /.test(sentence)) d = "comma";
      else d = "colon";
    }
    decisions.push(d);
    out.push(joinFor("en", d, mk.raw));
    i = mk.at + mk.len;
    if (d === "stop") {
      // The next sentence starts with a capital.
      const cap = text.slice(i).replace(/^([“"'‘(]*)([a-z])/, (_, q, c) => q + c.toUpperCase());
      text = text.slice(0, i) + cap;
    }
  }
  out.push(text.slice(i));
  return { text: out.join(""), decisions };
}

/** Another language, following English's choice dash for dash. */
function follow(locale, s, enDecisions) {
  const marks = [];
  const re = /\s*(——|[—–])\s*/g;
  let m;
  while ((m = re.exec(s))) marks.push({ at: m.index, len: m[0].length, ch: m[1], raw: m[0] });
  if (marks.length === 0) return { text: s, rule: "none" };
  if (s.trim() === "—" || s.trim() === "–") {
    return { text: s.replace(/[—–]/, "-"), rule: "hyphen" };
  }
  const wrapped = /^[—–] (.+) [—–]$/.exec(s);
  if (wrapped) {
    return { text: wrapped[1].charAt(0).toUpperCase() + wrapped[1].slice(1), rule: "strip" };
  }
  const isRange = (mk) =>
    mk.ch === "–" &&
    (!/\s/.test(mk.raw) ||
      (/[}\d%]$/.test(s.slice(0, mk.at)) && /^[{\d+−<]/.test(s.slice(mk.at + mk.len))));
  let decisions = enDecisions && enDecisions.length === marks.length ? enDecisions : null;
  // A language with another number of plural forms than English still follows it.
  if (
    !decisions &&
    enDecisions &&
    enDecisions.length > 0 &&
    enDecisions.every((d) => d === enDecisions[0]) &&
    /\{\w+, (plural|select),/.test(s)
  ) {
    decisions = marks.map(() => enDecisions[0]);
  }
  let rule = decisions ? "follows English" : "own default";
  if (!decisions) {
    if (locale === "ru-RU") {
      // Russian keeps the dash its grammar needs; a range still loses its dash.
      decisions = marks.map((mk) => (isRange(mk) ? "to" : "keep"));
      rule = decisions.includes("to") ? "ranges only" : "kept (grammar)";
    } else {
      decisions = marks.map((mk) => {
        const rest = s.slice(mk.at + mk.len);
        if (isRange(mk)) return "to";
        // A dash that stands for itself ("it shows —.") keeps its place.
        if (/^[.,;:!?)»”]/.test(rest) || rest.trim() === "") return "glyph";
        if (isTitle(s)) return "dot";
        if (/^\p{Lu}/u.test(rest) && /[.!?]\s*$/.test(s) && locale !== "de-DE") return "stop";
        return "comma";
      });
    }
  }
  let out = "";
  let i = 0;
  let text = s;
  for (const [k, mk] of marks.entries()) {
    let d = decisions[k];
    const rest = text.slice(mk.at + mk.len);
    out += text.slice(i, mk.at);
    i = mk.at + mk.len;
    if (d === "keep") {
      out += mk.raw;
      continue;
    }
    if (d !== "glyph" && /^[.,;:!?)»”。，]/.test(rest)) d = "glyph";
    // No sentence gets two colons.
    if (d === "colon" && /:\s|：|\u00a0:/.test(sentenceAt(out))) d = "semi";
    // A full stop needs a letter to capitalise after it; a placeholder or a tag takes a colon.
    if (d === "stop" && locale !== "zh-Hans" && !/^[«“"'‘(„]*\p{L}/u.test(rest)) d = "colon";
    if (d === "lead" && out.trim() !== "") d = "comma";
    // ", —" is one mark: the comma goes with the dash.
    if (d !== "glyph" && d !== "to" && /[,，]\s*$/.test(out)) out = out.replace(/[,，]\s*$/, "");
    out += joinFor(locale, d, mk.raw);
    if (d === "stop" && locale !== "zh-Hans") {
      const cap = text
        .slice(i)
        .replace(/^([«“"'‘(„]*)(\p{Ll})/u, (_, q, c) => q + c.toLocaleUpperCase(locale));
      text = text.slice(0, i) + cap;
    }
  }
  out += text.slice(i);
  if (decisions[0] === "colonlead") out = out.replace(/^\s+/, "");
  return { text: out, rule };
}

const tidy = (s) =>
  s
    .replace(/ \) /g, ") ")
    .replace(/\) ([.,;:!?])/g, ")$1")
    .replace(/ {2,}/g, " ")
    .replace(/ ([,.;])(\s|$)/g, "$1$2");

/** Every string that would change, per language: [key, before, after, rule]. */
export function plan() {
  const EN = flat(load("en"), "", new Map());
  const enDecisions = new Map();
  const results = new Map(LOCALES.map((l) => [l, []]));
  // The choices English made stay on record for strings English no longer needs rewritten.
  for (const [key, d] of Object.entries(OVERRIDES.decisions ?? {})) enDecisions.set(key, d);
  for (const [key, s] of EN) {
    if (SKIP_NS.has(key.split(".")[0]) || !/[—–]/.test(s)) continue;
    const r = english(s);
    if (!enDecisions.has(key)) enDecisions.set(key, r.decisions);
    const byHand = OVERRIDES.en?.[key];
    results
      .get("en")
      .push([key, s, byHand ?? tidy(r.text), byHand ? "by hand" : r.decisions.join("+")]);
  }
  for (const l of LOCALES.slice(1)) {
    for (const [key, s] of flat(load(l), "", new Map())) {
      if (SKIP_NS.has(key.split(".")[0]) || !/[—–]/.test(s)) continue;
      const byHand = OVERRIDES[l]?.[key];
      if (byHand !== undefined) {
        results.get(l).push([key, s, byHand, "by hand"]);
        continue;
      }
      const r = follow(l, s, enDecisions.get(key));
      if (tidy(r.text) !== s) results.get(l).push([key, s, tidy(r.text), r.rule]);
    }
  }
  return results;
}

if (
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("catalogue-dashes.mjs")
) {
  const mode = process.argv[2] ?? "summary";
  const results = plan();
  for (const l of LOCALES) {
    const rows = results.get(l);
    if (mode === "list") {
      for (const [k, a, b, rule] of rows) console.log(`${l} ${k} [${rule}]\n  - ${a}\n  + ${b}`);
    }
    if (mode === "apply" && rows.length > 0) {
      const tree = load(l);
      for (const [key, , after] of rows) setDeep(tree, key, after);
      writeFileSync(join(DIR, `${l}.json`), `${JSON.stringify(tree, null, 2)}\n`);
    }
    console.log(`${l}: ${rows.length} ${mode === "apply" ? "rewritten" : "would change"}`);
  }
}

// Guided page set-up: the kit. Pure.
//
// An owner with no Facebook Page or Instagram business account has to make
// them on the platforms' own sites: no app may create or claim a Page for a
// person (Meta's Developer Policies 11.5), and ScaleX never asks for a
// platform password. What ScaleX can do is hand over what to type, taken
// from the business's own fact sheet, so the owner is not inventing a bio at
// a blank form (specs/page-setup-v1.md).
//
// Every piece of the kit says where it came from (rule 2). The two that are
// worked out, the short line and the username idea, say how (rule 6). A fact
// the fact sheet does not hold is a gap, named with the interview question
// that fills it (rule 5), never a made-up value. Nothing here calls a model:
// the words are the owner's own.
//
// The platforms' field limits were not read on their own pages
// (specs/page-setup-v1.md, "What the fields may hold"), so the kit states no
// limit. It keeps what it prepares inside the smallest figure anyone
// reports, so the text fits whichever is true.

/** The short line fits a Page's bio and an Instagram bio by the smallest limit reported for either. */
export const SHORT_LINE_MAX = 100;
/** A username idea is at most this long, the limit reported for Instagram. */
export const USERNAME_MAX = 30;

/** The facts the kit reads, as the fact sheet holds them (answered values only; null when not). */
export interface KitFacts {
  /** identity.legal_name */
  name: string | null;
  /** identity.description: what the business does, in the owner's words. */
  description: string | null;
  /** identity.business_type, as words in the reader's language. */
  business_type: string | null;
  /** presence.website_url */
  website: string | null;
}

export const KIT_FIELDS = {
  name: { field: "identity.legal_name", question: "1.1" },
  description: { field: "identity.description", question: "1.3" },
  business_type: { field: "identity.business_type", question: "1.2" },
  website: { field: "presence.website_url", question: "2.1.2.1" },
} as const;

export type KitFactKey = keyof typeof KIT_FIELDS;

/** A piece of the kit that is the owner's own answer, as given. */
export interface StatedPiece {
  value: string;
  /** The fact it is: its key on the fact sheet. */
  source_field: string;
}

/** A piece of the kit worked out from an answer: from which, and how (rule 6). */
export interface DerivedPiece {
  value: string;
  derived_from: string;
  /** How it was worked out, as a code the screen words in the reader's language. */
  formula: "first_sentence" | "cut_at_clause" | "cut_at_word" | "as_given" | "handle";
}

/** A fact the kit needs and the fact sheet does not hold. */
export interface KitGap {
  key: KitFactKey;
  field: string;
  /** The interview question that fills it. */
  question: string;
}

export interface PageKit {
  /** The Page's name: the business's name as the owner gave it. */
  name: StatedPiece | null;
  /** What to look for in the platform's list of categories: the business type, in words. */
  category_hint: StatedPiece | null;
  /** One short line for a bio, from what the owner said the business does. */
  short_line: DerivedPiece | null;
  /** The longer description, for a Page's "About": the owner's answer whole. */
  about: StatedPiece | null;
  website: StatedPiece | null;
  /** An idea for the @name. A suggestion: the platform may have given it to someone else. */
  username: DerivedPiece | null;
  /** What to answer first. The website is optional and is never a gap. */
  gaps: KitGap[];
}

const clean = (v: string | null): string | null => {
  const text = (v ?? "").replace(/\s+/g, " ").trim();
  return text === "" ? null : text;
};

/**
 * One short line from a longer answer, at most `max` characters. The first
 * sentence when it fits; else the text up to its last clause break that
 * fits; else up to its last whole word. Never a word cut in half and never
 * an ellipsis: a bio that trails off reads as unfinished.
 */
export function shortLine(
  text: string,
  max: number = SHORT_LINE_MAX,
): { value: string; formula: DerivedPiece["formula"] } | null {
  const whole = clean(text);
  if (whole === null) return null;
  const tidy = (s: string) => s.replace(/[\s,;:(–—-]+$/u, "").trim();
  if (whole.length <= max) return { value: whole, formula: "as_given" };

  // The first sentence: up to the first stop that ends one. Four words at
  // least, so a stop inside an abbreviation ("We sell e.g. …") is not taken
  // for the end of one.
  const stop = whole.search(/[.!?](\s|$)/u);
  if (stop >= 0 && stop + 1 <= max) {
    const first = whole.slice(0, stop + 1).trim();
    if (first.split(" ").length >= 4) return { value: first, formula: "first_sentence" };
  }
  const head = whole.slice(0, max + 1);
  // A clause break: a comma, a semicolon, a colon or a dash, far enough in to say something.
  const clause = Math.max(
    head.lastIndexOf(", "),
    head.lastIndexOf("; "),
    head.lastIndexOf(": "),
    head.lastIndexOf(" – "),
    head.lastIndexOf(" - "),
  );
  if (clause >= Math.floor(max * 0.4)) {
    return { value: tidy(whole.slice(0, clause)), formula: "cut_at_clause" };
  }
  const word = head.lastIndexOf(" ");
  if (word > 0) return { value: tidy(whole.slice(0, word)), formula: "cut_at_word" };
  // One unbroken run longer than the limit: nothing short can be made of it honestly.
  return null;
}

/** Letters a decomposition does not split, as the letters people type instead. */
const PLAIN: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ł: "l",
  þ: "th",
  ð: "d",
  ı: "i",
};

/**
 * An idea for the @name from the business's name: lower case, accents
 * dropped, anything that is not a letter or a number as one full stop, at
 * most USERNAME_MAX characters, cut at a full stop when it has to be cut.
 * Null when nothing in Latin letters is left (a name written in another
 * script): the owner picks one themselves.
 */
export function usernameIdea(name: string, max: number = USERNAME_MAX): string | null {
  const lower = (clean(name) ?? "").toLowerCase();
  const plain = [...lower.normalize("NFD")]
    .map((ch) => PLAIN[ch] ?? ch)
    .join("")
    .replace(/\p{M}+/gu, "");
  let handle = plain
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
  if (handle.length > max) {
    const cut = handle.slice(0, max + 1).lastIndexOf(".");
    handle = (cut >= 3 ? handle.slice(0, cut) : handle.slice(0, max)).replace(/\.+$/g, "");
  }
  return handle.length >= 3 ? handle : null;
}

/** The kit for one business, from what its fact sheet holds. */
export function pageKit(facts: KitFacts): PageKit {
  const name = clean(facts.name);
  const description = clean(facts.description);
  const type = clean(facts.business_type);
  const website = clean(facts.website);

  const short = description === null ? null : shortLine(description);
  const handle = name === null ? null : usernameIdea(name);

  const gaps: KitGap[] = [];
  const need = (key: KitFactKey, missing: boolean) => {
    if (missing) gaps.push({ key, ...KIT_FIELDS[key] });
  };
  need("name", name === null);
  need("business_type", type === null);
  need("description", description === null);

  return {
    name: name === null ? null : { value: name, source_field: KIT_FIELDS.name.field },
    category_hint:
      type === null ? null : { value: type, source_field: KIT_FIELDS.business_type.field },
    short_line:
      short === null
        ? null
        : {
            value: short.value,
            derived_from: KIT_FIELDS.description.field,
            formula: short.formula,
          },
    about:
      description === null
        ? null
        : { value: description, source_field: KIT_FIELDS.description.field },
    website: website === null ? null : { value: website, source_field: KIT_FIELDS.website.field },
    username:
      handle === null
        ? null
        : { value: handle, derived_from: KIT_FIELDS.name.field, formula: "handle" },
    gaps,
  };
}

/** Where the owner does each step: the platforms' own pages (specs/page-setup-v1.md). */
export const PAGE_SETUP_LINKS = {
  /** Meta's own guide, "Create a Facebook Page for your business". */
  facebook_guide: "https://www.facebook.com/business/help/473994396650734",
  /** Instagram's Help Centre guide to a business account. */
  instagram_guide: "https://help.instagram.com/502981923235522",
} as const;

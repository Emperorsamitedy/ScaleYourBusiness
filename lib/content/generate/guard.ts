// The likeness and brand screen — P3-53. Session K is NOT generating a
// real person's likeness or voice, or imitating a named brand.
//
// Deterministic, and conservative by design: a screen on the words of the
// prompt, not a classifier, so it refuses by rule and says which rule. It
// would rather refuse a harmless prompt ("featuring Anna Kovacs" could be
// a cake) than let a real person or a logo through; the owner can reword,
// or film it. The provider is told the same thing on every request
// (FIXED_INSTRUCTION) as the second line.
//
// What it refuses:
//   - asking for a person who is real: celebrity / public-figure / likeness
//     words, "looks like <Name>", "starring <First Last>", titles before a
//     name, @handles, and the business's own people ("my face", "our
//     staff", "a real customer") — they are real too
//   - asking for a brand: logo / trademark / wordmark words, ™ ® ©, a
//     short list of the world's most-imitated brands, and every competitor
//     the owner named in their profile

export type GuardVerdict = { ok: true } | { ok: false; reason: string; matched: string };

const LIKENESS: readonly { re: RegExp; why: string }[] = [
  {
    re: /\b(celebrit(?:y|ies)|public figures?|famous (?:person|people|actor|actress|singer|athlete|footballer|chef|influencer)|look-?alikes?|likeness(?:es)?|deep ?fakes?|impersonat\w*|face ?swap\w*)\b/i,
    why: "it asks for a real person's likeness",
  },
  {
    re: /\b(?:looks?|looking|dressed|styled) (?:just )?like [A-Z][\p{L}'-]+/u,
    why: "it asks for someone's look by name",
  },
  {
    re: /\b(?:starring|featuring|played by|voiced by|portrait of|photo of|picture of|image of|video of) [A-Z][\p{L}'-]+ [A-Z][\p{L}'-]+/u,
    why: "it names a person to show",
  },
  {
    re: /\b(?:President|Prime Minister|Senator|Pope|King|Queen|Prince|Princess|Chancellor|Mayor|Sir|Dame) [A-Z][\p{L}'-]+/u,
    why: "it names a public figure",
  },
  { re: /(?:^|\s)@[A-Za-z0-9_.]{2,}/, why: "it names a real account" },
  {
    re: /\b(?:my|our) (?:own )?(?:face|faces|staff|team|employees?|customers?|clients?|husband|wife|partner|son|daughter|kids?|children|family|mum|mom|dad)\b|\bof me\b|\bselfies?\b|\breal (?:customers?|people|person)\b/i,
    why: "it asks to show a real person — the business's own people are real too; film them, with their permission",
  },
];

const BRAND_WORDS =
  /\b(logos?|trademark(?:ed|s)?|wordmarks?|brand ?marks?|brand(?:ed)? packaging|mascots?)\b|[™®©]/i;

/**
 * The world's most-imitated brands — a floor, not a list of every brand.
 * The platforms SYB posts to (Instagram, Facebook) are left out: a caption
 * saying "follow us on Instagram" is not asking for their logo.
 */
export const FAMOUS_BRANDS: readonly string[] = [
  "Adidas",
  "Airbnb",
  "Amazon",
  "Apple",
  "Barbie",
  "BMW",
  "Burberry",
  "Chanel",
  "Coca-Cola",
  "Coke",
  "Dior",
  "Disney",
  "Ferrari",
  "Gucci",
  "H&M",
  "Heineken",
  "Hermès",
  "IKEA",
  "Lego",
  "Louis Vuitton",
  "Lululemon",
  "Marvel",
  "McDonald's",
  "Mercedes",
  "Microsoft",
  "Nestlé",
  "Netflix",
  "Nike",
  "Nintendo",
  "Pepsi",
  "Pixar",
  "Pokémon",
  "Prada",
  "Puma",
  "Red Bull",
  "Rolex",
  "Samsung",
  "Sony",
  "Starbucks",
  "Supreme",
  "Tesla",
  "Uniqlo",
  "Versace",
  "Zara",
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A whole-word, case-insensitive match that also works for names with & or '. */
function mentions(text: string, name: string): boolean {
  const n = name.normalize("NFKC").trim();
  if (n.length < 3) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(n)}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

/**
 * Pure: may this prompt go to a generation provider? `brands` adds names
 * to refuse — the owner's listed competitors (never imitate a competitor).
 */
export function screenPrompt(prompt: string, brands: readonly string[] = []): GuardVerdict {
  const text = prompt.normalize("NFKC").replace(/\s+/g, " ");
  for (const rule of LIKENESS) {
    const m = rule.re.exec(text);
    if (m) return { ok: false, reason: rule.why, matched: m[0].trim() };
  }
  // ™ is checked before NFKC too: normalisation spells it "TM".
  const b = BRAND_WORDS.exec(text) ?? /[™®©]/.exec(prompt);
  if (b) return { ok: false, reason: "it asks for a logo or a trademark", matched: b[0] };
  for (const name of FAMOUS_BRANDS) {
    if (mentions(text, name)) {
      return { ok: false, reason: "it names a brand ScaleX won't imitate", matched: name };
    }
  }
  for (const name of brands) {
    if (mentions(text, name)) {
      return { ok: false, reason: "it names one of your competitors", matched: name.trim() };
    }
  }
  return { ok: true };
}

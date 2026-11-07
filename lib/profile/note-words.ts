// Display only: a measured fact's note and method as an owner reads them.
// The stored text keeps its ISO days and provider ids (other languages read
// it back by shape, lib/watch/words); these helpers word it on the way out.
// Pure: no database, so the cash and benchmark inputs can use it too.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The ISO days a measured fact's method and note carry ("imported
 * 2026-11-07, over 2026-10-10..2026-11-06") as an owner reads them
 * ("imported 7 Nov 2026, over 10 Oct 2026 to 6 Nov 2026"). A timestamp
 * ("2026-11-07T09:00") and anything else is left as it is.
 */
export function datesInWords(text: string | null): string | null {
  if (text === null) return null;
  return text
    .replace(/\b(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})\b/g, "$1 to $2")
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b(?![T:\d])/g, (whole, y: string, m: string, d: string) => {
      const month = MONTHS[Number(m) - 1];
      return month ? `${Number(d)} ${month} ${y}` : whole;
    });
}

/** The provider ids the connectors write into their notes, as their brands. */
const BRANDS: Readonly<Record<string, string>> = {
  shopify: "Shopify",
  stripe: "Stripe",
  woocommerce: "WooCommerce",
  square: "Square",
  meta: "Meta",
  ga4: "Google Analytics",
};

/**
 * A measured fact's note as an owner reads it: its days written out and a
 * provider named by its brand where a connector wrote its id ("Measured by
 * shopify, 2026-10-08 to 2026-11-06." → "Measured by Shopify, 8 Oct 2026 to
 * 6 Nov 2026."). Only "by <id>" and "from <id>" are touched, so a word that
 * happens to be an id elsewhere in the sentence stays as written.
 */
export function noteWords(text: string | null): string | null {
  const dated = datesInWords(text);
  if (dated === null) return null;
  return dated.replace(
    /\b(by|from) (shopify|stripe|woocommerce|square|meta|ga4)\b/g,
    (_whole, word: string, id: string) => `${word} ${BRANDS[id] ?? id}`,
  );
}

// Visible text out of HTML — pure, no DOM, no dependency. Shared by
// competitor research (lib/research/live.ts) and the competitor reader
// (lib/competitors/extract.ts); moved here so a pure parser need not
// import the network or the database to use it.

/** Visible text from an HTML document. No DOM, no dependency — enough
 * for price lists and delivery pages, which is all we read. */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script[^>]*>/gi, " ")
    .replace(/<style[\s\S]*?<\/style[^>]*>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript[^>]*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?(?:p|div|li|tr|br|h[1-6]|section|article|table)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripHtml(m[1]!).slice(0, 200) : "";
}

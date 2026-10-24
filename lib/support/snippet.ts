// The widget snippet — what an owner pastes into their site (P4-07). Its
// own module with no imports, so the owner's /support screen and the
// smoke test (scripts/smoke/widget.ts) share one definition without
// pulling in the database.

/** The script tag an owner pastes into their site: public by design, as the site key is. */
export function widgetSnippet(origin: string, siteKey: string): string {
  return `<script src="${origin}/support-widget.js" data-site-key="${siteKey}" async></script>`;
}

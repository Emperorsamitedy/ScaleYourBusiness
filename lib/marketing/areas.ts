// "What we test — Nine panels" on the landing page, as the owner's
// landing design (2026-10-17) sets them.
//
// Honesty note for the owner: the page says the test reads your business.
// As of this commit the connectors that exist (lib/connectors/providers)
// are Shopify, WooCommerce, Square, Stripe, Meta Ads, GA4 and Search
// Console. `connected` records which panels have a read-only connector
// today; the ones marked false are answered in the interview until a
// connector exists. The page does not print this flag, so keep it
// current before the claim goes in front of strangers.

export interface TestPanel {
  no: string;
  name: string;
  /** The markers in the panel, as the page lists them. */
  markers: string;
  connected: boolean;
}

export const PANELS: readonly TestPanel[] = [
  {
    no: "01",
    name: "Conversion",
    markers: "booking or checkout · enquiries · mobile · page depth",
    connected: false,
  },
  {
    no: "02",
    name: "Margin",
    markers: "after delivery · cost of sale · fees · discounts",
    connected: true,
  },
  {
    no: "03",
    name: "Pricing",
    markers: "position · sensitivity · average sale · thresholds",
    connected: true,
  },
  {
    no: "04",
    name: "Returns & refunds",
    markers: "rate · damage & redos · cost · reasons",
    connected: true,
  },
  {
    no: "05",
    name: "Retention",
    markers: "repeat · time between · lapsed · value",
    connected: true,
  },
  {
    no: "06",
    name: "Email & SMS",
    markers: "share · flows · list growth · unsubscribes",
    connected: false,
  },
  {
    no: "07",
    name: "Acquisition",
    markers: "cost per customer · payback · channel mix · ROAS",
    connected: true,
  },
  {
    no: "08",
    name: "Stock & capacity",
    markers: "stock-outs · dead stock · empty slots · turnover",
    connected: false,
  },
  {
    no: "09",
    name: "Support",
    markers: "questions · “where is my order or booking” · reply time · self-serve",
    connected: false,
  },
];

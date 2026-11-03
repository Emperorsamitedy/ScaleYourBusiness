// L-3d's glossary exceptions (messages/catalogue.test.ts, rule 2): messages
// whose English uses a glossary word in another sense — a provider's own
// product or permission name, a scope code, a verb — so a translation
// rightly uses another word. Kept in their own file so L-3c's and L-3d's
// lists merge without touching each other. Each names its terms and why;
// the catalogue test fails an exception that has gone stale.

const META_PORTFOLIO =
  "Meta's own names (Meta Business Suite, business portfolio, business settings, a Business app), as Meta names them in each language";
const GOOGLE_PROFILE =
  "Google Business Profile: Google's product name, as Google names it in each language";

export const L3D_GLOSSARY_EXCEPTIONS: Record<string, { terms: string[]; reason: string }> = {
  "connections.guide.shopify.s3.grant": {
    terms: ["customer"],
    reason: "the Shopify scope code read_customers, not a word to translate",
  },
  "connections.settings.cartsCustomers": {
    terms: ["customer"],
    reason: "only the Shopify scope code read_customers names customers here",
  },
  "connections.guide.ga4.s0.why": {
    terms: ["viewer"],
    reason: "Google Analytics' own Viewer role, not SYB's viewer role",
  },
  "connections.verify.reported": {
    terms: ["report"],
    reason: "“reports which permissions”: the verb, not SYB's report",
  },
  "connections.write.tier.unseen": {
    terms: ["report"],
    reason: "“Meta reports it”: the verb, not SYB's report",
  },
  "connections.write.tier.note": {
    terms: ["report", "review"],
    reason:
      "“Meta reports” (the verb) and Meta's own app review, not SYB's report or customer reviews",
  },
  "connections.steps.meta_ads.s1": { terms: ["business"], reason: META_PORTFOLIO },
  "connections.steps.meta_ads.s4": {
    terms: ["manager"],
    reason: "Ads Manager: Meta's product name, not SYB's manager role",
  },
  "connections.write.ownAppSteps.meta_ads.s4": {
    terms: ["manager"],
    reason: "Ads Manager: Meta's product name, not SYB's manager role",
  },
  "connections.write.ownAppSteps.meta_publish.s0": { terms: ["business"], reason: META_PORTFOLIO },
  "connections.write.ownAppSteps.meta_publish.s1": { terms: ["business"], reason: META_PORTFOLIO },
  "connections.write.ownAppSteps.meta_publish.s3": { terms: ["business"], reason: META_PORTFOLIO },
  "connections.write.ownAppSteps.meta_ads.s0": { terms: ["business"], reason: META_PORTFOLIO },
  "connections.write.ownAppSteps.meta_ads.s1": { terms: ["business"], reason: META_PORTFOLIO },
  "connections.write.ownAppSteps.meta_ads.s3": { terms: ["business"], reason: META_PORTFOLIO },
  "connections.write.route.ownAppStandard": { terms: ["business"], reason: META_PORTFOLIO },
  "connections.write.disconnectNote": { terms: ["business"], reason: META_PORTFOLIO },
  "connections.write.access.standard.body": {
    terms: ["approval"],
    reason:
      "Meta's own approvals of SYB (Advanced Access and the verifications), not the owner approving a proposal",
  },
  "connections.panel.foot": {
    terms: ["approval"],
    reason: "Google's own sign-off of SYB for Google Ads, not the owner approving a proposal",
  },
  "connections.settings.shopifyAllOrders": {
    terms: ["approval"],
    reason: "Shopify's own sign-off of the app's scope, not the owner approving a proposal",
  },
  "connections.guide.shopify.s2.grant": {
    terms: ["approval"],
    reason: "Shopify's own sign-off of the app's scope, not the owner approving a proposal",
  },
  "connections.write.facebook.testerNote": {
    terms: ["approval"],
    reason: "granting permissions in Meta's own dialog, not the owner approving a proposal",
  },
  "connections.write.route.signInOn": {
    terms: ["approval"],
    reason: "granting permissions in Meta's own dialog, not the owner approving a proposal",
  },
  "connections.write.route.testersOn": {
    terms: ["team"],
    reason: "SYB's own staff (“the SYB team”), not the business's team",
  },
  "connections.write.route.testersOff": {
    terms: ["team"],
    reason: "SYB's own staff (“the SYB team”), not the business's team",
  },
  "connections.write.label.google_business_reviews": {
    terms: ["business"],
    reason: GOOGLE_PROFILE,
  },
  "connections.google.label": { terms: ["business"], reason: GOOGLE_PROFILE },
  "connections.google.sectionLabel": { terms: ["business"], reason: GOOGLE_PROFILE },
  "connections.google.connected": { terms: ["business"], reason: GOOGLE_PROFILE },
  "connections.google.reason.already_connected": { terms: ["business"], reason: GOOGLE_PROFILE },
  "connections.google.reason.scope": { terms: ["business"], reason: GOOGLE_PROFILE },
  "connections.google.reason.no_locations": { terms: ["business"], reason: GOOGLE_PROFILE },
  "connections.google.reason.google_permission": { terms: ["business"], reason: GOOGLE_PROFILE },
  "landing.chart.title": {
    terms: ["stock"],
    reason: "“read like a stock”: a share on a market, not goods on hand",
  },
  "connections.bank.currency": {
    terms: ["account"],
    reason: "the bank account the statement is for, not a sign-in or connected account",
  },
  "connections.bank.overlap": {
    terms: ["account"],
    reason: "what was in the bank account, not a sign-in or connected account",
  },
  "connections.steps.ga4.s3": {
    terms: ["content"],
    reason: "“the contents of the key file”: what a file holds, not marketing content",
  },
  "connections.steps.search_console.s3": {
    terms: ["content"],
    reason: "“the contents of the key file”: what a file holds, not marketing content",
  },
};

// L-4c's glossary exceptions (messages/catalogue.test.ts, rule 2): messages
// whose English uses a glossary word in another sense, so a translation
// rightly uses another word. Kept in their own file so the L-4 branches
// merge without touching each other. Each names its terms and why; the
// catalogue test fails an exception that has gone stale.

export const L4C_GLOSSARY_EXCEPTIONS: Record<string, { terms: string[]; reason: string }> = {
  // teamWords

  // siteWords
  "siteWords.check.team": {
    terms: ["deal"],
    reason: "“who you'll deal with”: the verb (the people a customer meets), not a sales deal",
  },
  "siteWords.error.proposalId": {
    terms: ["proposal"],
    reason: "proposal_id is the API's field name, kept as typed, not the word proposal",
  },
  "siteWords.walk.note.contact": {
    terms: ["contact"],
    reason: "a website's contact page (where the path ends), not a CRM contact",
  },
  "siteWords.walk.note.none": {
    terms: ["contact"],
    reason: "a website's contact page (a page's role), not a CRM contact",
  },
  "siteWords.finding.title.form": {
    terms: ["contact"],
    reason: "a website's contact form (a page's role), not a CRM contact",
  },
  "siteWords.finding.detail.heavy": {
    terms: ["connection"],
    reason: "a phone's network connection (mobile data), not a connected account",
  },

  // customersWords, contentWords, supportWords, connectionsWords
  "customersWords.gate.law_review_stale": {
    terms: ["review"],
    reason: "a person's review of the email-law rules (a check), not a customer review",
  },
  "customersWords.gate.first_campaign_unreviewed": {
    terms: ["review"],
    reason: "SYB's review of a first campaign before it sends (a check), not a customer review",
  },
  "customersWords.measured.delivery": {
    terms: ["report"],
    reason: "spam reports: a recipient's complaint, not a report SYB writes",
  },
  "customersWords.measured.notDelivery": {
    terms: ["report"],
    reason: "spam reports: a recipient's complaint, not a report SYB writes",
  },
  "customersWords.measured.opens": {
    terms: ["report"],
    reason: "“Apple Mail reports opens”: the verb, not a report SYB writes",
  },
  "supportWords.error.nothingNew": {
    terms: ["support"],
    reason: "“every answer the profile supports”: the verb (backs up), not customer support",
  },
  "connectionsWords.label.google_business_reviews": {
    terms: ["business"],
    reason: "Google Business Profile: Google's product name, as Google names it in each language",
  },
  "connectionsWords.said.google.neverWrites": {
    terms: ["business"],
    reason: "Google Business Profile: Google's product name, as Google names it in each language",
  },
  "connectionsWords.said.metaCred.adsAccount": {
    terms: ["manager"],
    reason:
      "Ads Manager: Meta's product name, as Meta names it in each language, not the manager role",
  },
  "connectionsWords.said.source.metaAccountId": {
    terms: ["manager"],
    reason:
      "Ads Manager: Meta's product name, as Meta names it in each language, not the manager role",
  },
};

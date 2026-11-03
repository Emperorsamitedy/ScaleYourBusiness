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
};

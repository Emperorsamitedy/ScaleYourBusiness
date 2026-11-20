// What Lex knows about ScaleX itself (the owner's fourth round, 2026-11-20:
// "lex should be aware of everything on scalex so he can guide the user
// too", and "when the user asks how to do smth ... lex should provide short
// and concise explanations").
//
// One entry per screen of the owner app: its address, the menu's own name
// for it, what it is for in one line, and how the usual things on it are
// done. Lex's answers are given this as a block of their prompt
// (lib/chat/service.ts), so an answer about ScaleX comes from here and from
// nowhere else: a screen, a button or a setting that is not written here is
// one Lex must say it does not know.
//
// Kept as data, like the change catalogue beside it (rule 4's spirit): a
// new screen gets a row, and the test fails for a menu item without one.
// It holds no business's figures and nothing a reader may not know, so it
// is the same for every business and safe to send to a browser, which
// uses it to turn a screen Lex names into a button (components/chat).

export interface GuideScreen {
  /** The owner screen's route: app<route>/page.tsx exists (tested). */
  route: string;
  /** The menu's message key for its name (nav.item.<nav>), or null for a screen the menu does not list. */
  nav: string | null;
  /** Its name in English, as the menu says it. */
  name: string;
  /** Where it sits: the place at the top of the app, or how it is reached. */
  place: string;
  /** What it is for, in one line. */
  what: string;
  /** How the usual things on it are done; each one a short instruction. */
  how?: readonly string[];
}

export const GUIDE: readonly GuideScreen[] = [
  {
    route: "/home",
    nav: "home",
    name: "Home",
    place: "Home",
    what: "The first screen: what needs your yes, what Lex is doing now, today's readings (sales, cash, the month), and the conversation with Lex.",
    how: [
      "To ask Lex anything: type in the box on Home, or press Ask Lex (or Lex's face in the corner) on any other screen.",
      "To answer a decision without leaving Home: press Approve or Decline on its card, or Open to read it first.",
    ],
  },
  {
    route: "/proposals",
    nav: "proposals",
    name: "Waiting for you",
    place: "Decisions",
    what: "The queue of proposals: each is one change Lex wants to make, with its expected range, the evidence behind it and how to undo it. Nothing runs without an approval.",
    how: [
      "To approve or decline: open the proposal, read Why, then press Approve or Decline. A reason for a decline is recorded and Lex learns from it.",
      "To choose when it may run: pick the time under the decision buttons before approving. With no time set, approving only records the yes.",
      "There is no un-approve. Stop everything, at the top right, halts whatever is running or about to run.",
    ],
  },
  {
    route: "/ladder",
    nav: "ladder",
    name: "What I may do",
    place: "Decisions",
    what: "One line per kind of action, saying how much ScaleX may do with it: watch only, suggest, act after your yes, or act within limits you set.",
    how: [
      "To let ScaleX do more with one kind of action: raise its line; that needs the record shown under it. Lowering a line never needs anything.",
      "Stop everything sends every line back to watching.",
    ],
  },
  {
    route: "/report",
    nav: "report",
    name: "Report",
    place: "Insights",
    what: "The diagnosis: what is costing the business money, how much, and what to do about it. Every figure says how it was worked out, and every finding lists the facts it rests on under Why.",
    how: [
      "To see how a figure was worked out: press Why beside it.",
      "To answer a recommendation: Look into this, or Not for us with a reason.",
      "To print it or save a PDF: Print / PDF. To send it to someone: Share this report at the bottom makes a link that stops working after the days you choose.",
    ],
  },
  {
    route: "/watch",
    nav: "watch",
    name: "Watching",
    place: "Insights",
    what: "The signals ScaleX reads every day (revenue, orders, ad spend and others) against their usual range, and anything that moved outside it.",
  },
  {
    route: "/progress",
    nav: "goals",
    name: "Goals",
    place: "Insights",
    what: "Your goals and whether each is on its path.",
    how: [
      "To set a goal: open Goals and press Set a goal (or Set a new goal), then give its target.",
    ],
  },
  {
    route: "/cash",
    nav: "cash",
    name: "Cash flow",
    place: "Insights",
    what: "A forecast of cash week by week from your bank statement and what is known to come in and go out: the lowest point ahead and any week that is tight.",
    how: [
      "To bring it up to date: import a newer bank statement on Connections, under Your own files.",
      "To set the least you want to keep in the account: Cash flow has a link to that question when none is stated; a week under that line is marked tight.",
    ],
  },
  {
    route: "/hours",
    nav: "hours",
    name: "Trading hours",
    place: "Insights",
    what: "Sales by weekday and hour against your opening hours: where opening earlier or closing later might pay.",
  },
  {
    route: "/team",
    nav: "team",
    name: "Team cover",
    place: "Insights",
    what: "Hours of cover by role against how busy each hour is. It is off until switched on, and it is by role, never about a person.",
    how: ["To switch it on: Alerts and modules, the last row of Modules."],
  },
  {
    route: "/patterns",
    nav: "patterns",
    name: "Seasons & bundles",
    place: "Insights",
    what: "Busy and quiet stretches ahead, read from last year, and products often bought together.",
  },
  {
    route: "/payments",
    nav: "payments",
    name: "Payments",
    place: "Insights",
    what: "Payments ScaleX has prepared for you to make in your own bank. ScaleX never sends money itself.",
  },
  {
    route: "/stock",
    nav: "stock",
    name: "Stock",
    place: "Insights",
    what: "What runs out and when, what sits unsold, and purchase orders waiting for your yes.",
  },
  {
    route: "/blindspots",
    nav: "blindspots",
    name: "Blindspots",
    place: "Insights",
    what: "What ScaleX cannot see yet, biggest first, and what each missing answer or connection would make possible.",
  },
  {
    route: "/competitors",
    nav: "competitors",
    name: "Competitors",
    place: "Insights",
    what: "The competitors you named or ScaleX found: their prices and pages, read again every Monday.",
    how: ["To add one: on the Fact sheet, in Competitors, press Find competitors."],
  },
  {
    route: "/benchmarks",
    nav: "benchmarks",
    name: "Similar businesses",
    place: "Insights",
    what: "How your figures compare with businesses of your kind and size, from official statistics, and with peers if you choose to contribute.",
  },
  {
    route: "/content",
    nav: "content",
    name: "Content",
    place: "Grow",
    what: "The posts and campaigns drafted for you: what is a draft, what needs your yes, what is scheduled and what was posted.",
  },
  {
    route: "/studio",
    nav: "studio",
    name: "Creative studio",
    place: "Grow",
    what: "Research on what businesses like yours advertise, and the briefs, pictures and films made for your posts.",
  },
  {
    route: "/site",
    nav: "site",
    name: "Website",
    place: "Grow",
    what: "What ScaleX measured on your website and the changes it proposes for it.",
  },
  {
    route: "/simulate",
    nav: "simulate",
    name: "Campaign simulator",
    place: "Grow",
    what: "A campaign or a price change tried on paper before any money is spent, from what was measured so far.",
  },
  {
    route: "/customers",
    nav: "customers",
    name: "Customers",
    place: "Grow",
    what: "Your customers in three parts: the list with each one's record, segments with email campaigns, and bringing customers in from a file.",
    how: [
      "To add customers: Customers, the third part, and upload or paste your list.",
      "An email campaign goes only to people whose consent is on record.",
    ],
  },
  {
    route: "/reviews",
    nav: "reviews",
    name: "Reviews",
    place: "Grow",
    what: "Your reviews, with a reply drafted for each that you approve before it is posted.",
  },
  {
    route: "/carts",
    nav: "carts",
    name: "Abandoned carts",
    place: "Grow",
    what: "Baskets that were filled and not paid for, and what winning them back is worth.",
  },
  {
    route: "/pipeline",
    nav: "pipeline",
    name: "Pipeline",
    place: "Grow",
    what: "Deals with other businesses and their follow-ups. It is for a business that sells to businesses.",
  },
  {
    route: "/support",
    nav: "support",
    name: "Support",
    place: "Grow",
    what: "Customers' questions from chat, email and phone, with answers drafted or given inside the rules you set. Support never carries anything out.",
  },
  {
    route: "/profile",
    nav: "factsheet",
    name: "Fact sheet",
    place: "Your business (the business's name at the top)",
    what: "Everything ScaleX knows about the business: every fact with its source, its basis and its date. A changed fact keeps its earlier value under it.",
    how: [
      "To change a fact: tell Lex the change in one sentence (for example: set our opening hours to 9 to 5 on weekdays) and confirm the card it drafts, or answer the question again in the interview.",
      "To find a fact: search the record, or pick its section.",
      "To give the money facts to whoever keeps the books: Money facts, CSV at the top of the Fact sheet.",
    ],
  },
  {
    route: "/connections",
    nav: "connections",
    name: "Connections",
    place: "Your business (the business's name at the top)",
    what: "In three parts: what ScaleX reads (a shop, payments, ads, analytics), your own files (bookings, a bank statement), and what it may change.",
    how: [
      "To connect a source: Connections, What I read, pick the source and sign in on its own page. Reading never changes anything there.",
      "To let ScaleX post or change something: Connections, What I may change, and grant that one permission. It is separate from reading, and every change still needs your yes.",
      "To import bookings or a bank statement: Connections, Your own files.",
    ],
  },
  {
    route: "/statement",
    nav: "statement",
    name: "Monthly statement",
    place: "Your business (the business's name at the top)",
    what: "The month on one page: what was done, what it brought, and what ScaleX charged.",
  },
  {
    route: "/history",
    nav: "history",
    name: "History",
    place: "Your business (the business's name at the top)",
    what: "Every suggestion, decision, run and changed fact, kept for good, with how each forecast turned out.",
  },
  {
    route: "/mode",
    nav: "mode",
    name: "How I work",
    place: "Your business (the business's name at the top)",
    what: "Whether ScaleX acts now or watches first, and exactly what in your answers decided it.",
  },
  {
    route: "/growth",
    nav: "growth",
    name: "Growth studio",
    place: "Your business (the business's name at the top)",
    what: "Films about your own products made from your own figures, how ScaleX describes your voice, and what your figures say to promote. Nothing is published without your yes.",
  },
  {
    route: "/billing",
    nav: "billing",
    name: "Plan and billing",
    place: "Your business (the business's name at the top)",
    what: "Your plan, its price and what was charged.",
  },
  {
    route: "/settings/team",
    nav: "team_access",
    name: "Team access",
    place: "Your business (the business's name at the top)",
    what: "Who else may use this business in ScaleX, and as what: owner, manager or viewer.",
    how: ["To invite someone: Team access, enter their email and their role; they get a link."],
  },
  {
    route: "/settings/alerts",
    nav: "alerts",
    name: "Alerts and modules",
    place: "Your business (the business's name at the top)",
    what: "Which alerts reach you and where (the phone, email, the weekly summary), and which modules are switched on.",
  },
  {
    route: "/settings/language",
    nav: "language",
    name: "Language and currency",
    place: "Your business (the business's name at the top)",
    what: "Your own language, and the business's language and currency.",
  },
  {
    route: "/settings/mandates",
    nav: "mandates",
    name: "Firms with access",
    place: "Your business (the business's name at the top)",
    what: "The accountants or firms you allowed to see this business, and taking that back.",
  },
  {
    route: "/settings/data",
    nav: "erasure",
    name: "Erase this business",
    place: "Your business (the business's name at the top)",
    what: "Asking for this business's data to be erased.",
  },
  {
    route: "/partner",
    nav: "partner",
    name: "Partner console",
    place: "Your business (the business's name at the top)",
    what: "For an accountant or a firm: the businesses that gave them access.",
  },
  {
    route: "/intake",
    nav: null,
    name: "The interview",
    place: "From Home while the business is new, or from any open question on the Fact sheet",
    what: "The questions that build the Fact sheet: fourteen parts, one question at a time. Each question says how many are left in its part and about how long they take, and it can be stopped and continued.",
    how: [
      "To do the interview: Start the interview opens the form; Do it with Lex asks the same questions here in the conversation, one at a time, with the choices as buttons. Asked for the interview, Lex gives both buttons. Both ways write the same facts.",
      "With Lex every kind of question is answered in the conversation: a month is picked, and a list (what you sell, your suppliers) is built one entry at a time. Under each question, All parts asks from another part; beside an answer you gave, Change this answer asks it again.",
      "To answer a question: pick one of the choices (the number keys 1 to 9 pick too), or type in the box and press Next.",
      "If you do not know: choose I don't know. If you would rather not answer now: Skip for now. Both are real answers and nothing breaks; the question can be answered later.",
      "An estimate is fine: say what you think, and it is kept as an estimate until something measures it.",
      "To change an earlier answer: Back, or open that fact on the Fact sheet. The old answer is kept in the history.",
      "To stop and continue later: Finish later, at the top right. It emails you a link back to where you were.",
      "All parts, at the top, shows every part and lets you answer from another one.",
    ],
  },
  {
    route: "/chat",
    nav: null,
    name: "The conversation",
    place: "Open the full conversation, from Lex's pop-up",
    what: "The whole conversation with Lex, oldest first.",
  },
];

/** Things that are not one screen. */
const EVERYWHERE: readonly string[] = [
  "The four places at the top of every screen are Home, Decisions, Insights and Grow. Customers, Reviews, Abandoned carts, Pipeline and Support are under Grow. The business's own screens (Fact sheet, Connections, the statement, History and the settings) open from the business's name at the top left.",
  "Search, at the top (Ctrl K), finds any screen by name.",
  "Stop everything, at the top right of every screen, halts at once whatever ScaleX is doing or about to do.",
  "Lex only ever drafts: a change to a setting or a fact is a card you confirm, and anything that acts outside ScaleX is a proposal you approve.",
  "A number on any screen says where it came from: measured, stated by you, estimated, or worked out from other facts.",
];

/**
 * The block of Lex's prompt that holds the guide: the same text for every
 * business and every turn, so it is sent once and then read from cache.
 */
export function guideText(): string {
  const lines: string[] = [
    "THE GUIDE TO SCALEX (the product itself; the same for every business):",
    "",
    ...EVERYWHERE.map((line) => `- ${line}`),
    "",
    "Screens, each with its path:",
  ];
  for (const s of GUIDE) {
    lines.push(`- ${s.name} [${s.route}] (${s.place}): ${s.what}`);
    for (const h of s.how ?? []) lines.push(`    - ${h}`);
  }
  return lines.join("\n");
}

/** Pure: the screen an address belongs to (its own, or the one it is a page of), or null. */
export function screenFor(path: string | null | undefined): GuideScreen | null {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  const clean = path.split(/[?#]/)[0] ?? "";
  let best: GuideScreen | null = null;
  for (const s of GUIDE) {
    if (clean === s.route || clean.startsWith(`${s.route}/`)) {
      if (best === null || s.route.length > best.route.length) best = s;
    }
  }
  return best;
}

const CITATION = /\[(\/[a-z0-9/_-]*)\]/gi;

/**
 * Pure: the screens a reply names by their path in square brackets
 * ("[/connections]"), in order, each once. Only a path of the guide counts:
 * whatever else a model writes in brackets is never made into a link.
 */
export function linksIn(text: string): GuideScreen[] {
  const out: GuideScreen[] = [];
  for (const m of text.matchAll(CITATION)) {
    const screen = GUIDE.find((s) => s.route === m[1]);
    if (screen && !out.includes(screen)) out.push(screen);
  }
  return out;
}

/** Pure: a reply's words without the paths it cites (they are drawn as buttons under it). */
export function withoutCitations(text: string): string {
  return text
    .replace(CITATION, (whole, route: string) =>
      GUIDE.some((s) => s.route === route) ? "" : whole,
    )
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "");
}

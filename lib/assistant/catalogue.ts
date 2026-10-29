// The change catalogue — feature 33, "the assistant acts".
//
// The co-founder's ask, from customer interviews: the owner tells the
// chat what to change, and either the assistant does it, or it hands
// over a link to the exact place where the owner can change it by hand
// and see what is already there. This table is the whole of what the
// chat can change. Closed on purpose: a request that maps to no row is
// either a question, or an action in the world that becomes a proposal
// (the P3-36 request tier). Nothing the model says adds a row.
//
// Rule 4's spirit: which screen, which field, whether the assistant may
// prepare it and how it is recognised all live HERE, as data. The code
// in lib/assistant reads the row; it never branches on a screen name.
//
//   prepare "direct"    one click writes it through the path the screen
//                       itself uses (the supersession store for a fact,
//                       the settings service for a setting, the stop)
//   prepare "proposal"  one click puts it in the approval queue — it
//                       changes what customers see or what gets published,
//                       so it waits for a yes there (rule 12)
//   prepare "link"      only a link: it needs the owner's own login, or
//                       the explicit settings path (a limit is never
//                       removed from chat, conversation-channel §5)
//
// `section` names the element the deep link scrolls to and marks; a
// "{slot}" in it is filled per change (the fact's key, the goal's id).

import type { RoleAction } from "../auth/roles";
import type { ChangeKind } from "./kinds";

export type { ChangeKind } from "./kinds";
export { CHANGE_KINDS } from "./kinds";

export type PrepareMode = "direct" | "proposal" | "link";

export interface CatalogueEntry {
  kind: ChangeKind;
  /** The thing, in the owner's words: "your opening hours". */
  thing: string;
  /** The screen it lives on, as the menu names it. */
  screen: string;
  /** The owner screen's route — app<route>/page.tsx must exist (tested). */
  route: string;
  /** The element id the deep link focuses and marks; "{slot}" is filled per change. */
  section: string;
  /** Which field or setting it changes. */
  target: string;
  prepare: PrepareMode;
  /** The card's confirming button; null when only a link is offered. */
  confirm: string | null;
  /** Confirming needs a signed-in session, as the screen's own route does. */
  signed_in: boolean;
  /**
   * Idea 52: the action the screen's own route checks (lib/auth/roles), so
   * a click in the chat needs the same role the screen would.
   */
  role_action: RoleAction;
  /** Recognised deterministically when any of these match the owner's words. */
  cues: readonly RegExp[];
  /** Said to the owner when the change is link-only, or what the click does. */
  note: string;
}

const DAY = String.raw`(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)s?`;

/** Catalogue order is recognition priority: the first entry whose cue matches wins ties. */
export const CHANGE_CATALOGUE: readonly CatalogueEntry[] = [
  {
    kind: "stop",
    thing: "everything I do for you",
    screen: "Waiting for you",
    route: "/proposals",
    section: "emergency-stop",
    target: "execution_halts (the emergency stop)",
    prepare: "direct",
    confirm: "Stop everything",
    signed_in: false,
    role_action: "stop.press",
    cues: [
      /\b(pause|stop|halt|freeze)\b[^.?!]{0,24}\b(everything|all of it|it all|all work|the lot|all)\b/i,
      /\bemergency stop\b/i,
      /\bpull the (plug|brake)\b/i,
    ],
    note: "Stopping is one click and takes effect at once; anything in flight is held.",
  },
  {
    kind: "resume",
    thing: "starting things up again after a stop",
    screen: "Waiting for you",
    route: "/proposals",
    section: "emergency-stop",
    target: "execution_halts (the emergency stop)",
    prepare: "link",
    confirm: null,
    signed_in: true,
    role_action: "stop.resume",
    cues: [
      /\b(resume|unpause|un-pause|restart)\b/i,
      /\b(start|turn)\b[^.?!]{0,16}\b(back on|up again|again)\b/i,
      /\b(lift|release|undo)\b[^.?!]{0,10}\bthe stop\b/i,
    ],
    note: "Restarting is the risky direction, so it happens on the stop itself, signed in, with its own confirm.",
  },
  {
    kind: "reply_time",
    thing: "the reply time you promise customers",
    screen: "Support",
    route: "/support",
    section: "sp-time",
    target: "support_settings.reply_hours",
    prepare: "direct",
    confirm: "Make this change",
    signed_in: true,
    role_action: "support.settings",
    cues: [
      /\breply[- ]time\b/i,
      /\b(reply|replies|answer|respond|get back)\w*\b[^.?!]{0,30}\b(within|in under|in)\s+(\d+|an?|one)\b[^.?!]{0,6}\b(hours?|hrs?|h|days?)\b/i,
    ],
    note: "It sets how long a ticket may wait before Support marks it overdue.",
  },
  {
    kind: "support_notify",
    thing: "whether I email you about new support tickets",
    screen: "Support",
    route: "/support",
    section: "sp-time",
    target: "support_settings.notify_owner",
    prepare: "direct",
    confirm: "Make this change",
    signed_in: true,
    role_action: "support.settings",
    cues: [
      /\b(notif\w*|email\w*|tell|alert\w*|ping)\b[^.?!]{0,12}\bme\b[^.?!]{0,30}\b(tickets?|support|messages?|emails?)\b/i,
      /\b(ticket|support)\b[^.?!]{0,20}\b(notifications?|emails? to me|alerts?)\b/i,
    ],
    note: "It only changes whether a new email ticket also lands in your own inbox.",
  },
  {
    kind: "opening_hours",
    thing: "your opening hours",
    screen: "Fact sheet",
    route: "/profile",
    section: "fact-presence.opening_hours",
    target: "presence.opening_hours",
    prepare: "direct",
    confirm: "Make this change",
    signed_in: false,
    role_action: "profile.edit",
    cues: [
      /\b(opening|trading|business|shop|store)\s+hours\b/i,
      new RegExp(String.raw`\b${DAY}\s+hours\b`, "i"),
      new RegExp(
        String.raw`\b(open|opens|opening|close|closes|closing|closed|shut)\b[^.?!]{0,40}\b${DAY}\b`,
        "i",
      ),
      new RegExp(
        String.raw`\b${DAY}\b[^.?!]{0,40}\b(open|opens|opening|close|closes|closing|closed|shut)\b`,
        "i",
      ),
    ],
    note: "Your hours are a fact from the interview; the change supersedes it and the old one stays in its history.",
  },
  {
    kind: "size_band",
    thing: "the size of your business",
    screen: "Fact sheet",
    route: "/profile",
    section: "fact-identity.size_band",
    target: "identity.size_band",
    prepare: "direct",
    confirm: "Make this change",
    signed_in: false,
    role_action: "profile.edit",
    cues: [
      /\bsize\s+band\b/i,
      /\b(business|company)\s+size\b/i,
      /\bsize\s+of\s+(the|my|our)\s+(business|company)\b/i,
      /\b(we'?re|we are|i'?m|i am)\s+(now\s+)?(just me|solo|a sole trader|a one[- ]person business|a (small|medium|mid-sized|large|larger|bigger)(-sized)? (team|business))\b/i,
    ],
    note: "The size decides how much detail I show you; nothing underneath changes.",
  },
  {
    kind: "standing_rule_remove",
    thing: "removing one of your standing rules",
    screen: "Fact sheet",
    route: "/profile",
    section: "fact-goals.owner_boundaries",
    target: "goals.owner_boundaries",
    prepare: "link",
    confirm: null,
    signed_in: false,
    role_action: "profile.edit",
    cues: [
      /\b(remove|drop|delete|lift|scrap|cancel|undo|forget)\b[^.?!]{0,30}\b(rule|limit|boundary|boundaries)\b/i,
      /\bwe can (discount|advertise|cold[- ]call)\b/i,
    ],
    note: "A limit can be set in chat and never removed in chat — limits exist to survive a bad day, so removing one is your explicit change to the answer.",
  },
  {
    kind: "standing_rule",
    thing: "your standing rules — what the business must never do",
    screen: "Fact sheet",
    route: "/profile",
    section: "fact-goals.owner_boundaries",
    target: "goals.owner_boundaries",
    prepare: "direct",
    confirm: "Add this rule",
    signed_in: false,
    role_action: "profile.edit",
    cues: [
      /^\s*(we\s+|i\s+)?(never|don'?t ever|do not ever)\b/i,
      /\b(add|set|make)\b[^.?!]{0,16}\b(a\s+)?(standing\s+rule|hard\s+limit|rule|limit)\b/i,
      /\bfrom now on\b[^.?!]{0,30}\b(never|no)\b/i,
    ],
    note: "Every future proposal is held against it, and anything it blocks shows in the queue's held-back section.",
  },
  {
    kind: "goal",
    thing: "one of your goals",
    screen: "Goals",
    route: "/progress",
    section: "goal-{slot}",
    target: "goals.<goal>.statement | goals.<goal>.target_value",
    prepare: "direct",
    confirm: "Make this change",
    signed_in: false,
    role_action: "profile.edit",
    cues: [/\b(goal|goals|target)\b/i],
    note: "A goal edited here still shows what it said before; outcomes are scored against the statement that held at the time.",
  },
  {
    kind: "knowledge_answer",
    thing: "an answer the customer assistant gives",
    screen: "Support",
    route: "/support",
    section: "sp-answers",
    target: "knowledge_entries (through a support_knowledge proposal)",
    prepare: "proposal",
    confirm: "Put it in my queue",
    signed_in: true,
    role_action: "support.answer",
    cues: [
      /\b(customer|support|site)\s+(assistant|bot|chat)\b/i,
      /\b(faq|knowledge base|knowledge)\b/i,
      /\b(assistant|bot)\s+(says|tells|answers|should say)\b/i,
    ],
    note: "Words the assistant says to customers go through your approval queue; it starts using the answer once you approve it there.",
  },
  {
    kind: "content_item",
    thing: "an item on your content calendar",
    screen: "Content",
    route: "/content",
    section: "ct-calendar",
    // Review 2026-10-23, #8: approving the proposal makes the edit itself
    // (lib/content/calendar.ts), re-checked against what the card quoted.
    target: "content_items: a draft's day or title, made when its proposal is approved",
    prepare: "proposal",
    confirm: "Put it in my queue",
    signed_in: false,
    role_action: "content.draft",
    cues: [
      /\b(content\s+)?calendar\b/i,
      /\b(reschedule|move|change|edit|rename|retitle|rewrite|swap|cancel|drop)\b[^.?!]{0,30}\b(post|posts|reel|video|caption|item)\b/i,
    ],
    note: "From chat I can move a draft to another day or rename it. It goes through your approval queue, and approving it there makes the change on your calendar; nothing here posts on its own.",
  },
  {
    kind: "connection",
    thing: "a connected account",
    screen: "Connections",
    route: "/connections",
    section: "cn-src-{slot}",
    target: "connections (read-only, per provider)",
    prepare: "link",
    confirm: null,
    signed_in: true,
    role_action: "connections.manage",
    cues: [
      /\b(connect|disconnect|reconnect|unplug|plug in|link|unlink|hook up)\b[^.?!]{0,30}\b(stripe|shopify|square|woo\s?commerce|google analytics|ga4|analytics|search console|meta|facebook|instagram|till|account|shop)\b/i,
      /\bconnections?\b/i,
    ],
    note: "Connecting an account needs your own login with that provider, so this one is yours to do — it takes a minute.",
  },
  {
    kind: "fact_value",
    thing: "a fact in your profile",
    screen: "Fact sheet",
    route: "/profile",
    section: "fact-{slot}",
    target: "any single-value fact the interview asked (field_records)",
    prepare: "direct",
    confirm: "Make this change",
    signed_in: false,
    role_action: "profile.edit",
    cues: [
      /\b(change|set|update|correct|fix|make)\s+(my|our|the)\s+.+?\s+(to|as|=)\s+\S/i,
      /\b(my|our|the)\s+.+?\s+is\s+(actually|now|really)\s+\S/i,
    ],
    note: "The change supersedes the old answer — it stays in the history, with this message as its source.",
  },
];

export function entryFor(kind: ChangeKind): CatalogueEntry {
  const entry = CHANGE_CATALOGUE.find((e) => e.kind === kind);
  if (!entry) throw new Error(`no catalogue entry for ${kind}`);
  return entry;
}

/** The element the deep link marks, with its slot filled. */
export function sectionId(entry: CatalogueEntry, slot?: string | null): string {
  return entry.section.includes("{slot}")
    ? slot
      ? entry.section.replace("{slot}", slot)
      : ""
    : entry.section;
}

/**
 * The deep link: the route, plus ?focus=<element id> for the exact
 * section. A query, not a #hash: the screens load their data after the
 * page does, and a hash jumps before the element exists.
 */
export function deepLink(entry: CatalogueEntry, slot?: string | null): string {
  const id = sectionId(entry, slot);
  return id === "" ? entry.route : `${entry.route}?focus=${encodeURIComponent(id)}`;
}

/** The catalogue entry whose target is exactly this field key, when one owns it. */
export function entryOwningField(fieldKey: string): CatalogueEntry | null {
  return (
    CHANGE_CATALOGUE.find(
      (e) => e.kind !== "fact_value" && e.prepare !== "link" && e.target === fieldKey,
    ) ?? null
  );
}

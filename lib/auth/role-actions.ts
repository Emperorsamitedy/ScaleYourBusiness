// The role table — idea 52 (I-52.3). Pure data and arithmetic, safe in the
// browser: the screens disable what a role can't do with these same words.
// lib/auth/roles.ts re-exports all of it beside requireRole, the server's
// check; that file's header says what the three roles may do and why.
//
// L-4a (TASKS-LANGUAGES.md): the refusal sentence is the "roleWords"
// catalogue's, one whole sentence per action (a phrase spliced into "Only
// an owner can …" would not decline in every language); English by
// default, and held to the English composed here (roles.test.ts).

import type { Tr } from "../i18n/tr";
import { englishTr } from "../i18n/tr";

export type Role = "owner" | "manager" | "viewer";

/** Most to least. A role may do what its rank or any lower rank may. */
export const ROLES: readonly Role[] = ["owner", "manager", "viewer"];

const RANK: Record<Role, number> = { owner: 3, manager: 2, viewer: 1 };

export interface RoleActionRow {
  /** The least role that may take the action. */
  min: Role;
  /** The action in the owner's words, finishing "Only an owner can …". */
  what: string;
}

export const ROLE_ACTIONS = {
  // ── anyone on the team ──
  "stop.press": { min: "viewer", what: "press the emergency stop" },
  "intake.open": { min: "viewer", what: "open the interview" },
  "telemetry.record": { min: "viewer", what: "record how the screens are used" },
  // I-52c (owner, 2026-11-01): anyone on the team may ask; what a message may DO
  // still asks for the role of the screen it would act on (lib/chat/service.ts).
  "chat.ask": { min: "viewer", what: "ask me things in the chat" },
  // Idea 53: taking one of your own phones off alerts is always allowed.
  "alerts.remove_device": { min: "viewer", what: "remove one of your own phones from alerts" },
  // L-1 (TASKS-LANGUAGES.md): the language you read SYB in is your own choice.
  "language.own": { min: "viewer", what: "choose the language you read SYB in" },

  // ── managers and owners ──
  "proposals.decide": { min: "manager", what: "approve or decline proposals" },
  "proposals.generate": { min: "manager", what: "ask me for new proposals" },
  "proposals.carry_out": { min: "manager", what: "carry out or undo an approved proposal" },
  "content.draft": { min: "manager", what: "draft content" },
  "support.answer": { min: "manager", what: "answer support" },
  // Decision 2 (owner, 2026-11-09): least privilege on calls. Those who answer
  // support read what callers said — transcripts and messages, and the full
  // number. A viewer sees the calls list only, the number masked.
  "phone.transcripts": { min: "manager", what: "read what callers said on the phone line" },
  // Idea 45: filing, answering and removing reviews is answering customers, like support.
  "reviews.answer": { min: "manager", what: "file, answer or remove reviews" },
  // I-52b (owner, 2026-11-01): the pipeline's day-to-day, and reading a
  // connected source again now. Connecting, disconnecting and importing stay an owner's.
  "pipeline.edit": { min: "manager", what: "change the sales pipeline" },
  "connections.sync": { min: "manager", what: "read a connected account again now" },
  // Idea 53: an alert asks for a decision, so only those who may decide get them.
  "alerts.subscribe": { min: "manager", what: "get phone alerts for proposals" },

  // ── owners only ──
  "connections.manage": { min: "owner", what: "connect or disconnect accounts" },
  "write_access.manage": { min: "owner", what: "grant or take back write access" },
  "billing.manage": { min: "owner", what: "pay for the report" },
  "erasure.run": { min: "owner", what: "erase a customer's details" },
  "data.import": { min: "owner", what: "import a file of customers, stock or bookings" },
  "team.manage": { min: "owner", what: "invite, change or remove people on the team" },
  // P6-06 (rule 28 amended): each person's own figures are the owner's alone,
  // to read as much as to change. A manager or viewer is never shown them.
  "people.read": { min: "owner", what: "see each person's own figures" },
  "people.manage": {
    min: "owner",
    what: "state a person's weekly capacity or remove a person from the figures",
  },
  "rules.manage": { min: "owner", what: "change how I work for this business" },
  "profile.edit": { min: "owner", what: "change the business's facts, goals or limits" },
  "report.generate": { min: "owner", what: "make a new report" },
  "report.respond": { min: "owner", what: "answer the report's findings" },
  "report.share": { min: "owner", what: "share the report outside SYB" },
  "competitors.manage": { min: "owner", what: "change or research the competitor list" },
  "site.audit": { min: "owner", what: "check the website" },

  "support.settings": { min: "owner", what: "change how support is set up" },
  "reviews.settings": { min: "owner", what: "change the address reviews are forwarded to" },
  "summary.settings": { min: "owner", what: "switch the weekly summary on or off" },
  "stop.resume": { min: "owner", what: "start things up again after a stop" },
  // L-1: what the business's customers read, and the currency every figure is in.
  "business.locale": { min: "owner", what: "change the business's language or currency" },
  // P6-05 (rule 26 amended): money is the owner's. Preparing a payment,
  // approving one, stating the bank details it is paid from, downloading
  // the bank file and saying it was paid are an owner's alone.
  "payments.prepare": { min: "owner", what: "prepare payments or say one was paid" },
  // Least privilege (the owner's decision of 2026-11-09): the payments list
  // and the bank files are the owner's to see as well. A manager or a viewer
  // gets this refusal, on every payments route, and the menu hides it.
  "payments.read": { min: "owner", what: "see payments and their bank files" },
  // P6-08 (rule 32): a caller's recorded voice is heard by the owner alone.
  "phone.recordings": { min: "owner", what: "listen to call recordings" },
} as const satisfies Record<string, RoleActionRow>;

export type RoleAction = keyof typeof ROLE_ACTIONS;

export const ROLE_ACTION_KEYS = Object.keys(ROLE_ACTIONS) as RoleAction[];

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export function isRoleAction(v: unknown): v is RoleAction {
  return typeof v === "string" && Object.hasOwn(ROLE_ACTIONS, v);
}

/** Pure: whether a role may take an action. */
export function roleAllows(role: Role, action: RoleAction): boolean {
  return RANK[role] >= RANK[ROLE_ACTIONS[action].min];
}

/** Pure: every action, and whether this role may take it — what the screens read. */
export function permissionsFor(role: Role): Record<RoleAction, boolean> {
  const out = {} as Record<RoleAction, boolean>;
  for (const a of ROLE_ACTION_KEYS) out[a] = roleAllows(role, a);
  return out;
}

/** Pure: the English refusal, composed from the table — what the catalogue's English holds. */
export function englishRefusal(action: RoleAction): string {
  const row: RoleActionRow = ROLE_ACTIONS[action];
  const who = row.min === "owner" ? "an owner" : "an owner or a manager";
  return `Only ${who} can ${row.what}.`;
}

/** The catalogue key of an action's refusal: "proposals.decide" → "refusal.proposals_decide". */
export const refusalKey = (action: RoleAction): string => `refusal.${action.replace(/\./g, "_")}`;

/** Pure: the sentence a refused person reads ("Only an owner can connect accounts."). */
export function refusalFor(action: RoleAction, tr: Tr = englishTr("roleWords")): string {
  return tr(refusalKey(action));
}

/** The plain name of a role, for the screens. */
export const ROLE_WORD: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  viewer: "Viewer",
};

// Who on a team may do what — idea 52 (TASKS-FEEDBACK.md, I-52.3).
//
// One table, ROLE_ACTIONS: every action a mutating route can take, the
// least role that may take it, and the words for it. It is data, so the
// tests read it whole, and every mutating route under app/api calls
// requireRole with one of its keys (a structural test fails the build on
// a route that doesn't — app/api/role-wiring.test.ts).
//
// The three roles, as the owner chose them (2026-10-29), conservative:
//
//   owner    everything;
//   manager  approve or decline proposals, ask for them, draft content,
//            answer support, and press the stop. Never connect or
//            disconnect accounts, grant or take back write access (rule
//            13's separate consent stays the owner's), change hard limits,
//            billing, erasure, the team, or the business's own rules;
//   viewer   reads, and presses the emergency stop (stopping is always
//            the safe direction, rule 15).
//
// Anything the plan didn't name went to the owner: the stricter reading.
//
// A team member is never an employee record (rule 28): a role says what
// a person may DO here, and nothing in SYB scores or judges them.

import { NextResponse } from "next/server";
import type { Access } from "./access";
import type { Role, RoleAction } from "./role-actions";
import { ROLE_ACTIONS, refusalFor, roleAllows } from "./role-actions";
import type { AuthedSession } from "./service";
import type { AppLocale } from "../i18n/locales";
import { resolveLanguage } from "../i18n/locales";
import { isLanguageReviewer } from "../i18n/review";
import { trFor } from "../i18n/server-tr";

export * from "./role-actions";

type Who = AuthedSession | Pick<Access, "owned" | "session"> | null | undefined;

/**
 * L-4a: the language a refusal is written in — the signed-in person's own
 * (users.language), through the status gate (rule 6 of TASKS-LANGUAGES):
 * a review language only for a named reviewer. English otherwise, and for
 * the anonymous interview, which has nobody to ask.
 */
export function languageOf(who: Who): AppLocale {
  const session = !who ? null : "role" in who ? who : who.session;
  if (!session) return "en";
  return resolveLanguage(session.language, isLanguageReviewer(session));
}

/**
 * Pure: the role a caller acts with. A signed-in session carries its
 * users row's role. An access to a business nobody owns yet (the
 * anonymous intake, before sign-up) is that business's only person, so
 * it acts as its owner. An owned business always comes with a matching
 * session (lib/auth/access), so anything else is no role at all.
 */
export function roleOf(who: Who): Role | null {
  if (!who) return null;
  if ("role" in who) return who.role;
  if (who.session) return who.session.role;
  return who.owned ? null : "owner";
}

/**
 * The one check every mutating route makes. Null means go ahead; otherwise
 * the response to return — 401 with no one to ask, 403 with the reason in
 * plain words for a role that may not.
 */
export function requireRole(who: Who, action: RoleAction): NextResponse | null {
  const role = roleOf(who);
  if (role === null) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }
  if (roleAllows(role, action)) return null;
  return NextResponse.json(
    {
      error: refusalFor(action, trFor(languageOf(who), "roleWords")),
      needs: ROLE_ACTIONS[action].min,
      role,
    },
    { status: 403 },
  );
}

// The team module switch — P5-18 (Phase 5 Session E, rule 28).
//
// Staff planning is OFF by default and switched on per business by the
// owner, on /watch's Modules card. The switch is a row in account_modules
// like the other modules, with one difference: a missing row means OFF.
// The other modules default on because they only record what the owner
// wants later; this one turns a screen and a calculation on, and rule 28
// says that happens only when the owner asks for it.
//
// When it is off, nothing in Session E runs or shows: /api/team answers
// "off" without reading a booking or a role, /team says how to switch it
// on, and the menu leaves the item out.

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { accountModules } from "../../db/schema";

export const TEAM_MODULE = "team";

/** Rule 28: off until the owner switches it on. A business with no row is off. */
export const TEAM_DEFAULT_ON = false;

/** Shown beside the switch, so the screen never has to invent the explanation. */
export const TEAM_WHY =
  "Team: when the week needs more cover, or has more than it needs, by role and hour. It never scores, ranks or says anything about a person. Off unless you switch it on.";

/** Pure: whether the module is on, from the account's module rows. */
export function teamOnFrom(rows: readonly { module: string; enabled: boolean }[]): boolean {
  const row = rows.find((r) => r.module === TEAM_MODULE);
  return row ? row.enabled : TEAM_DEFAULT_ON;
}

/** Whether the owner has switched the team module on for this account. */
export async function teamModuleOn(accountId: string): Promise<boolean> {
  const rows = await db
    .select({ module: accountModules.module, enabled: accountModules.enabled })
    .from(accountModules)
    .where(and(eq(accountModules.account_id, accountId), eq(accountModules.module, TEAM_MODULE)));
  return teamOnFrom(rows);
}

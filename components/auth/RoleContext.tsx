"use client";

// Who is signed in here, for the screens — idea 52 (I-52.3).
//
// The frame reads /api/nav once per move and hands its `access` down, so a
// screen can disable what the signed-in role can't do and say why, in the
// same words the server answers with (lib/auth/roles: refusalFor). The
// server is the authority: every mutating route checks the role itself.
// While the role is still loading, nothing is disabled — a click a role
// can't make is refused by the route, in those same words.
//
// L-4a: the reason is the "roleWords" catalogue's, in the reader's language.

import { createContext, useContext } from "react";
import type { NavAccess } from "../../app/api/nav/route";
import type { RoleAction } from "../../lib/auth/role-actions";
import { refusalFor, roleAllows } from "../../lib/auth/role-actions";
import { useTr } from "../sheet/useTr";

const AccessContext = createContext<NavAccess | null>(null);

export const AccessProvider = AccessContext.Provider;

export interface RoleGate {
  /** Null until the frame's first read. */
  access: NavAccess | null;
  can: (action: RoleAction) => boolean;
  /** The sentence beside a disabled control; null when the role may. */
  why: (action: RoleAction) => string | null;
}

export function useRole(): RoleGate {
  const access = useContext(AccessContext);
  const { tr } = useTr("roleWords");
  const can = (action: RoleAction) => access === null || roleAllows(access.role, action);
  return { access, can, why: (action) => (can(action) ? null : refusalFor(action, tr)) };
}

// The signed-in person for the Partner Console's pages: a firm member acts as
// themselves (their session), never through a business's door. Server only.

import { cookies } from "next/headers";
import { AUTH_COOKIE } from "../auth/access";
import { currentSession } from "../auth/service";

export async function partnerSession() {
  const store = await cookies();
  return currentSession(store.get(AUTH_COOKIE)?.value);
}

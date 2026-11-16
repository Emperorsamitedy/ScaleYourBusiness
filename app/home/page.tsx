// /home — Today · Home (2026-11-15): the first screen after sign-in. The
// screen is a client component reading the owner screens' own APIs.
//
// Signed out, Home is never shown empty. Before it renders, the server asks
// the same door every profile route uses (lib/auth/access). Without access
// the visitor goes to sign in, or to "Which business?" when their sign-in
// is still open and only the business is missing; every sign-in lands back
// here. A check that fails is not a signed-out visitor: Home then opens,
// and its own reads say what they could not do.

import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { HomeScreen } from "../../components/home/HomeScreen";
import { AUTH_COOKIE, resolveAccess } from "../../lib/auth/access";
import { currentSession } from "../../lib/auth/service";
import { logSafeError } from "../../lib/core/log-safe";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("home.meta");
  return { title: t("title") };
}

export const dynamic = "force-dynamic";

/** Where a visitor goes instead of Home, or null when Home opens for them. */
async function elsewhere(): Promise<string | null> {
  if (await resolveAccess()) return null;
  const store = await cookies();
  const session = await currentSession(store.get(AUTH_COOKIE)?.value);
  return session ? "/login/choose" : "/login";
}

export default async function HomePage() {
  let to: string | null = null;
  try {
    to = await elsewhere();
  } catch (error) {
    console.error(JSON.stringify({ event: "home_access_check_failed", ...logSafeError(error) }));
  }
  // redirect() throws to end the render, so it stays outside the try.
  if (to) redirect(to);
  return <HomeScreen />;
}

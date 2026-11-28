// /home — Today · Home (2026-11-15): the first screen after sign-in once the
// business is set up; before its first diagnosis, Home is Getting started
// (/start, ux-spec §7.0). The screen is a client component reading the owner
// screens' own APIs.
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
import { profileKind } from "../../lib/ideas/keep";
import { journeyFor } from "../../lib/journey/read";
import type { Journey } from "../../lib/journey/stage";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("home.meta");
  return { title: t("title") };
}

export const dynamic = "force-dynamic";

/**
 * Where a visitor goes instead of Home, or null when Home opens for them.
 * The journey (ux-spec §7.0): every sign-in, switch and finished interview
 * lands here, so this is the one place that decides. An idea is kept on its
 * own page; a business without its first diagnosis is still getting started.
 */
async function elsewhere(): Promise<{ to: string | null; journey: Journey | null }> {
  const access = await resolveAccess();
  if (access) {
    if ((await profileKind(access.profile_id)) === "idea")
      return { to: "/idea/mine", journey: null };
    const journey = await journeyFor(access.account_id, access.profile_id);
    return { to: journey.set_up ? null : "/start", journey };
  }
  const store = await cookies();
  const session = await currentSession(store.get(AUTH_COOKIE)?.value);
  return { to: session ? "/login/choose" : "/login", journey: null };
}

export default async function HomePage() {
  let to: string | null = null;
  let journey: Journey | null = null;
  try {
    ({ to, journey } = await elsewhere());
  } catch (error) {
    console.error(JSON.stringify({ event: "home_access_check_failed", ...logSafeError(error) }));
  }
  // redirect() throws to end the render, so it stays outside the try.
  if (to) redirect(to);
  // Set up, with the optional steps still open: Home carries a card for them.
  const setup = journey && journey.next !== null ? { done: journey.done, total: 5 } : null;
  return <HomeScreen setup={setup} />;
}

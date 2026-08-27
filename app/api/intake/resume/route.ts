// POST /api/intake/resume — the owner asks for a way back in.
//
// Takes an email, returns a link. Deliberately does not send anything:
// delivery is Session I's problem, and until then the link is shown on
// screen so an owner can mail it to themselves. Better a visible link
// than a promised email that never arrives.

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "../../../../db";
import { businessProfiles } from "../../../../db/schema";
import { issueResumeLink, ResumeError, resumeUrl } from "../../../../lib/intake/resume";

const COOKIE = "syb_intake_profile";

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const store = await cookies();
    const profileId = store.get(COOKIE)?.value;
    if (!profileId) {
      return NextResponse.json({ error: "no intake session" }, { status: 404 });
    }
    const exists = await db
      .select({ id: businessProfiles.id })
      .from(businessProfiles)
      .where(eq(businessProfiles.id, profileId));
    if (exists.length === 0) {
      return NextResponse.json({ error: "no intake session" }, { status: 404 });
    }

    const body = (await request.json()) as { email?: unknown };
    if (typeof body.email !== "string") {
      return NextResponse.json({ error: "an email address is needed" }, { status: 422 });
    }

    const link = await issueResumeLink(profileId, body.email);
    const origin = request.nextUrl.origin;
    return NextResponse.json({
      email: link.email,
      url: resumeUrl(origin, link.token),
      expires_at: link.expires_at,
    });
  } catch (error) {
    if (error instanceof ResumeError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error(JSON.stringify({ msg: "resume link failed", error: String(error) }));
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

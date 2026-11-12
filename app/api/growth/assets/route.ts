// POST /api/growth/assets — add a photo or a short clip to the library
// (v1 spec §10.4), with its rights record: who shot it, whether a person
// appears, and their release where one does. Multipart; capped, because a
// serverless body is; longer footage arrives through a shot list's upload
// (lib/content/footage.ts).

import { type NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { resolveAccess } from "../../../../lib/auth/access";
import { requireRole } from "../../../../lib/auth/roles";
import { appOriginOf, isSameOriginPost } from "../../../../lib/auth/same-origin";
import { logSafeError } from "../../../../lib/core/log-safe";
import { configuredMediaStore } from "../../../../lib/content/media";
import { LibraryError, addAsset } from "../../../../lib/growth/library";

const MAX_BYTES = 4 * 1024 * 1024;
const TYPES: Record<string, "photo" | "video"> = {
  "image/jpeg": "photo",
  "image/png": "photo",
  "video/mp4": "video",
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!isSameOriginPost(request.headers, appOriginOf(request.url))) {
    return NextResponse.json({ error: "add it from our own page" }, { status: 403 });
  }
  const access = await resolveAccess();
  if (!access) return NextResponse.json({ error: "no session" }, { status: 401 });
  const denied = requireRole(access, "growth.manage");
  if (denied) return denied;
  const store = configuredMediaStore();
  if (!store)
    return NextResponse.json(
      { error: "media storage isn't set up on this server" },
      { status: 503 },
    );
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File))
      return NextResponse.json({ error: "choose a file" }, { status: 422 });
    const kind = TYPES[file.type];
    if (!kind) return NextResponse.json({ error: "a JPEG, a PNG or an MP4" }, { status: 415 });
    if (file.size > MAX_BYTES)
      return NextResponse.json(
        { error: "up to 4 MB here; longer clips go through a shot list" },
        { status: 413 },
      );
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = file.type === "video/mp4" ? "mp4" : file.type === "image/png" ? "png" : "jpg";
    const stored = await store.put(
      `library/${access.profile_id}/${randomBytes(8).toString("hex")}.${ext}`,
      bytes,
      file.type,
    );
    const release = String(form.get("identity_release_id") ?? "");
    const asset = await addAsset({
      profileId: access.profile_id,
      kind,
      url: stored.url,
      contentType: file.type,
      description: String(form.get("description") ?? ""),
      shotBy: String(form.get("shot_by") ?? ""),
      personAppears: form.get("person_appears") === "on" || form.get("person_appears") === "true",
      identityReleaseId: /^[0-9a-f-]{36}$/.test(release) ? release : null,
    });
    return NextResponse.json({ id: asset.id });
  } catch (error) {
    if (error instanceof LibraryError)
      return NextResponse.json({ error: error.message }, { status: error.status });
    console.error(
      JSON.stringify({
        event: "asset_add_failed",
        account_id: access.account_id,
        ...logSafeError(error),
      }),
    );
    return NextResponse.json({ error: "something went wrong on our side" }, { status: 500 });
  }
}

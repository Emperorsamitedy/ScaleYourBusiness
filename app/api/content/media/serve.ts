// An item's own picture or clip, read back for its business — the body of
// GET /api/content/media?item_id=<id> (the /content gallery's tiles).
//
// The caller names an ITEM, never a path: the stored address is looked up
// from the item, scoped to the caller's business, and opened through the
// media store, which refuses anything that isn't its own. The address never
// leaves the server and the answer is private to the browser that asked.
// Every lookup is injected, so the access rule is tested without a database.

import { logSafeError } from "../../../../lib/core/log-safe";
import type { MediaStore } from "../../../../lib/content/media";
import { MediaError, contentTypeFor } from "../../../../lib/content/media";

/** Read into memory to be served, so capped: a larger render is refused, not streamed. */
export const SERVE_MAX_BYTES = 80 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ServeDeps {
  /** The one door (lib/auth/access resolveAccess): the caller's business, or null. */
  access: () => Promise<{ profile_id: string; account_id: string } | null>;
  /** The stored address of THIS business's item; null when it isn't theirs or carries no media. */
  mediaPathOf: (profileId: string, itemId: string) => Promise<string | null>;
  store: () => MediaStore | null;
}

function refuse(error: string, status: number, extra: Record<string, string> = {}): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

/** One `bytes=a-b` range over `size` bytes; null when there is none, "bad" when it can't be met. */
function rangeOf(
  header: string | null,
  size: number,
): { start: number; end: number } | "bad" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return "bad";
  if (m[1] === "") {
    const tail = Number(m[2]);
    return tail > 0 ? { start: Math.max(0, size - tail), end: size - 1 } : "bad";
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start < size && start <= end ? { start, end } : "bad";
}

export async function serveItemMedia(
  args: { itemId: string | null; range: string | null },
  deps: ServeDeps,
): Promise<Response> {
  const access = await deps.access();
  if (!access) return refuse("no intake session", 401);
  if (!args.itemId || !UUID_RE.test(args.itemId)) return refuse("no such media", 404);
  try {
    const stored = await deps.mediaPathOf(access.profile_id, args.itemId);
    if (!stored) return refuse("no such media", 404);
    const store = deps.store();
    if (!store?.get) return refuse("media storage isn't set up on this server", 503);
    const contentType = contentTypeFor(stored);
    const body = await store.get(stored, SERVE_MAX_BYTES);
    const size = body.byteLength;
    const range = rangeOf(args.range, size);
    if (range === "bad")
      return refuse("range not satisfiable", 416, { "Content-Range": `bytes */${size}` });
    const start = range?.start ?? 0;
    const length = (range?.end ?? size - 1) - start + 1;
    return new Response(Buffer.from(body.subarray(start, start + length)), {
      status: range ? 206 : 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(length),
        ...(range ? { "Content-Range": `bytes ${start}-${range.end}/${size}` } : {}),
        "Accept-Ranges": "bytes",
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=300",
        "Cross-Origin-Resource-Policy": "same-origin",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof MediaError) return refuse(error.message, error.status);
    console.error(
      JSON.stringify({
        event: "content_media_read_failed",
        account_id: access.account_id,
        item_id: args.itemId,
        ...logSafeError(error),
      }),
    );
    return refuse("something went wrong on our side", 500);
  }
}

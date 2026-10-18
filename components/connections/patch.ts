// Connections — the words the patch panel prints, pure so they are tested
// (the owner's Connections design, 2026-10-17). Every line is read off the
// API: what a source gives is the scope registry's own "why" (SCOPE_GUIDE),
// trimmed to its subject; the headline counts connections that are actually
// reading, and it says so the moment anything can write (P3-20h).

export interface GuideLine {
  why: string;
}

/** "Your orders, which is where…" → "your orders"; joined for the row. */
export function gives(guide: readonly GuideLine[]): string {
  const parts: string[] = [];
  for (const g of guide) {
    const head = (g.why.split(/[,.]/)[0] ?? "").trim();
    if (head === "") continue;
    const word = parts.length === 0 ? head : head.charAt(0).toLowerCase() + head.slice(1);
    if (!parts.some((p) => p.toLowerCase() === word.toLowerCase())) parts.push(word);
  }
  return parts.join(", ");
}

export interface CountedConnection {
  status: "connected" | "paused" | "failed" | "disconnected";
}

export interface WriteConnection extends CountedConnection {
  label: string;
}

/** The screen's one line: what reads, and whether anything can write. */
export function headline(
  reads: readonly CountedConnection[],
  /** null when the write side couldn't be read — then the line doesn't guess. */
  writes: readonly WriteConnection[] | null,
): string {
  const reading = reads.filter((c) => c.status === "connected").length;
  const stalled = reads.filter((c) => c.status === "failed" || c.status === "paused").length;
  const readPart =
    reading > 0
      ? `${reading} ${reading === 1 ? "source" : "sources"} read.`
      : stalled > 0
        ? "Nothing is reading right now."
        : "Nothing is plugged in yet.";
  // Any write consent still on record counts, working or not: the token is held.
  if (writes === null) return `${readPart} Write access couldn't be read.`;
  const writing = writes.filter((c) => c.status !== "disconnected");
  const writePart =
    writing.length === 0
      ? "Nothing can be written."
      : `${writing.map((c) => c.label).join(" and ")} can write — only what you approve.`;
  return `${readPart} ${writePart}`;
}

/** Postgres prints "2026-10-17 15:20:35.26+00"; make it ISO before parsing. */
export function parseTs(s: string): number {
  const iso = s
    .trim()
    .replace(" ", "T")
    .replace(/([+-]\d\d)$/, "$1:00");
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.parse(s) : ms;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "14:00" today, "9 Oct" before, "—" never. */
export function lastRead(iso: string | null, now: number): string {
  if (iso === null) return "—";
  const ms = parseTs(iso);
  if (Number.isNaN(ms)) return "—";
  const d = new Date(ms);
  if (new Date(now).toDateString() === d.toDateString()) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ""}`;
}

// A read's progress as lines: what `POST /api/connections/sync` sends when it
// is asked for them, and how the Connections screen reads them. Pure: no
// database, no server module, so the screen imports it as it is.
//
// One JSON object per line. While pages arrive: { type: "progress", step,
// pages, observations }. Last, either the summary a plain call returns
// ({ type: "done", ok, skipped, kind, pages, observations, error }) or
// { type: "failed", error } when the read could not be run at all. Counts and
// SYB's own words only: nothing of the provider's is in a line.

/** The media type a caller asks for to get the lines. */
export const SYNC_STREAM_TYPE = "application/x-ndjson";

export interface SyncProgressLine {
  type: "progress";
  /** "reading": pages are still arriving. "working": all read, the facts and checks follow. */
  step: "reading" | "working";
  pages: number;
  observations: number;
}

export interface SyncDoneLine {
  type: "done";
  ok: boolean;
  skipped: string | null;
  kind: string | null;
  pages: number;
  observations: number;
  error: string | null;
}

export interface SyncFailedLine {
  type: "failed";
  error: string;
}

export type SyncLine = SyncProgressLine | SyncDoneLine | SyncFailedLine;

const count = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
const textOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** One line as a message, or null for a line that is not one of ours. */
export function readSyncLine(line: string): SyncLine | null {
  const text = line.trim();
  if (text === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const m = value as Record<string, unknown>;
  if (m.type === "progress") {
    return {
      type: "progress",
      step: m.step === "working" ? "working" : "reading",
      pages: count(m.pages),
      observations: count(m.observations),
    };
  }
  if (m.type === "done") {
    return {
      type: "done",
      ok: m.ok === true,
      skipped: textOrNull(m.skipped),
      kind: textOrNull(m.kind),
      pages: count(m.pages),
      observations: count(m.observations),
      error: textOrNull(m.error),
    };
  }
  if (m.type === "failed") {
    return { type: "failed", error: textOrNull(m.error) ?? "" };
  }
  return null;
}

/**
 * Text arrives in pieces that do not end where lines do. Give the text held
 * over from last time and the new piece; get the whole lines and what to hold
 * over next.
 */
export function splitLines(held: string, piece: string): { lines: string[]; held: string } {
  const parts = (held + piece).split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim() !== ""), held: rest };
}

/**
 * Read a response's body as sync lines, calling `onLine` for each as it
 * arrives. Resolves when the body ends. A last line with no newline after it
 * still counts.
 */
export async function readSyncStream(
  body: ReadableStream<Uint8Array>,
  onLine: (line: SyncLine) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let held = "";
  const give = (lines: readonly string[]) => {
    for (const l of lines) {
      const message = readSyncLine(l);
      if (message) onLine(message);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const next = splitLines(held, decoder.decode(value, { stream: true }));
    held = next.held;
    give(next.lines);
  }
  give([held + decoder.decode()]);
}

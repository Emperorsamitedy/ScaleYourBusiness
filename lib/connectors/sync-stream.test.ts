// A read's progress as lines: what the screen makes of what arrives, however
// the network cuts it up. Pure.

import { describe, expect, it } from "vitest";
import type { SyncLine } from "./sync-stream";
import { SYNC_STREAM_TYPE, readSyncLine, readSyncStream, splitLines } from "./sync-stream";

/** A body that arrives in exactly these pieces. */
function body(pieces: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    },
  });
}

const collect = async (pieces: readonly string[]): Promise<SyncLine[]> => {
  const seen: SyncLine[] = [];
  await readSyncStream(body(pieces), (line) => seen.push(line));
  return seen;
};

describe("one line is one message", () => {
  it("reads a page landing, the working step and the summary", () => {
    expect(
      readSyncLine('{"type":"progress","step":"reading","pages":2,"observations":180}'),
    ).toEqual({ type: "progress", step: "reading", pages: 2, observations: 180 });
    expect(
      readSyncLine('{"type":"progress","step":"working","pages":13,"observations":1095}'),
    ).toMatchObject({ step: "working", observations: 1095 });
    expect(
      readSyncLine(
        '{"type":"done","ok":true,"skipped":null,"kind":"backfill","pages":13,"observations":1095,"error":null}',
      ),
    ).toEqual({
      type: "done",
      ok: true,
      skipped: null,
      kind: "backfill",
      pages: 13,
      observations: 1095,
      error: null,
    });
    expect(readSyncLine('{"type":"failed","error":"something went wrong on our side"}')).toEqual({
      type: "failed",
      error: "something went wrong on our side",
    });
  });

  it("makes nothing of a line that is not one of ours", () => {
    expect(readSyncLine("")).toBeNull();
    expect(readSyncLine("   ")).toBeNull();
    expect(readSyncLine("<html>502 Bad Gateway</html>")).toBeNull();
    expect(readSyncLine('"progress"')).toBeNull();
    expect(readSyncLine('{"type":"something else"}')).toBeNull();
  });

  it("never shows a count that is not a count", () => {
    expect(
      readSyncLine('{"type":"progress","step":"sideways","pages":-4,"observations":"many"}'),
    ).toEqual({ type: "progress", step: "reading", pages: 0, observations: 0 });
    expect(readSyncLine('{"type":"done","ok":"yes","observations":12.9}')).toMatchObject({
      ok: false,
      observations: 12,
      skipped: null,
      error: null,
    });
  });
});

describe("text arrives in pieces that do not end where lines do", () => {
  it("holds a half line over until the rest of it comes", () => {
    const first = splitLines("", '{"a":1}\n{"b"');
    expect(first).toEqual({ lines: ['{"a":1}'], held: '{"b"' });
    expect(splitLines(first.held, ":2}\n")).toEqual({ lines: ['{"b":2}'], held: "" });
    expect(splitLines("", "\n\n")).toEqual({ lines: [], held: "" });
  });

  it("gives every message once, in order, whatever the pieces", async () => {
    const text =
      '{"type":"progress","step":"reading","pages":1,"observations":90}\n' +
      '{"type":"progress","step":"reading","pages":2,"observations":180}\n' +
      '{"type":"progress","step":"working","pages":2,"observations":180}\n' +
      '{"type":"done","ok":true,"skipped":null,"kind":"incremental","pages":2,"observations":180,"error":null}\n';
    const whole = await collect([text]);
    expect(whole.map((l) => l.type)).toEqual(["progress", "progress", "progress", "done"]);
    // Cut in the middle of a line, in the middle of a word, and one character at a time.
    expect(await collect([text.slice(0, 31), text.slice(31, 140), text.slice(140)])).toEqual(whole);
    expect(await collect([...text])).toEqual(whole);
  });

  it("still counts a last line with no newline after it, and a letter cut across two pieces", async () => {
    const done = '{"type":"failed","error":"nem sikerült"}';
    expect(await collect([done])).toEqual([{ type: "failed", error: "nem sikerült" }]);
    // "ü" is two bytes: split between them, it must still come out whole.
    const bytes = new TextEncoder().encode(`${done}\n`);
    const cut = bytes.indexOf(0xc3) + 1;
    const seen: SyncLine[] = [];
    await readSyncStream(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, cut));
          controller.enqueue(bytes.slice(cut));
          controller.close();
        },
      }),
      (line) => seen.push(line),
    );
    expect(seen).toEqual([{ type: "failed", error: "nem sikerült" }]);
  });

  it("is asked for by its own media type", () => {
    expect(SYNC_STREAM_TYPE).toBe("application/x-ndjson");
  });
});

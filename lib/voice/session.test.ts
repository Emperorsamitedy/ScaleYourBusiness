// Idea 50: listening sessions against a fake SpeechRecognition — hidden
// where unsupported, the notice before any audio leaves the device,
// on-device when the browser has it, nothing but the box's text touched,
// the one-minute cap, silence, the owner's typing, and a refused
// microphone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecognitionCtor, RecognitionErrorLike, RecognitionEventLike } from "./session";
import {
  CAP_MS,
  NOTICE,
  NOTICE_KEY,
  SILENCE_MS,
  SpeechSession,
  errorWords,
  recognitionIn,
} from "./session";
import type { ResultListLike } from "./transcript";

function results(...rows: [text: string, isFinal: boolean][]): ResultListLike {
  return rows.map(([transcript, isFinal]) => ({ isFinal, length: 1, 0: { transcript } }));
}

class FakeRecognition {
  static made: FakeRecognition[] = [];
  static startThrows = false;
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  processLocally?: boolean;
  onresult: ((e: RecognitionEventLike) => void) | null = null;
  onerror: ((e: RecognitionErrorLike) => void) | null = null;
  onend: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  started = false;
  stopped = 0;
  aborted = false;
  constructor() {
    FakeRecognition.made.push(this);
  }
  start(): void {
    if (FakeRecognition.startThrows) throw new Error("InvalidStateError");
    this.started = true;
  }
  /** The browser delivers its last words, then ends. */
  stop(): void {
    this.stopped += 1;
    this.onend?.();
  }
  abort(): void {
    this.aborted = true;
  }
  say(...rows: [string, boolean][]): void {
    this.onresult?.({ results: results(...rows) });
  }
  fail(error: string): void {
    this.onerror?.({ error });
    this.onend?.();
  }
}

function memoryStore(seen = false) {
  const m = new Map<string, string>(seen ? [[NOTICE_KEY, "1"]] : []);
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    map: m,
  };
}

/** A text box and the session over it; `calls` is everything the session did to the page. */
function rig(
  opts: { ctor?: RecognitionCtor | null; text?: string; seen?: boolean; lang?: string } = {},
) {
  const box = { text: opts.text ?? "" };
  const calls: string[] = [];
  const store = memoryStore(opts.seen ?? true);
  const session = new SpeechSession({
    Recognition: opts.ctor === undefined ? (FakeRecognition as RecognitionCtor) : opts.ctor,
    lang: opts.lang ?? "en-GB",
    getText: () => box.text,
    setText: (next) => {
      calls.push(next);
      box.text = next;
    },
    after: "Read it over, then record it.",
    store,
  });
  const rec = () => FakeRecognition.made.at(-1)!;
  return { box, calls, store, session, rec };
}

beforeEach(() => {
  FakeRecognition.made = [];
  FakeRecognition.startThrows = false;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("feature detection", () => {
  it("finds the standard or the webkit-prefixed constructor", () => {
    expect(recognitionIn({ SpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
    expect(recognitionIn({ webkitSpeechRecognition: FakeRecognition })).toBe(FakeRecognition);
  });

  it("finds nothing where the browser has none (Firefox), without an error", () => {
    expect(recognitionIn({})).toBeNull();
    expect(recognitionIn({ SpeechRecognition: "not a constructor" })).toBeNull();
    expect(recognitionIn(undefined)).toBeNull();
  });

  it("an unsupported session reports so and a tap does nothing", async () => {
    const { session, calls } = rig({ ctor: null });
    expect(session.supported).toBe(false);
    await session.toggle();
    expect(session.current.phase).toBe("idle");
    expect(calls).toEqual([]);
  });
});

describe("who hears it", () => {
  it("first use in a browser shows the notice and listens only on the next tap", async () => {
    const { session, store, rec } = rig({ seen: false });
    await session.toggle();
    expect(session.current.phase).toBe("notice");
    expect(session.current.notice).toBe(NOTICE);
    expect(FakeRecognition.made).toHaveLength(0); // no audio before the owner has read it
    await session.toggle();
    expect(session.current.phase).toBe("listening");
    expect(rec().processLocally).toBeUndefined();
    expect(store.map.get(NOTICE_KEY)).toBe("1");
  });

  it("once seen in this browser, the notice is not shown again", async () => {
    const { session } = rig({ seen: true });
    await session.toggle();
    expect(session.current.phase).toBe("listening");
    expect(session.current.notice).toBeNull();
  });

  it("recognises on the device, with no notice, when the language is already there", async () => {
    const available = vi.fn(async () => "available");
    class Local extends FakeRecognition {
      static available = available;
    }
    const { session, rec } = rig({ ctor: Local, seen: false, lang: "hu-HU" });
    await session.toggle();
    expect(available).toHaveBeenCalledWith({ langs: ["hu-HU"], processLocally: true });
    expect(session.current.phase).toBe("listening");
    expect(session.current.onDevice).toBe(true);
    expect(rec().processLocally).toBe(true);
    expect(rec().lang).toBe("hu-HU");
  });

  it("never downloads a language pack for the owner; a downloadable one gets the notice", async () => {
    const install = vi.fn(async () => true);
    class Downloadable extends FakeRecognition {
      static available = async () => "downloadable";
      static install = install;
    }
    const { session } = rig({ ctor: Downloadable, seen: false });
    await session.toggle();
    expect(install).not.toHaveBeenCalled();
    expect(session.current.phase).toBe("notice");
    expect(session.current.onDevice).toBe(false);
  });

  it("a failing availability check falls back to the notice", async () => {
    class Broken extends FakeRecognition {
      static available = async () => {
        throw new Error("SyntaxError");
      };
    }
    const { session } = rig({ ctor: Broken, seen: false });
    await session.toggle();
    expect(session.current.phase).toBe("notice");
  });
});

describe("listening", () => {
  it("asks for continuous, interim results in the given language", async () => {
    const { session, rec } = rig({ lang: "de-DE" });
    await session.toggle();
    expect(rec()).toMatchObject({
      lang: "de-DE",
      continuous: true,
      interimResults: true,
      maxAlternatives: 1,
      started: true,
    });
  });

  it("puts guesses then final words in the box after what was typed", async () => {
    const { session, rec, box } = rig({ text: "We sell coffee." });
    await session.toggle();
    rec().say(["mostly to", false]);
    expect(box.text).toBe("We sell coffee. Mostly to");
    rec().say(["mostly to offices", true]);
    expect(box.text).toBe("We sell coffee. Mostly to offices");
  });

  it("nothing is submitted by speech: the only thing it does is set the box's text", async () => {
    const { session, rec, calls } = rig();
    await session.toggle();
    rec().say(["we close on sundays", true]);
    await session.toggle(); // second tap stops
    expect(rec().stopped).toBe(1);
    expect(session.current.phase).toBe("idle");
    expect(session.current.message).toBe("Read it over, then record it.");
    expect(calls).toEqual(["We close on sundays"]);
  });

  it("stops at the one-minute cap and says so", async () => {
    const { session, rec } = rig();
    await session.toggle();
    const step = SILENCE_MS / 2;
    let t = 0;
    while (t + step < CAP_MS) {
      rec().say(["still talking", false]); // talking keeps the silence timer back
      vi.advanceTimersByTime(step);
      t += step;
    }
    rec().say(["still talking", false]);
    vi.advanceTimersByTime(CAP_MS - t - 1);
    expect(session.current.phase).toBe("listening");
    vi.advanceTimersByTime(1);
    expect(rec().stopped).toBe(1);
    expect(session.current.phase).toBe("idle");
    expect(session.current.message).toMatch(/after a minute/);
  });

  it("stops after a stretch of silence", async () => {
    const { session, rec } = rig();
    await session.toggle();
    vi.advanceTimersByTime(SILENCE_MS - 1);
    expect(session.current.phase).toBe("listening");
    vi.advanceTimersByTime(1);
    expect(rec().stopped).toBe(1);
    expect(session.current.phase).toBe("idle");
  });

  it("the owner typing while listening ends it, and their text is never overwritten", async () => {
    const { session, rec, box, calls } = rig({ text: "Typed" });
    await session.toggle();
    rec().say(["and spoken", false]);
    box.text = "Typed and fixed by hand"; // the owner edits
    rec().say(["and spoken words", true]);
    expect(box.text).toBe("Typed and fixed by hand");
    expect(calls).toEqual(["Typed and spoken"]);
    expect(rec().stopped).toBe(1);
  });

  it("noticeEdits ends listening as soon as the page sees the owner's edit", async () => {
    const { session, rec, box } = rig();
    await session.toggle();
    session.noticeEdits();
    expect(session.current.phase).toBe("listening"); // nothing changed yet
    box.text = "typed";
    session.noticeEdits();
    expect(rec().stopped).toBe(1);
    expect(session.current.phase).toBe("idle");
  });

  it("a box going away drops the audio and any words still on their way", async () => {
    const { session, rec, calls } = rig();
    await session.toggle();
    const r = rec();
    session.dispose();
    expect(r.aborted).toBe(true);
    expect(r.onresult).toBeNull();
    vi.advanceTimersByTime(CAP_MS);
    expect(calls).toEqual([]);
  });
});

describe("failures say what happened and what to do", () => {
  it("a refused microphone says it is blocked and how to allow it", async () => {
    const { session, rec, calls } = rig();
    await session.toggle();
    rec().fail("not-allowed");
    expect(session.current.phase).toBe("idle");
    expect(session.current.message).toMatch(/blocked/);
    expect(session.current.message).toMatch(/Allow it/);
    expect(session.current.message).not.toMatch(/sorry/i);
    expect(calls).toEqual([]);
  });

  it("a start the browser refuses returns to idle with words, not a thrown error", async () => {
    FakeRecognition.startThrows = true;
    const { session } = rig();
    await expect(session.toggle()).resolves.toBeUndefined();
    expect(session.current.phase).toBe("idle");
    expect(session.current.message).toMatch(/Press Speak to try again/);
  });

  it("every error code has words, and none apologises; aborted says nothing", () => {
    expect(errorWords("aborted", "en-GB")).toBeNull();
    for (const code of [
      "not-allowed",
      "service-not-allowed",
      "no-speech",
      "audio-capture",
      "network",
      "language-not-supported",
      "something-new",
    ]) {
      const w = errorWords(code, "en-GB");
      expect(w, code).toBeTruthy();
      expect(w, code).not.toMatch(/sorry|apolog/i);
    }
    expect(errorWords("language-not-supported", "cy-GB")).toMatch(/cy-GB/);
  });
});

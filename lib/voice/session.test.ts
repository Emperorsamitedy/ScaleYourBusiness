// Idea 50: listening sessions against a fake SpeechRecognition — hidden
// where unsupported, one press listens (the notice left the screen on
// 2026-11-17; the privacy page says who hears the audio), on-device when
// the browser has it, nothing but the box's text touched,
// the one-minute cap, silence, the owner's typing, and a refused
// microphone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecognitionCtor, RecognitionErrorLike, RecognitionEventLike } from "./session";
import {
  CAP_MS,
  END_GRACE_MS,
  ENGLISH_SESSION_WORDS,
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

/** A text box and the session over it; `calls` is everything the session did to the page. */
function rig(
  opts: {
    ctor?: RecognitionCtor | null;
    text?: string;
    lang?: string;
    after?: string | null;
  } = {},
) {
  const box = { text: opts.text ?? "" };
  const calls: string[] = [];
  const session = new SpeechSession({
    Recognition: opts.ctor === undefined ? (FakeRecognition as RecognitionCtor) : opts.ctor,
    lang: opts.lang ?? "en-GB",
    getText: () => box.text,
    setText: (next) => {
      calls.push(next);
      box.text = next;
    },
    after: opts.after === undefined ? "Read it over, then record it." : opts.after,
  });
  const rec = () => FakeRecognition.made.at(-1)!;
  return { box, calls, session, rec };
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
  // 2026-11-17, the owner: the privacy sentence leaves the screen. One press listens.
  it("one press listens, with no step in between, even where the browser's own service hears it", async () => {
    const { session, rec } = rig();
    await session.toggle();
    expect(session.current.phase).toBe("listening");
    expect(FakeRecognition.made).toHaveLength(1);
    expect(rec().processLocally).toBeUndefined(); // not on this device: the browser picks
    expect(session.current.onDevice).toBe(false);
    expect(Object.keys(session.current).sort()).toEqual(["message", "onDevice", "phase"]); // no notice left to show
  });

  it("recognises on the device when the language is already there", async () => {
    const available = vi.fn(async () => "available");
    class Local extends FakeRecognition {
      static available = available;
    }
    const { session, rec } = rig({ ctor: Local, lang: "hu-HU" });
    await session.toggle();
    expect(available).toHaveBeenCalledWith({ langs: ["hu-HU"], processLocally: true });
    expect(session.current.phase).toBe("listening");
    expect(session.current.onDevice).toBe(true);
    expect(rec().processLocally).toBe(true);
    expect(rec().lang).toBe("hu-HU");
  });

  it("never downloads a language pack for the owner; a downloadable one listens through the browser", async () => {
    const install = vi.fn(async () => true);
    class Downloadable extends FakeRecognition {
      static available = async () => "downloadable";
      static install = install;
    }
    const { session, rec } = rig({ ctor: Downloadable });
    await session.toggle();
    expect(install).not.toHaveBeenCalled();
    expect(session.current.phase).toBe("listening");
    expect(session.current.onDevice).toBe(false);
    expect(rec().processLocally).toBeUndefined();
  });

  it("a failing availability check still listens, never on the device by guess", async () => {
    class Broken extends FakeRecognition {
      static available = async () => {
        throw new Error("SyntaxError");
      };
    }
    const { session, rec } = rig({ ctor: Broken });
    await session.toggle();
    expect(session.current.phase).toBe("listening");
    expect(rec().processLocally).toBeUndefined();
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

  it("a box with nothing to say after a stop says nothing", async () => {
    const { session, rec } = rig({ after: null });
    await session.toggle();
    rec().say(["we close on sundays", true]);
    await session.toggle();
    expect(session.current).toMatchObject({ phase: "idle", message: null });
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
    expect(session.current.message).toBe(ENGLISH_SESSION_WORDS.cap);
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
    expect(session.current.message).toBe("Listening stopped.");
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
    // Small text (the owner, 2026-11-17): one short sentence, two at most, no instruction to press again.
    for (const code of ["not-allowed", "no-speech", "audio-capture", "network", "start-failed"]) {
      const w = errorWords(code, "en-GB") ?? "";
      expect(w.length, code).toBeLessThanOrEqual(80);
      expect(w, code).not.toMatch(/press speak/i);
    }
  });
});

// Review 2026-10-30: the box turning busy while a tap awaits the browser's
// availability answer, and a stop whose onend never comes.
describe("busy box, and a browser that never ends", () => {
  it("disabled while the availability check is in flight: the mic never starts", async () => {
    let answer: (v: string) => void = () => {};
    class Slow extends FakeRecognition {
      static available = () => new Promise<string>((r) => (answer = r));
    }
    const { session } = rig({ ctor: Slow });
    const tap = session.toggle();
    expect(session.current.phase).toBe("checking");
    session.setDisabled(true);
    expect(session.current.phase).toBe("idle");
    answer("available");
    await tap;
    expect(session.current.phase).toBe("idle");
    expect(FakeRecognition.made).toHaveLength(0);
    // A tap while disabled does nothing; once free again, a tap listens.
    await session.toggle();
    expect(FakeRecognition.made).toHaveLength(0);
    session.setDisabled(false);
    const again = session.toggle();
    answer("available");
    await again;
    expect(session.current.phase).toBe("listening");
  });

  it("disabled while listening stops it, with no words", async () => {
    const { session, rec } = rig();
    await session.toggle();
    session.setDisabled(true);
    expect(rec().stopped).toBe(1);
    expect(session.current).toMatchObject({ phase: "idle", message: null });
  });

  it("a stop whose onend never fires goes back to idle after the grace, aborting the mic", async () => {
    class Stuck extends FakeRecognition {
      stop(): void {
        this.stopped += 1; // and no onend
      }
    }
    const { session, rec } = rig({ ctor: Stuck });
    await session.toggle();
    session.stop("done");
    expect(session.current.phase).toBe("listening");
    vi.advanceTimersByTime(END_GRACE_MS - 1);
    expect(session.current.phase).toBe("listening");
    vi.advanceTimersByTime(1);
    expect(session.current).toMatchObject({ phase: "idle", message: "done" });
    expect(rec().aborted).toBe(true);
  });

  it("an onend that does come in time leaves no late timer behind", async () => {
    const { session, rec } = rig();
    await session.toggle();
    session.stop("done");
    expect(session.current.phase).toBe("idle");
    vi.advanceTimersByTime(END_GRACE_MS);
    expect(rec().aborted).toBe(false);
  });
});

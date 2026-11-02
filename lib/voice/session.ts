// Idea 50: one microphone's listening sessions, without React in it.
//
// The browser's own speech recognition (the Web Speech API) turns speech
// into text; SYB only places that text in the box the owner is looking
// at. Nothing here sends, saves or records anything: the one thing a
// session can do to the page is call setText, and every answer is still
// recorded by the owner's own click, exactly as if typed.
//
// Who hears the audio. Where the browser can recognise on the device
// (SpeechRecognition.available with processLocally, Chrome 139+ per MDN's
// compatibility data), the session asks for that and nothing else hears
// it. Otherwise the browser picks, and in Chrome that is Google's server:
// the first tap in a browser then shows NOTICE and listens only on the
// next tap, so the owner reads who hears it before any audio goes. A
// language pack is never downloaded on the owner's behalf (install()).
//
// A session stops on a second tap, after SILENCE_MS with nothing heard,
// at the CAP_MS cap, or when the owner types in the box — their own text
// is never overwritten (lib/voice/transcript.ts only appends).

import type { ResultListLike } from "./transcript";
import { mergeSpoken, spokenOf } from "./transcript";

export const CAP_MS = 60_000;
export const SILENCE_MS = 8_000;
/** Review 2026-10-30: a stop whose onend never comes is forced back to idle after this. */
export const END_GRACE_MS = 3_000;

/** The one plain line (TASKS-FEEDBACK.md, idea 50), shown before audio leaves the device. */
export const NOTICE =
  "Your browser turns your speech into text. In Chrome, Google does this; SYB never receives the audio.";

/** "Seen the notice" — per browser, so each new browser says it once. */
export const NOTICE_KEY = "syb.voice_notice_seen";

export interface RecognitionEventLike {
  readonly results: ResultListLike;
}

export interface RecognitionErrorLike {
  readonly error: string;
}

/** The part of SpeechRecognition this uses. */
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: RecognitionErrorLike) => void) | null;
  onend: (() => void) | null;
  onspeechstart?: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface RecognitionCtor {
  new (): RecognitionLike;
  available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string>;
}

type Store = Pick<Storage, "getItem" | "setItem">;

/** The constructor this browser offers, prefixed or not; null where there is none (Firefox). */
export function recognitionIn(win: unknown): RecognitionCtor | null {
  if (typeof win !== "object" || win === null) return null;
  const w = win as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as RecognitionCtor) : null;
}

export type Phase = "idle" | "checking" | "notice" | "listening";

export interface SessionState {
  phase: Phase;
  /** True while recognising on this device; null until a session has asked. */
  onDevice: boolean | null;
  /** NOTICE, while it applies to this browser's sessions. */
  notice: string | null;
  /** What happened last, in words: a stop, the cap, or a failure. */
  message: string | null;
}

export interface SessionDeps {
  Recognition: RecognitionCtor | null;
  /** BCP 47; the profile's language when known, else the browser's. */
  lang: string;
  getText: () => string;
  setText: (next: string) => void;
  /** Words for when a session ends normally, e.g. "Read it over, then record it." */
  after: string;
  store?: Store | null;
  onState?: (state: SessionState) => void;
  /** L-3a: the session's own lines in the person's language; English (NOTICE, errorWords) by default. */
  words?: SessionWords | undefined;
}

/** The lines a session says itself, in one language. */
export interface SessionWords {
  notice: string;
  /** The one-minute cap's stop line. */
  cap: string;
  /** As errorWords: null where nothing went wrong. */
  error: (code: string, lang: string) => string | null;
}

/** English: the words the session always said. */
export const ENGLISH_SESSION_WORDS: SessionWords = {
  get notice() {
    return NOTICE;
  },
  cap: "I stop listening after a minute. Press Speak to add more.",
  error: (code, lang) => errorWords(code, lang),
};

/** Plain words per error code (W3C SpeechRecognitionErrorCode); null where nothing went wrong. */
export function errorWords(code: string, lang: string): string | null {
  switch (code) {
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "The microphone is blocked for this site. Allow it in your browser’s site settings (the icon beside the address), then press Speak again.";
    case "no-speech":
      return "I didn’t hear anything. Press Speak and talk once it says Listening.";
    case "audio-capture":
      return "No microphone was found. Check one is connected and switched on, then press Speak again.";
    case "network":
      return "Your browser couldn’t reach its speech service. Check your connection, or type the answer.";
    case "language-not-supported":
      return `Your browser can’t turn ${lang} speech into text. Type the answer instead.`;
    default:
      return "Listening stopped before any words came through. Press Speak to try again, or type the answer.";
  }
}

function seen(store: Store | null | undefined): boolean {
  try {
    return store?.getItem(NOTICE_KEY) === "1";
  } catch {
    return false; // storage blocked: say it again rather than never
  }
}

function markSeen(store: Store | null | undefined): void {
  try {
    store?.setItem(NOTICE_KEY, "1");
  } catch {
    /* storage blocked: the notice shows again next time */
  }
}

export class SpeechSession {
  private readonly deps: SessionDeps;
  private state: SessionState = { phase: "idle", onDevice: null, notice: null, message: null };
  private rec: RecognitionLike | null = null;
  private base = "";
  private lastWritten = "";
  private cap: ReturnType<typeof setTimeout> | null = null;
  private quiet: ReturnType<typeof setTimeout> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;
  private endWords: string | null = null;
  private stopping = false;
  private disposed = false;
  /** Review 2026-10-30: the box is busy or sending; no session may start. */
  private disabled = false;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  private get words(): SessionWords {
    return this.deps.words ?? ENGLISH_SESSION_WORDS;
  }

  get supported(): boolean {
    return this.deps.Recognition !== null;
  }

  get current(): SessionState {
    return this.state;
  }

  private set(next: Partial<SessionState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...next };
    this.deps.onState?.(this.state);
  }

  /**
   * The box became busy (or free again). Review 2026-10-30: kept here, not
   * only as a stop, because a tap may be awaiting `available()` when the
   * box turns busy; the mic must not start after it.
   */
  setDisabled(on: boolean): void {
    this.disabled = on;
    if (!on) return;
    if (this.rec) this.stop(null);
    else if (this.state.phase !== "idle") this.set({ phase: "idle", message: null });
  }

  /** The microphone was tapped. */
  async toggle(): Promise<void> {
    if (this.disposed || this.disabled || !this.deps.Recognition) return;
    const { phase } = this.state;
    if (phase === "listening") return this.stop(this.deps.after);
    if (phase === "checking") return;
    if (phase === "notice") {
      markSeen(this.deps.store);
      return this.listen(false);
    }
    this.set({ phase: "checking", message: null });
    const onDevice = await this.canRecogniseHere();
    if (this.disposed) return;
    if (this.disabled) {
      this.set({ phase: "idle", message: null });
      return;
    }
    if (!onDevice && !seen(this.deps.store)) {
      this.set({ phase: "notice", onDevice, notice: this.words.notice });
      return;
    }
    this.listen(onDevice);
  }

  /** Only a recognition already on this device counts; nothing is installed. */
  private async canRecogniseHere(): Promise<boolean> {
    const available = this.deps.Recognition?.available;
    if (typeof available !== "function") return false;
    try {
      const status = await available.call(this.deps.Recognition, {
        langs: [this.deps.lang],
        processLocally: true,
      });
      return status === "available";
    } catch {
      return false; // a bad tag or a blocked policy: fall back, with the notice
    }
  }

  private listen(onDevice: boolean): void {
    const Ctor = this.deps.Recognition;
    if (!Ctor) return;
    if (this.disabled) {
      this.set({ phase: "idle", message: null });
      return;
    }
    const rec = new Ctor();
    rec.lang = this.deps.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    if (onDevice) rec.processLocally = true;
    this.base = this.deps.getText();
    this.lastWritten = this.base;
    this.endWords = this.deps.after;
    this.stopping = false;
    rec.onresult = (e) => this.heard(e);
    rec.onspeechstart = () => this.resetQuiet();
    rec.onerror = (e) => {
      const words = this.words.error(e.error, this.deps.lang);
      if (words) this.endWords = words;
    };
    rec.onend = () => this.ended(rec);
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null;
      this.set({
        phase: "idle",
        onDevice,
        message: this.words.error("start-failed", this.deps.lang),
      });
      return;
    }
    this.cap = setTimeout(() => this.stop(this.words.cap), CAP_MS);
    this.resetQuiet();
    this.set({ phase: "listening", onDevice, message: null });
  }

  private resetQuiet(): void {
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.stop(this.deps.after), SILENCE_MS);
  }

  private heard(e: RecognitionEventLike): void {
    if (this.state.phase !== "listening") return;
    // The owner typed while listening: their text stands, and listening ends.
    if (this.deps.getText() !== this.lastWritten) {
      if (!this.stopping) this.stop(this.deps.after);
      return;
    }
    const next = mergeSpoken(this.base, spokenOf(e.results));
    if (next !== this.lastWritten) {
      this.lastWritten = next;
      this.deps.setText(next);
    }
    this.resetQuiet();
  }

  /** Call after each render: an edit by the owner ends listening at once. */
  noticeEdits(): void {
    if (
      this.state.phase === "listening" &&
      !this.stopping &&
      this.deps.getText() !== this.lastWritten
    ) {
      this.stop(this.deps.after);
    }
  }

  /** Ends listening; the browser delivers its last words, then onend fires. */
  stop(words: string | null): void {
    if (!this.rec || this.stopping) return;
    this.stopping = true;
    this.endWords = words;
    this.clearTimers();
    const rec = this.rec;
    try {
      rec.stop();
    } catch {
      this.ended(rec);
      return;
    }
    // Review 2026-10-30: a browser whose onend never fires would leave the
    // button on "Listening" for good; after END_GRACE_MS, abort and go idle.
    if (this.rec === rec) {
      this.grace = setTimeout(() => {
        try {
          rec.abort();
        } catch {
          /* already stopped */
        }
        this.ended(rec);
      }, END_GRACE_MS);
    }
  }

  private ended(rec: RecognitionLike): void {
    if (rec !== this.rec) return;
    this.clearTimers();
    this.rec = null;
    this.stopping = false;
    this.set({ phase: "idle", message: this.endWords });
  }

  private clearTimers(): void {
    if (this.cap) clearTimeout(this.cap);
    if (this.quiet) clearTimeout(this.quiet);
    if (this.grace) clearTimeout(this.grace);
    this.cap = null;
    this.quiet = null;
    this.grace = null;
  }

  /** The box is going away: drop the audio and any words still on their way. */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onresult = null;
      rec.onend = null;
      rec.onerror = null;
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
    }
  }
}

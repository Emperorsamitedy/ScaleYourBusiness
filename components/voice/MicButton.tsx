"use client";

// Idea 50: "Speak", under a free-text box. The owner taps, talks, and the
// words land in the box to read and fix; recording, asking or saving is
// still their own click on the box's own button — this never submits.
// Only on free text: a number, money, date or choice answer keeps its
// typed control, because a misheard word there is a wrong fact.
//
// One toggle with aria-pressed and a fixed name, so its label never
// changes under a screen reader; one aria-live line says what is
// happening ("Listening…", the notice, a stop or a failure). Drawn only
// where the browser can recognise speech.
//
// L-3a: the button's own words, and the session's (the notice, the cap,
// the failures), come from the "voice" catalogue in the person's
// language; the view defaults to English, so it renders without a
// provider (MicButton.test.ts).

import type { SessionWords } from "../../lib/voice/session";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import { useTr } from "../sheet/useTr";
import type { SpeechAnswer, SpeechAnswerOptions } from "./useSpeechAnswer";
import { useSpeechAnswer } from "./useSpeechAnswer";
import { speechLang } from "../../lib/voice/lang";
import "../../app/voice.css";

export interface MicButtonProps extends Omit<SpeechAnswerOptions, "words" | "lang"> {
  /** The accessible name, which starts with the visible word: "Speak your answer". */
  label: string;
}

type ViewProps = Pick<SpeechAnswer, "supported" | "phase" | "notice" | "message"> & {
  label: string;
  disabled?: boolean;
  onToggle: () => void;
  /** The "voice" catalogue; English by default. */
  tr?: Tr;
};

/** The line the screen reader hears; null when there is nothing to say. */
export function liveLine(
  s: Pick<SpeechAnswer, "phase" | "notice" | "message">,
  tr: Tr = englishTr("voice"),
): string | null {
  if (s.phase === "listening") return tr("listening");
  if (s.phase === "notice" && s.notice) return tr("noticeStart", { notice: s.notice });
  if (s.phase === "checking") return null;
  return s.message;
}

/** The session's own lines from the "voice" catalogue. */
export function sessionWords(tr: Tr): SessionWords {
  return {
    notice: tr("notice"),
    cap: tr("cap"),
    error: (code, lang) => {
      switch (code) {
        case "aborted":
          return null;
        case "not-allowed":
        case "service-not-allowed":
          return tr("error.blocked");
        case "no-speech":
          return tr("error.noSpeech");
        case "audio-capture":
          return tr("error.noMicrophone");
        case "network":
          return tr("error.network");
        case "language-not-supported":
          return tr("error.language", { lang });
        default:
          return tr("error.stopped");
      }
    },
  };
}

function MicIcon() {
  return (
    <svg
      className="vx-icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="none" stroke="currentColor" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2.5M5.5 15h5" fill="none" stroke="currentColor" />
    </svg>
  );
}

export function MicButtonView({
  supported,
  phase,
  notice,
  message,
  label,
  disabled,
  onToggle,
  tr = englishTr("voice"),
}: ViewProps) {
  if (!supported) return null;
  const listening = phase === "listening";
  const line = liveLine({ phase, notice, message }, tr);
  return (
    <div className="vx">
      <div className="vx-row">
        <button
          type="button"
          className={listening ? "act solid vx-mic" : "act vx-mic"}
          aria-pressed={listening}
          aria-label={label}
          // Not disabled while checking: a disabled button drops keyboard focus.
          disabled={disabled === true}
          onClick={onToggle}
        >
          <MicIcon />
          {tr("speak")}
        </button>
        <p className="vx-live" aria-live="polite">
          {listening && <span className="live-dot" aria-hidden="true" />}
          {line}
        </p>
      </div>
      {notice && phase !== "notice" && <p className="vx-notice">{notice}</p>}
    </div>
  );
}

export function MicButton({ label, ...options }: MicButtonProps) {
  const { tr, locale } = useTr("voice");
  // The session reads its words through a getter, so each render's set is the one used.
  // I-50a: it listens in the person's chosen language, the request's locale.
  const s = useSpeechAnswer({ ...options, lang: speechLang(locale), words: sessionWords(tr) });
  return (
    <MicButtonView
      supported={s.supported}
      phase={s.phase}
      notice={s.notice}
      message={s.message}
      label={label}
      disabled={options.disabled === true}
      onToggle={s.toggle}
      tr={tr}
    />
  );
}

"use client";

// Idea 50: the microphone beside a free-text box. The owner presses, talks,
// and the words land in the box to read and fix; recording, asking or
// saving is still their own click on the box's own button — this never
// submits. Only on free text: a number, money, date or choice answer keeps
// its typed control, because a misheard word there is a wrong fact.
//
// One press listens (2026-11-17, the owner: the sentence about who hears
// the audio leaves the screen; the privacy page says it). Two drawings of
// the same toggle: `icon`, inside a composer, is an icon button with a
// spoken name; `button`, under the interview's and the support reply's
// boxes, is the sheet's compact button with its word. Either way one
// aria-live line says what is happening ("Listening…", a stop, a failure),
// so the icon is never the only sign. Drawn only where the browser can
// recognise speech.
//
// L-3a: the button's own words, and the session's (the cap, the
// failures), come from the "voice" catalogue in the person's language; the
// view defaults to English, so it renders without a provider
// (MicButton.test.ts).

import { Mic } from "lucide-react";
import type { SessionWords } from "../../lib/voice/session";
import type { Tr } from "../../lib/i18n/tr";
import { englishTr } from "../../lib/i18n/tr";
import { useTr } from "../sheet/useTr";
import { IconButton } from "../ui/IconButton";
import type { SpeechAnswer, SpeechAnswerOptions } from "./useSpeechAnswer";
import { useSpeechAnswer } from "./useSpeechAnswer";
import { speechLang } from "../../lib/voice/lang";
import "../../app/voice.css";

export type MicVariant = "icon" | "button";

export interface MicButtonProps extends Omit<SpeechAnswerOptions, "words" | "lang"> {
  /** The accessible name, which starts with the visible word: "Speak your answer". */
  label: string;
  /** `icon` inside a composer; `button` (the default) under a box. */
  variant?: MicVariant | undefined;
}

type ViewProps = Pick<SpeechAnswer, "supported" | "phase" | "message"> & {
  label: string;
  variant?: MicVariant | undefined;
  disabled?: boolean;
  onToggle: () => void;
  /** The "voice" catalogue; English by default. */
  tr?: Tr;
};

/** The line the screen reader hears; null when there is nothing to say. */
export function liveLine(
  s: Pick<SpeechAnswer, "phase" | "message">,
  tr: Tr = englishTr("voice"),
): string | null {
  if (s.phase === "listening") return tr("listening");
  if (s.phase === "checking") return null;
  return s.message;
}

/** The session's own lines from the "voice" catalogue. */
export function sessionWords(tr: Tr): SessionWords {
  return {
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

export function MicButtonView({
  supported,
  phase,
  message,
  label,
  variant = "button",
  disabled,
  onToggle,
  tr = englishTr("voice"),
}: ViewProps) {
  if (!supported) return null;
  const listening = phase === "listening";
  const line = liveLine({ phase, message }, tr);
  const live = (
    <p className="vx-live" aria-live="polite">
      {listening && <span className="live-dot" aria-hidden="true" />}
      {line}
    </p>
  );
  if (variant === "icon") {
    // No wrapper: the button sits in the composer's row and the line wraps under it.
    return (
      <>
        <IconButton
          label={label}
          className={listening ? "vx-icon-mic on" : "vx-icon-mic"}
          aria-pressed={listening}
          // Not disabled while checking: a disabled button drops keyboard focus.
          disabled={disabled === true}
          onClick={onToggle}
        >
          <Mic size={18} strokeWidth={1.75} aria-hidden="true" />
        </IconButton>
        {live}
      </>
    );
  }
  return (
    <div className="vx">
      <div className="vx-row">
        <button
          type="button"
          className={listening ? "act solid vx-mic" : "act vx-mic"}
          aria-pressed={listening}
          aria-label={label}
          disabled={disabled === true}
          onClick={onToggle}
        >
          <Mic className="vx-icon" size={14} strokeWidth={1.75} aria-hidden="true" />
          {tr("speak")}
        </button>
        {live}
      </div>
    </div>
  );
}

export function MicButton({ label, variant, ...options }: MicButtonProps) {
  const { tr, locale } = useTr("voice");
  // The session reads its words through a getter, so each render's set is the one used.
  // I-50a: it listens in the person's chosen language, the request's locale.
  const s = useSpeechAnswer({ ...options, lang: speechLang(locale), words: sessionWords(tr) });
  return (
    <MicButtonView
      supported={s.supported}
      phase={s.phase}
      message={s.message}
      label={label}
      variant={variant}
      disabled={options.disabled === true}
      onToggle={s.toggle}
      tr={tr}
    />
  );
}

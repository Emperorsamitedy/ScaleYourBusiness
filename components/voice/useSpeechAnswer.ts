"use client";

// Idea 50: the microphone's React side. Feature-detects after mount, so the
// server render and a browser without speech recognition (Firefox) both
// draw nothing and log nothing. The work is in lib/voice/session.ts.

import { useEffect, useRef, useState } from "react";
import type { SessionState, SessionWords } from "../../lib/voice/session";
import { SpeechSession, recognitionIn } from "../../lib/voice/session";

export interface SpeechAnswerOptions {
  getText: () => string;
  setText: (next: string) => void;
  /** Words for a normal stop, in the box's own verb ("…then record it"). */
  after: string;
  /** The profile's language when known; else the browser's. */
  lang?: string | null;
  /** L-3a: the session's own lines in the person's language (MicButton passes them). */
  words?: SessionWords;
  /** True stops any listening at once (the box is busy or sending). */
  disabled?: boolean;
}

export interface SpeechAnswer extends SessionState {
  supported: boolean;
  toggle: () => void;
}

const IDLE: SessionState = { phase: "idle", onDevice: null, notice: null, message: null };

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked (private window, policy): the notice just shows again
  }
}

export function useSpeechAnswer(options: SpeechAnswerOptions): SpeechAnswer {
  const opts = useRef(options);
  useEffect(() => {
    opts.current = options;
  });
  const session = useRef<SpeechSession | null>(null);
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<SessionState>(IDLE);

  useEffect(() => {
    const s = new SpeechSession({
      Recognition: recognitionIn(window),
      get lang() {
        return opts.current.lang || navigator.language || "en-GB";
      },
      getText: () => opts.current.getText(),
      setText: (next) => opts.current.setText(next),
      get after() {
        return opts.current.after;
      },
      get words() {
        return opts.current.words;
      },
      store: storage(),
      onState: setState,
    });
    session.current = s;
    setSupported(s.supported);
    return () => {
      s.dispose();
      session.current = null;
    };
  }, []);

  // Typing in the box while listening ends listening: the owner's words win.
  useEffect(() => {
    session.current?.noticeEdits();
  });

  const { disabled } = options;
  // Review 2026-10-30: a flag on the session, so a tap still awaiting the
  // browser's answer can't start the mic once the box is busy.
  useEffect(() => {
    session.current?.setDisabled(disabled === true);
  }, [disabled]);

  return {
    ...state,
    supported,
    toggle: () => void session.current?.toggle(),
  };
}

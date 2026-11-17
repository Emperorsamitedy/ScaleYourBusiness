"use client";

// The composer, the one place the owner starts something (conversation
// channel §7). Shared by the conversation page, Home and Lex's sheet: the
// box, the microphone as an icon (idea 50) and Ask. Enter sends and
// Shift+Enter breaks a line; nothing is sent while a reply is being
// written. Small text (the owner, 2026-11-17): no paragraph sits under the
// box any more. What Lex answers from is one line on the conversation
// page, and the microphone's only words are "Listening…" and a failure.

import type { RefObject } from "react";
import type { Tr } from "../../lib/i18n/tr";
import { MicButton } from "../voice/MicButton";
import { MAX_CHARS } from "./useChat";

export function Composer({
  id = "ak-input",
  label,
  draft,
  busy,
  setDraft,
  draftRef,
  onSend,
  tr,
  inputRef,
  compact = false,
  autoFocus = false,
}: {
  id?: string;
  /** The box's name: a mono line above it, or only spoken when `compact`. */
  label: string;
  draft: string;
  busy: boolean;
  setDraft: (next: string) => void;
  draftRef: { current: string };
  onSend: () => void;
  /** The "chat" catalogue. */
  tr: Tr;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** The label is spoken, not shown: in a sheet's foot, or under a heading that already says it. */
  compact?: boolean;
  /** The overlay this composer sits in puts the cursor here when it opens. */
  autoFocus?: boolean;
}) {
  return (
    <form
      className={compact ? "ak-composer compact" : "ak-composer"}
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <label className={compact ? "sr-only" : "ak-label"} htmlFor={id}>
        {label}
      </label>
      <div className="ak-row">
        <textarea
          id={id}
          ref={inputRef}
          className="ak-input"
          rows={2}
          maxLength={MAX_CHARS}
          placeholder={tr("composer.placeholder")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          disabled={busy}
          data-autofocus={autoFocus ? "" : undefined}
        />
        <MicButton
          variant="icon"
          label={tr("composer.speak")}
          getText={() => draftRef.current}
          setText={(next) => setDraft(next.slice(0, MAX_CHARS))}
          disabled={busy}
        />
        <button type="submit" className="next ak-ask" disabled={busy || draft.trim() === ""}>
          {tr("composer.ask")}
        </button>
      </div>
    </form>
  );
}

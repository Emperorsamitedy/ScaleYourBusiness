"use client";

// The composer, the one place the owner starts something (conversation
// channel §7). Shared by the chat screen and Home: a label, the box, Ask,
// the microphone (idea 50), and the rule the composer keeps under a closed
// fold. Enter sends and Shift+Enter breaks a line; nothing is sent while a
// reply is being written.

import type { ReactNode, RefObject } from "react";
import type { Tr } from "../../lib/i18n/tr";
import { Fold } from "../sheet/Fold";
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
  intro,
}: {
  id?: string;
  /** The mono line above the box. */
  label: string;
  draft: string;
  busy: boolean;
  setDraft: (next: string) => void;
  draftRef: { current: string };
  onSend: () => void;
  /** The "chat" catalogue. */
  tr: Tr;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** Inside the fold, above the rule: what to ask, shown while the thread is empty. */
  intro?: ReactNode;
}) {
  return (
    <form
      className="ak-composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <label className="ak-label" htmlFor={id}>
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
          aria-describedby={`${id}-rule`}
        />
        <button type="submit" className="next ak-ask" disabled={busy || draft.trim() === ""}>
          {tr("composer.ask")}
        </button>
      </div>
      <MicButton
        label={tr("composer.speak")}
        getText={() => draftRef.current}
        setText={(next) => setDraft(next.slice(0, MAX_CHARS))}
        after={tr("composer.spokenAfter")}
        disabled={busy}
      />
      <Fold className="ak-rule">
        {intro}
        <p id={`${id}-rule`}>{tr("composer.rule")}</p>
      </Fold>
    </form>
  );
}

"use client";

// File — honest interim (P0-64). No fake upload: a labelled placeholder;
// the only actions are the ghosts in the action row.

import type { IntakeQuestion } from "@/lib/intake/types";
import { useIntakeWords } from "../words";

export function FileStubControl({ question }: { question: IntakeQuestion }) {
  const { tr } = useIntakeWords();
  return (
    <div className="ix-filestub">
      {tr("question.fileStub")}
      <span className="ix-note">
        {question.allow_unknown ? tr("question.fileUnknown") : tr("question.fileSkip")}
      </span>
    </div>
  );
}

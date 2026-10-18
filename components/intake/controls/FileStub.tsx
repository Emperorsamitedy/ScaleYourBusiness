"use client";

// File — honest interim (P0-64). No fake upload: a labelled placeholder;
// the only actions are the ghosts in the action row.

import type { IntakeQuestion } from "@/lib/intake/types";

export function FileStubControl({ question }: { question: IntakeQuestion }) {
  return (
    <div className="ix-filestub">
      Uploads arrive in a later session
      <span className="ix-note">
        {question.allow_unknown
          ? "choose “No reading — I don’t know” to move on"
          : "skip for now to move on"}
      </span>
    </div>
  );
}

"use client";

// File — honest interim (P0-64). No fake upload: a labelled placeholder;
// the only actions are the ghosts in the action row.

import type { IntakeQuestion } from "@/lib/intake/types";

export function FileStubControl({ question }: { question: IntakeQuestion }) {
  return (
    <div className="filestub">
      Uploads arrive in a later session
      <span className="sub">
        {question.allow_unknown ? "mark unknown to move on" : "skip for now to move on"}
      </span>
    </div>
  );
}

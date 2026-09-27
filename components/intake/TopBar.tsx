"use client";

// Top bar — wordmark and the honest fraction `6 / 25 core`; the
// screen itself says what is happening, so no subtitle
// (P0-66 — never a percentage). 2px rail below, --ink fill.

import type { IntakeProgress } from "@/lib/intake/types";

export function TopBar({ progress }: { progress: IntakeProgress | null }) {
  return (
    <>
      <header className="topbar">
        <span className="wordmark">Ledgerline</span>
        <span className="meta">
          {progress && (
            <>
              <span key={progress.core_done} className="counter-swap">
                {progress.core_done}
              </span>
              {` / ${progress.core_total} core`}
            </>
          )}
        </span>
      </header>
      <div
        className="progress-rail"
        role="progressbar"
        aria-label="Core questions answered"
        aria-valuemin={0}
        aria-valuemax={progress?.core_total ?? 0}
        aria-valuenow={progress?.core_done ?? 0}
      >
        <div className="progress-fill" style={{ width: `${(progress?.fraction ?? 0) * 100}%` }} />
      </div>
    </>
  );
}

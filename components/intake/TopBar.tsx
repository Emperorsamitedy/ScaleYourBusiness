"use client";

// Top bar — wordmark, subtitle, and how much of the record is filled, in
// words with mono figures (owner brief 2026-10-17): never an "N / M"
// counter and never a percentage. A flat 1px-ruled bar runs along the
// bar's foot; its accessible value is the same sentence.

import type { IntakeProgress } from "@/lib/intake/types";
import { recordSummary } from "./record";

export function TopBar({ progress }: { progress: IntakeProgress | null }) {
  const summary = progress ? recordSummary(progress) : null;
  return (
    <header className="topbar intake-top">
      <span className="wordmark">Ledgerline</span>
      <span className="subtitle">Setting up your business profile</span>
      <span className="meta fig">{summary}</span>
      <div
        className="progress-rail"
        role="progressbar"
        aria-label="Core record"
        aria-valuemin={0}
        aria-valuemax={progress?.core_total ?? 0}
        aria-valuenow={progress?.core_done ?? 0}
        aria-valuetext={summary ?? "Loading the record"}
      >
        <div className="progress-fill" style={{ width: `${(progress?.fraction ?? 0) * 100}%` }} />
      </div>
    </header>
  );
}

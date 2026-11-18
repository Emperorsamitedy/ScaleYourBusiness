"use client";

// Whether everything is stopped (rule 15), for whatever needs to say so
// without carrying the stop itself: Lex's face goes grey. It reads what
// /api/stop says and hears a press anywhere on the page (STOP_CHANGED), so
// it never disagrees with the control. Null before the answer, and where
// the reader is not signed in to a business.

import { useEffect, useState } from "react";
import { STOP_CHANGED } from "./EmergencyStop";

export function useStopped(enabled = true): boolean | null {
  const [halted, setHalted] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const read = () => {
      void fetch("/api/stop")
        .then(async (res) => (res.ok ? ((await res.json()) as { halted?: boolean }) : null))
        .then((j) => {
          if (alive) setHalted(j ? j.halted === true : null);
        })
        .catch(() => undefined);
    };
    read();
    window.addEventListener(STOP_CHANGED, read);
    return () => {
      alive = false;
      window.removeEventListener(STOP_CHANGED, read);
    };
  }, [enabled]);
  return halted;
}

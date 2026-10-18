"use client";

// The tape (owner design intake-v2): a paper strip along the bottom with
// perforated edges, printing the record's newest facts as one mono line —
// "HH:MM fact = value · source ▪ …", newest first, from each fact's real
// recorded_at (today as a clock time on the browser's clock, an earlier
// day as its date). It scrolls sideways inside itself; nothing moves on
// its own, so it is safe under prefers-reduced-motion.

import { useEffect, useState } from "react";
import type { RecordFact } from "@/lib/intake/types";
import { tapeEntries } from "./record";

export function Tape({ facts }: { facts: readonly RecordFact[] }) {
  // The clock is read in the browser only, so server and client render alike.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
  }, [facts]);
  if (facts.length === 0 || now === null) return null;
  const entries = tapeEntries(facts, now);
  return (
    <section className="ix-tape" aria-label="The tape: facts on file, newest first">
      <span className="ix-tape-head" aria-hidden="true">
        Tape &#9656;
      </span>
      <ol className="ix-tape-line" tabIndex={0}>
        {entries.map((e) => (
          <li key={e.id}>
            <span className="fig">{e.stamp}</span> {e.label} ={" "}
            <span className="fig">{e.value}</span> · {e.source}
          </li>
        ))}
      </ol>
    </section>
  );
}

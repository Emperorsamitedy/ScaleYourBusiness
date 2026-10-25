// The app's own cost lines, captured as it logs them — for the operator
// scripts (verify:models, recalibrate:diagnosis) that need "the cost the
// app logged" per call, including calls whose function then threw (a
// refusal is metered before it is raised). lib/llm/cost-log.ts writes one
// JSON line per call through console.log; this listens for those lines,
// keeps them, and passes every other line through untouched.

import type { LlmCallRecord } from "./cost-log";

export interface CallCapture {
  /** Every llm_call line logged since start, in order. */
  readonly logged: LlmCallRecord[];
  /** The print that bypasses the capture. */
  print(...parts: unknown[]): void;
  /** Put console.log back. Idempotent. */
  restore(): void;
}

export function captureLoggedCalls(): CallCapture {
  const original = console.log;
  const passThrough = console.log.bind(console);
  const logged: LlmCallRecord[] = [];
  console.log = (...parts: unknown[]) => {
    const [first] = parts;
    if (parts.length === 1 && typeof first === "string" && first.startsWith('{"at"')) {
      try {
        const r = JSON.parse(first) as Partial<LlmCallRecord>;
        if (r.event === "llm_call") {
          logged.push(r as LlmCallRecord);
          return;
        }
      } catch {
        /* not a cost line — print it */
      }
    }
    passThrough(...parts);
  };
  let restored = false;
  return {
    logged,
    print: passThrough,
    restore() {
      if (restored) return;
      restored = true;
      console.log = original;
    },
  };
}

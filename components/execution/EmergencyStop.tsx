"use client";

// The emergency stop — P3-12, rule 15: "one owner-visible control
// halts everything in flight within seconds."
//
// ONE control, rendered on every surface that can cause a write, so
// an owner never has to go looking for it. Its asymmetry is the point,
// and it mirrors P1-44's watch override: stopping is one click with no
// confirmation and no sign-in, because the person at the keyboard in
// an emergency gets to stop the machine. Starting again asks for a
// confirmation and a signed-in name, because that is the direction
// that can cost something.
//
// When halted it is loud and unmissable — the one place --err appears
// at full strength — and it says plainly what is and isn't stopped:
// nothing executes, but reading, planning and proposing continue.

import { useCallback, useEffect, useState } from "react";

interface Halt {
  halted: boolean;
  halted_at: string | null;
  reason: string | null;
}

type State =
  | { phase: "hidden" }
  | { phase: "ready"; halt: Halt; busy: boolean; confirming: boolean; error: string | null };

function whenWord(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function EmergencyStop() {
  const [state, setState] = useState<State>({ phase: "hidden" });

  const load = useCallback(async () => {
    const res = await fetch("/api/stop");
    if (!res.ok) return setState({ phase: "hidden" });
    const halt = (await res.json()) as Halt;
    setState({ phase: "ready", halt, busy: false, confirming: false, error: null });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.phase === "hidden") return null;
  const s = state;

  const send = async (method: "POST" | "DELETE") => {
    setState({ ...s, busy: true, error: null });
    const res = await fetch("/api/stop", { method });
    const j = (await res.json()) as Halt & { error?: string };
    if (!res.ok) {
      setState({ ...s, busy: false, error: j.error ?? "that didn't work" });
      return;
    }
    setState({ phase: "ready", halt: j, busy: false, confirming: false, error: null });
  };

  if (!s.halt.halted) {
    return (
      <div className="es-bar">
        <button
          className="es-stop"
          disabled={s.busy}
          onClick={() => void send("POST")}
          title="Halts every execution immediately. Reading and proposing continue."
        >
          {s.busy ? "Stopping…" : "Stop everything"}
        </button>
        {s.error && <span className="conn-note">{s.error}</span>}
      </div>
    );
  }

  return (
    <section className="card ops-card es-halted" role="alert">
      <span className="auth-eyebrow es-eyebrow">everything is stopped</span>
      <h2 className="prop-title small" style={{ marginTop: 8 }}>
        Nothing will execute{s.halt.halted_at ? ` — stopped ${whenWord(s.halt.halted_at)}` : ""}.
      </h2>
      <p className="auth-copy">
        Approved actions stay approved and wait. Nothing runs, nothing publishes, nothing changes on
        your site — including anything that was mid-flight when you stopped it. Reading, planning
        and proposing all carry on as normal.
      </p>
      {s.halt.reason && <p className="conn-note">You said: “{s.halt.reason}”</p>}
      {s.error && <p className="conn-note">{s.error}</p>}
      {s.confirming ? (
        <div className="prop-actions">
          <button className="prop-btn" disabled={s.busy} onClick={() => void send("DELETE")}>
            {s.busy ? "Starting…" : "Yes — start executing again"}
          </button>
          <button className="prop-btn quiet" onClick={() => setState({ ...s, confirming: false })}>
            Stay stopped
          </button>
        </div>
      ) : (
        <div className="prop-actions">
          <button className="prop-btn" onClick={() => setState({ ...s, confirming: true })}>
            Start things up again
          </button>
        </div>
      )}
    </section>
  );
}

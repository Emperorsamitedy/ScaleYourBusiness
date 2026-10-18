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
// Sheet system (ux-spec §2): an ink-bordered control with a verb and an
// arrow, never a colour. What it does is printed beside it, not hidden
// in a tooltip. When halted it is a paper sheet with a worded, underlined
// STOPPED flag and a heavier rule, and it says plainly what is and isn't
// stopped: nothing executes, but reading, planning and proposing continue.
//
// The approval queue's design (2026-10-17) carries the control in its ink
// masthead: variant "masthead" is the same behaviour as an alarm-bordered
// mono button, and — when halted — a STOPPED word with the same
// confirm-to-restart step, inline. `onState` tells the host screen
// whether everything is halted, so it can say so beside its own buttons.

import { useCallback, useEffect, useState } from "react";
import "../../app/queue.css";

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
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "14:02" today, "Fri 16 Oct 14:02" otherwise — short enough for the masthead. */
function shortWhen(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

export function EmergencyStop({
  variant = "bar",
  onState,
}: {
  variant?: "bar" | "masthead";
  onState?: (halted: boolean) => void;
} = {}) {
  const [state, setState] = useState<State>({ phase: "hidden" });
  const halted = state.phase === "ready" ? state.halt.halted : null;
  useEffect(() => {
    if (halted !== null) onState?.(halted);
  }, [halted, onState]);

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

  if (variant === "masthead") {
    if (!s.halt.halted) {
      return (
        <div className="es-mast">
          <button
            type="button"
            className="es-mast-stop"
            disabled={s.busy}
            aria-describedby="es-mast-what"
            onClick={() => void send("POST")}
          >
            {s.busy ? "Stopping…" : "Stop everything"}
          </button>
          <span className="sr-only" id="es-mast-what">
            Halts every execution at once, no sign-in needed. Reading and proposing carry on.
          </span>
          {s.error && (
            <p className="es-mast-note" role="alert">
              {s.error}
            </p>
          )}
        </div>
      );
    }
    return (
      <div className="es-mast es-mast-halted" role="status">
        <span className="es-mast-word">
          Stopped{s.halt.halted_at ? ` ${shortWhen(s.halt.halted_at)}` : ""} · nothing executes
        </span>
        {s.confirming ? (
          <>
            <button
              type="button"
              className="es-mast-stop es-mast-go"
              disabled={s.busy}
              onClick={() => void send("DELETE")}
            >
              {s.busy ? "Starting…" : "Yes — start again"}
            </button>
            <button
              type="button"
              className="es-mast-quiet"
              onClick={() => setState({ ...s, confirming: false })}
            >
              Stay stopped
            </button>
            <span className="es-mast-note">
              Starting again lets approved actions run. It needs you signed in.
            </span>
          </>
        ) : (
          <button
            type="button"
            className="es-mast-quiet"
            onClick={() => setState({ ...s, confirming: true })}
          >
            Start things up again
          </button>
        )}
        {s.error && (
          <p className="es-mast-note" role="alert">
            {s.error}
          </p>
        )}
      </div>
    );
  }

  if (!s.halt.halted) {
    return (
      <div className="es-bar es-run">
        <button
          type="button"
          className="es-stop es-verb"
          disabled={s.busy}
          aria-describedby="es-what"
          onClick={() => void send("POST")}
        >
          {s.busy ? (
            "Stopping…"
          ) : (
            <>
              Stop everything <span aria-hidden="true">→</span>
            </>
          )}
        </button>
        <p className="es-what" id="es-what">
          Halts every execution at once, no sign-in needed. Reading and proposing carry on.
        </p>
        {s.error && (
          <p className="es-what" role="alert">
            {s.error}
          </p>
        )}
      </div>
    );
  }

  return (
    <section className="card ops-card es-halted es-sheet" role="alert">
      <p className="flag es-flag">stopped · nothing will execute</p>
      <h2 className="prop-title small es-title">
        Everything is stopped
        {s.halt.halted_at ? ` — since ${whenWord(s.halt.halted_at)}` : ""}.
      </h2>
      <p className="auth-copy es-copy">
        Approved actions stay approved and wait. Nothing runs, nothing publishes, nothing changes on
        your site — including anything that was mid-flight when you stopped it. Reading, planning
        and proposing all carry on as normal.
      </p>
      {s.halt.reason && <p className="conn-note">You said: “{s.halt.reason}”</p>}
      {s.error && <p className="conn-note">{s.error}</p>}
      {s.confirming ? (
        <div className="es-actions">
          <p className="conn-note es-confirm">
            Starting again lets approved actions run. It needs you signed in.
          </p>
          <button
            type="button"
            className="prop-btn es-verb"
            disabled={s.busy}
            onClick={() => void send("DELETE")}
          >
            {s.busy ? (
              "Starting…"
            ) : (
              <>
                Yes — start executing again <span aria-hidden="true">→</span>
              </>
            )}
          </button>
          <button
            type="button"
            className="prop-btn quiet es-quiet"
            onClick={() => setState({ ...s, confirming: false })}
          >
            Stay stopped
          </button>
        </div>
      ) : (
        <div className="es-actions">
          <button
            type="button"
            className="prop-btn es-verb"
            onClick={() => setState({ ...s, confirming: true })}
          >
            Start things up again <span aria-hidden="true">→</span>
          </button>
        </div>
      )}
    </section>
  );
}

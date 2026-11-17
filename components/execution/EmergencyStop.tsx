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
//
// Home's status card (2026-11-17, docs/DASHBOARD-OVERHAUL.md C2) carries it
// too: variant "card" is the same control on paper, one full-width button
// with what it does spoken rather than printed. A page can now hold two
// (the strip's and the card's), so a press on one is told to the others
// (a window event) and each reads the state again: they never disagree.

import { useCallback, useEffect, useId, useState } from "react";
import "../../app/queue.css";
import { useTranslations } from "next-intl";
import { useRole } from "../auth/RoleContext";
import { useAppLocale } from "../sheet/useTr";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";

/** English keeps en-GB, as the stop always has; another language writes its own. */
const tagOf = (locale: AppLocale): string => (locale === "en" ? "en-GB" : intlTag(locale));

interface Halt {
  halted: boolean;
  halted_at: string | null;
  reason: string | null;
}

/** Told to every stop on the page when one of them was pressed; `detail` is the presser's id. */
const CHANGED = "syb:stop-changed";

type State =
  | { phase: "hidden" }
  | { phase: "ready"; halt: Halt; busy: boolean; confirming: boolean; error: string | null };

function whenWord(iso: string | null, locale: AppLocale): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString(tagOf(locale), {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "14:02" today, "Fri 16 Oct 14:02" otherwise — short enough for the masthead. */
function shortWhen(iso: string, locale: AppLocale): string {
  const d = new Date(iso);
  const tag = tagOf(locale);
  const time = d.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString(tag, { weekday: "short", day: "numeric", month: "short" })} ${time}`;
}

export function EmergencyStop({
  variant = "bar",
  onState,
}: {
  variant?: "bar" | "masthead" | "card";
  onState?: (halted: boolean) => void;
} = {}) {
  const self = useId();
  const t = useTranslations("stop");
  const locale = useAppLocale();
  const [state, setState] = useState<State>({ phase: "hidden" });
  // Idea 52: anyone on the team can stop; starting again is an owner's.
  const resumeWhy = useRole().why("stop.resume");
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

  // Another stop on this page was pressed: read the state it left.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== self) void load();
    };
    window.addEventListener(CHANGED, on);
    return () => window.removeEventListener(CHANGED, on);
  }, [load, self]);

  if (state.phase === "hidden") return null;
  const s = state;

  const send = async (method: "POST" | "DELETE") => {
    setState({ ...s, busy: true, error: null });
    const res = await fetch("/api/stop", { method });
    const j = (await res.json()) as Halt & { error?: string };
    if (!res.ok) {
      setState({ ...s, busy: false, error: j.error ?? t("failed") });
      return;
    }
    setState({ phase: "ready", halt: j, busy: false, confirming: false, error: null });
    window.dispatchEvent(new CustomEvent(CHANGED, { detail: self }));
  };

  if (variant === "card") {
    if (!s.halt.halted) {
      return (
        <div className="es-card" data-focus="emergency-stop">
          <button
            type="button"
            className="es-card-stop"
            disabled={s.busy}
            aria-describedby={`${self}-what`}
            onClick={() => void send("POST")}
          >
            {s.busy ? t("stopping") : t("stop")}
          </button>
          <span className="sr-only" id={`${self}-what`}>
            {t("what")}
          </span>
          {s.error && (
            <p className="es-card-note" role="alert">
              {s.error}
            </p>
          )}
        </div>
      );
    }
    return (
      <div className="es-card es-card-halted" role="status" data-focus="emergency-stop">
        {s.confirming ? (
          <>
            <p className="es-card-note">{t("startNote")}</p>
            <div className="es-card-pair">
              <button
                type="button"
                className="es-card-go"
                disabled={s.busy}
                onClick={() => void send("DELETE")}
              >
                {s.busy ? t("starting") : t("yesStart")}
              </button>
              <button
                type="button"
                className="es-card-go"
                onClick={() => setState({ ...s, confirming: false })}
              >
                {t("stay")}
              </button>
            </div>
          </>
        ) : resumeWhy ? (
          <p className="es-card-note">{resumeWhy}</p>
        ) : (
          <button
            type="button"
            className="es-card-go"
            onClick={() => setState({ ...s, confirming: true })}
          >
            {t("startUp")}
          </button>
        )}
        {s.error && (
          <p className="es-card-note" role="alert">
            {s.error}
          </p>
        )}
      </div>
    );
  }

  if (variant === "masthead") {
    if (!s.halt.halted) {
      return (
        <div className="es-mast" data-focus="emergency-stop">
          <button
            type="button"
            className="es-mast-stop"
            disabled={s.busy}
            aria-describedby="es-mast-what"
            onClick={() => void send("POST")}
          >
            {s.busy ? t("stopping") : t("stop")}
          </button>
          <span className="sr-only" id="es-mast-what">
            {t("what")}
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
      <div className="es-mast es-mast-halted" role="status" data-focus="emergency-stop">
        <span className="es-mast-word">
          {s.halt.halted_at
            ? t("stoppedAt", { when: shortWhen(s.halt.halted_at, locale) })
            : t("stoppedShort")}
        </span>
        {s.confirming ? (
          <>
            <button
              type="button"
              className="es-mast-stop es-mast-go"
              disabled={s.busy}
              onClick={() => void send("DELETE")}
            >
              {s.busy ? t("starting") : t("yesStart")}
            </button>
            <button
              type="button"
              className="es-mast-quiet"
              onClick={() => setState({ ...s, confirming: false })}
            >
              {t("stay")}
            </button>
            <span className="es-mast-note">{t("startNote")}</span>
          </>
        ) : resumeWhy ? (
          <span className="es-mast-note">{resumeWhy}</span>
        ) : (
          <button
            type="button"
            className="es-mast-quiet"
            onClick={() => setState({ ...s, confirming: true })}
          >
            {t("startUp")}
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
      <div className="es-bar es-run" data-focus="emergency-stop">
        <button
          type="button"
          className="es-stop es-verb"
          disabled={s.busy}
          aria-describedby="es-what"
          onClick={() => void send("POST")}
        >
          {s.busy ? (
            t("stopping")
          ) : (
            <>
              {t("stop")} <span aria-hidden="true">→</span>
            </>
          )}
        </button>
        <p className="es-what" id="es-what">
          {t("what")}
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
    <section className="card ops-card es-halted es-sheet" role="alert" data-focus="emergency-stop">
      <p className="flag es-flag">{t("flag")}</p>
      <h2 className="prop-title small es-title">
        {s.halt.halted_at
          ? t("titleSince", { when: whenWord(s.halt.halted_at, locale) })
          : t("title")}
      </h2>
      <p className="auth-copy es-copy">{t("copy")}</p>
      {s.halt.reason && <p className="conn-note">{t("youSaid", { reason: s.halt.reason })}</p>}
      {s.error && <p className="conn-note">{s.error}</p>}
      {s.confirming ? (
        <div className="es-actions">
          <p className="conn-note es-confirm">{t("startNote")}</p>
          <button
            type="button"
            className="prop-btn es-verb"
            disabled={s.busy}
            onClick={() => void send("DELETE")}
          >
            {s.busy ? (
              t("starting")
            ) : (
              <>
                {t("yesExecute")} <span aria-hidden="true">→</span>
              </>
            )}
          </button>
          <button
            type="button"
            className="prop-btn quiet es-quiet"
            onClick={() => setState({ ...s, confirming: false })}
          >
            {t("stay")}
          </button>
        </div>
      ) : resumeWhy ? (
        <p className="conn-note">{resumeWhy}</p>
      ) : (
        <div className="es-actions">
          <button
            type="button"
            className="prop-btn es-verb"
            onClick={() => setState({ ...s, confirming: true })}
          >
            {t("startUp")} <span aria-hidden="true">→</span>
          </button>
        </div>
      )}
    </section>
  );
}

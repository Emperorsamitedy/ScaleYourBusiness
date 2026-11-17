"use client";

// Lex's status card (docs/DASHBOARD-OVERHAUL.md C2): the side column's
// first sheet. One line that is always true (everything stopped; watching,
// day N of M; or working with approvals), the emergency stop inside it,
// and "Read now", which reads every connected account again through the
// connections screen's own "Sync now" (POST /api/connections/sync) and
// says what it read. Cobalt shows only while a read is genuinely out.
//
// Reading again needs a signed-in person whose role may (a manager or an
// owner): when the list can't be read or the role may not, "Read now" is
// not drawn. Nothing here calls a model, and nothing executes: reading is
// the read-only half of the product.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { NavCounts } from "../../app/api/nav/route";
import { parseTs } from "../chat/chat-view";
import { useRole } from "../auth/RoleContext";
import { EmergencyStop } from "../execution/EmergencyStop";
import { useAppLocale } from "../sheet/useTr";
import { agoText } from "./format";
import type { ReadNowTally } from "./read-now";
import { readNowOutcome, tallied } from "./read-now";

interface Connection {
  id: string;
  label: string;
  status: string;
  last_sync_at: string | null;
}

type Run =
  | { phase: "idle" }
  | { phase: "reading"; name: string }
  | { phase: "done"; read: number; silent: string[] };

/** The least time between two presses of "Read now". */
const COOL_MS = 60_000;

export function StatusCard({
  nav,
  onHalted,
  onRead,
}: {
  /** The menu's counts; null while they are out. */
  nav: NavCounts | null;
  /** Tells Home whether everything is stopped. */
  onHalted: (halted: boolean) => void;
  /** After a read: Home reads its feed again. */
  onRead: () => void;
}) {
  const t = useTranslations("home");
  const locale = useAppLocale();
  const role = useRole();
  const [halted, setHalted] = useState<boolean | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [run, setRun] = useState<Run>({ phase: "idle" });
  const [cooling, setCooling] = useState(false);
  const cool = useRef<number | null>(null);

  const onState = useCallback(
    (h: boolean) => {
      setHalted(h);
      onHalted(h);
    },
    [onHalted],
  );

  const loadConnections = useCallback(async () => {
    try {
      const res = await fetch("/api/connections", { cache: "no-store" });
      // Not signed in, or not this role's to read: "Read now" is simply not offered.
      if (!res.ok) return setConnections(null);
      const j = (await res.json()) as { connections?: Connection[] };
      setConnections((j.connections ?? []).filter((c) => c.status === "connected"));
    } catch {
      setConnections(null);
    }
  }, []);

  useEffect(() => {
    void loadConnections();
    return () => {
      if (cool.current !== null) window.clearTimeout(cool.current);
    };
  }, [loadConnections]);

  const readNow = async () => {
    if (!connections || connections.length === 0 || run.phase === "reading" || cooling) return;
    let tally: ReadNowTally = { read: 0, silent: [] };
    for (const c of connections) {
      setRun({ phase: "reading", name: c.label });
      try {
        const res = await fetch("/api/connections/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: c.id }),
        });
        const body = (await res.json().catch(() => null)) as {
          ok?: unknown;
          skipped?: unknown;
        } | null;
        tally = tallied(tally, c.label, readNowOutcome(res.ok, body));
      } catch {
        tally = tallied(tally, c.label, "silent");
      }
    }
    setRun({ phase: "done", ...tally });
    setCooling(true);
    // After the minute the line goes back to when the last read was, which stays true.
    cool.current = window.setTimeout(() => {
      setCooling(false);
      setRun({ phase: "idle" });
    }, COOL_MS);
    onRead();
    void loadConnections();
  };

  // Reading carries on while everything is stopped: the stop halts executions only.
  const canRead = connections !== null && connections.length > 0 && role.can("connections.sync");
  const lastRead = (connections ?? [])
    .map((c) => parseTs(c.last_sync_at ?? ""))
    .filter((ms) => !Number.isNaN(ms))
    .sort((a, b) => b - a)[0];

  const title =
    halted === true
      ? t("now.stopped")
      : nav?.watch
        ? t("watch.title", { day: nav.watch.day, of: nav.watch.of })
        : nav
          ? t("now.working")
          : t("reading");

  return (
    <section className="cs home-now" aria-labelledby="home-now-title">
      <header className="cs-head">
        <div>
          <p className="cs-label">{t("now.label")}</p>
          <h2 className="cs-title" id="home-now-title">
            {title}
          </h2>
        </div>
      </header>
      <div className="cs-body">
        {nav?.watch && halted !== true && (
          <div className="home-days" aria-hidden="true">
            {Array.from({ length: nav.watch.of }, (_, i) => (
              <i
                key={i}
                className={i < nav.watch!.day - 1 ? "d" : i === nav.watch!.day - 1 ? "n" : ""}
              />
            ))}
          </div>
        )}
        <p className="home-now-line">
          {/* The line is the live part; the button beside it is not read out with it. */}
          <span role="status">
            {run.phase === "reading" ? (
              <span className="live">
                <span className="live-dot" aria-hidden="true" />{" "}
                {t("read.reading", { name: run.name })}
              </span>
            ) : run.phase === "done" ? (
              <>
                {t("read.done", { count: run.read })}
                {run.silent.length > 0 && ` ${t("read.silent", { names: run.silent.join(", ") })}`}
              </>
            ) : lastRead !== undefined ? (
              t("read.last", { when: agoText(lastRead, Date.now(), locale) })
            ) : nav?.watch ? (
              t("watch.note")
            ) : null}
          </span>
          {canRead && run.phase !== "reading" && (
            <>
              {" "}
              <button
                type="button"
                className="home-textbtn"
                disabled={cooling}
                onClick={() => void readNow()}
              >
                {t("read.now")}
              </button>
            </>
          )}
        </p>
        <EmergencyStop variant="card" onState={onState} />
      </div>
    </section>
  );
}

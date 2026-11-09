"use client";

// /team · People — P6-06 (TASKS-PHASE6.md, rule 28 amended), its own
// section under the role-level cover, which it leaves exactly as it was.
//
// Each person's own figures, as the owner's booking system recorded them:
// completed appointments, booking revenue, the no-show and late-cancellation
// rates, utilisation against the capacity the owner stated for them, and the
// rebooking rate. Every figure shows what it was counted from; the section
// shows the window and the source. Under the bookings minimums a figure is
// "too few to say". People are listed alphabetically by name and nothing is
// ordered by a figure, marked, coloured or compared: no word here passes a
// verdict on anyone (lib/people/fence.test.ts holds the words to that).
//
// Only the owner sees it: for anyone else /api/team/people answers with the
// role refusal and this renders nothing. With the team module off it also
// renders nothing; the cover screen above already says how to switch it on.
// The owner may state a person's weekly capacity, and remove a person.
//
// Decluttered 2026-11-09 on the owner's instruction: one short line under
// the title says these are facts about the work and never a proposal about
// a person; the longer framing, the source and window, and the gaps sit
// folded under "How this works".

import "../../app/people.css";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Fold } from "../sheet/Fold";
import { SheetCard } from "../sheet/PageHead";
import { moneyText, num } from "../sheet/num";
import { useTr } from "../sheet/useTr";
import type { AppLocale } from "../../lib/i18n/locales";
import { intlTag } from "../../lib/i18n/locales";
import type { Tr } from "../../lib/i18n/tr";
import type { Money } from "../../lib/core/money";
import type { Figure, PersonFigures, PeopleFigures as Figures } from "../../lib/people/figures";
import type { PeopleSource, PeopleView } from "../../lib/people/service";
import { dayIn } from "./TeamScreen";

/** The capacity bounds the API accepts (lib/people/service CAPACITY_MIN/MAX). */
const CAP_MIN = 1;
const CAP_MAX = 1000;

/** A stored percentage (6.1 = 6.1%), at one decimal: "6.1%" in English, Intl's elsewhere. */
export function share(value: number, locale: AppLocale = "en"): string {
  if (locale === "en") return `${value.toFixed(1)}%`;
  return new Intl.NumberFormat(intlTag(locale), {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value / 100);
}

/** Pure: where the figures came from, in words. */
export function sourceText(source: PeopleSource, tr: Tr): string {
  if (source.kind === "square") return tr("source.square");
  return source.platform
    ? tr("source.import", { platform: source.platform })
    : tr("source.importPlain");
}

interface Line {
  value: string;
  sub: string;
  muted: boolean;
}

/** Pure: one figure as its value and what it was counted from — the words the card shows. */
export function figureLine<T>(
  f: Figure<T>,
  shown: (v: T) => string,
  measuredSub: (part: number, of: number) => string,
  tooFewKey: "tooFewDue" | "tooFewClients",
  tr: Tr,
  locale: AppLocale,
): Line {
  if (f.status === "measured") {
    return { value: shown(f.value), sub: measuredSub(f.part, f.of), muted: false };
  }
  if (f.status === "too_few") {
    return {
      value: tr("fig.tooFew"),
      sub: tr(`fig.${tooFewKey}`, { count: f.count, min: num(f.min, 0, locale) }),
      muted: true,
    };
  }
  return { value: tr("fig.notMeasured"), sub: tr(`fig.why.${f.why}`), muted: true };
}

/** Pure: every line of one person's card, in a fixed order — the same for everyone. */
export function personLines(
  p: PersonFigures,
  figures: Pick<Figures, "cohort_from" | "cohort_to" | "rebook_days">,
  tr: Tr,
  locale: AppLocale,
): { key: string; label: string; line: Line }[] {
  const n = (x: number) => num(x, 0, locale);
  const rateSub = (part: number, of: number) => tr("fig.rateOf", { part: n(part), of });
  return [
    {
      key: "completed",
      label: tr("fig.completed"),
      line: {
        value: n(p.completed),
        sub: tr("fig.completedOf", { count: p.appointments }),
        muted: false,
      },
    },
    {
      key: "revenue",
      label: tr("fig.revenue"),
      line: figureLine<Money>(
        p.revenue,
        (m) => moneyText(m.amount_minor, m.currency, locale),
        (part, of) => tr("fig.revenueOf", { part: n(part), of }),
        "tooFewDue",
        tr,
        locale,
      ),
    },
    {
      key: "noShow",
      label: tr("fig.noShow"),
      line: figureLine(p.no_show_rate, (v) => share(v, locale), rateSub, "tooFewDue", tr, locale),
    },
    {
      key: "late",
      label: tr("fig.late"),
      line: figureLine(
        p.late_cancellation_rate,
        (v) => share(v, locale),
        rateSub,
        "tooFewDue",
        tr,
        locale,
      ),
    },
    {
      key: "utilisation",
      label: tr("fig.utilisation"),
      line: figureLine(
        p.utilisation,
        (v) => share(v, locale),
        (part, of) =>
          tr("fig.utilisationOf", {
            part: n(part),
            of: n(of),
            perWeek: n(p.capacity?.per_week ?? 0),
            day: dayIn((p.capacity?.stated_at ?? "").slice(0, 10), locale),
          }),
        "tooFewDue",
        tr,
        locale,
      ),
    },
    {
      key: "rebooking",
      label: tr("fig.rebooking"),
      line: figureLine(
        p.rebooking_rate,
        (v) => share(v, locale),
        (part, of) =>
          tr("fig.rebookingOf", {
            part: n(part),
            of,
            from: dayIn(figures.cohort_from, locale),
            to: dayIn(figures.cohort_to, locale),
            days: n(figures.rebook_days),
          }),
        "tooFewClients",
        tr,
        locale,
      ),
    },
  ];
}

type Busy = { person: string; what: "capacity" | "remove" } | null;

function PersonCard({
  p,
  figures,
  busy,
  onCapacity,
  onRemove,
}: {
  p: PersonFigures;
  figures: Figures;
  busy: Busy;
  onCapacity: (person: string, perWeek: number | null) => Promise<boolean>;
  onRemove: (person: string) => Promise<void>;
}) {
  const { tr, locale } = useTr("people");
  const [draft, setDraft] = useState(p.capacity ? String(p.capacity.per_week) : "");
  const [invalid, setInvalid] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const mine = busy?.person === p.person;

  const save = async () => {
    const v = Number(draft);
    if (!Number.isInteger(v) || v < CAP_MIN || v > CAP_MAX) return setInvalid(true);
    setInvalid(false);
    await onCapacity(p.person, v);
  };

  return (
    <SheetCard className="pp-card" title={p.person}>
      <dl className="pp-figs">
        {personLines(p, figures, tr, locale).map(({ key, label, line }) => (
          <div key={key} className="pp-fig">
            <dt>{label}</dt>
            <dd className={line.muted ? "pp-val muted" : "pp-val"}>{line.value}</dd>
            <dd className="pp-sub">{line.sub}</dd>
          </div>
        ))}
      </dl>
      <form
        className="pp-cap"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          <span>{tr("capacity.label")}</span>
          <input
            type="number"
            inputMode="numeric"
            min={CAP_MIN}
            max={CAP_MAX}
            step={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={invalid}
          />
        </label>
        <button type="submit" className="act" disabled={mine || draft.trim() === ""}>
          {tr("capacity.save")}
        </button>
        {p.capacity && (
          <button
            type="button"
            className="act"
            disabled={mine}
            onClick={() => {
              setDraft("");
              void onCapacity(p.person, null);
            }}
          >
            {tr("capacity.clear")}
          </button>
        )}
        {invalid && (
          <p className="pp-hint">
            {tr("capacity.invalid", { min: num(CAP_MIN, 0, locale), max: num(CAP_MAX, 0, locale) })}
          </p>
        )}
      </form>
      <div className="pp-remove">
        {confirming ? (
          <>
            <p>{tr("remove.confirm", { person: p.person })}</p>
            <button
              type="button"
              className="act solid"
              disabled={mine}
              onClick={() => void onRemove(p.person)}
            >
              {tr("remove.yes")}
            </button>
            <button type="button" className="act" onClick={() => setConfirming(false)}>
              {tr("remove.no")}
            </button>
          </>
        ) : (
          <button type="button" className="act" onClick={() => setConfirming(true)}>
            {tr("remove.button")}
          </button>
        )}
      </div>
    </SheetCard>
  );
}

export function PeopleFigures() {
  const t = useTranslations("people");
  const { tr, locale } = useTr("people");
  const [view, setView] = useState<PeopleView | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/team/people");
      // The owner role only: anyone else, or no one signed in, sees nothing here.
      setView(res.ok ? ((await res.json()) as PeopleView) : null);
    } catch {
      setView(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (method: "POST" | "DELETE", body: object): Promise<Response | null> => {
    try {
      const res = await fetch("/api/team/people", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return res.ok ? res : null;
    } catch {
      return null;
    }
  };

  const onCapacity = async (person: string, perWeek: number | null): Promise<boolean> => {
    setBusy({ person, what: "capacity" });
    const res = await send("POST", { person, per_week: perWeek });
    setNote(res ? null : tr("failed"));
    await load();
    setBusy(null);
    return res !== null;
  };

  const onRemove = async (person: string): Promise<void> => {
    setBusy({ person, what: "remove" });
    const res = await send("DELETE", { person });
    const removed = res ? ((await res.json()) as { appointments?: number }) : null;
    setNote(removed ? tr("remove.done", { count: removed.appointments ?? 0 }) : tr("failed"));
    await load();
    setBusy(null);
  };

  if (!view || !view.enabled) return null;

  return (
    <section className="screen pp-screen" aria-labelledby="pp-title">
      <header className="pp-head">
        <p className="cs-label">
          {tr("label")} · {tr("ownerOnly")}
        </p>
        <h2 id="pp-title">{tr("title")}</h2>
        <p className="pp-copy">{tr("fence")}</p>
        <Fold summary={tr("how")}>
          <p className="pp-copy">{tr("intro")}</p>
          {view.status === "ok" && (
            <>
              <p className="pp-basis">
                {tr("basis", {
                  source: sourceText(view.source, tr),
                  from: dayIn(view.figures.from, locale),
                  to: dayIn(view.figures.to, locale),
                  count: view.figures.people.reduce((s, p) => s + p.appointments, 0),
                })}
              </p>
              <ul className="pp-foot">
                {view.figures.unattributed > 0 && (
                  <li>{tr("unattributed", { count: view.figures.unattributed })}</li>
                )}
                <li>{tr("sales")}</li>
              </ul>
            </>
          )}
        </Fold>
      </header>
      {note && (
        <p className="pp-note" role="status">
          {note}
        </p>
      )}
      {view.status === "no_bookings" ? (
        <p className="pp-copy">
          {t.rich("noBookings", { link: (c) => <Link href="/connections">{c}</Link> })}
        </p>
      ) : view.figures.people.length === 0 ? (
        <p className="pp-copy">{tr("none")}</p>
      ) : (
        <div className="pp-grid">
          {view.figures.people.map((p) => (
            <PersonCard
              key={`${p.person}:${p.capacity?.per_week ?? ""}`}
              p={p}
              figures={view.figures}
              busy={busy}
              onCapacity={onCapacity}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </section>
  );
}

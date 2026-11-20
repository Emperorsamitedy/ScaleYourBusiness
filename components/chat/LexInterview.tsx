"use client";

// The interview with Lex (the owner's fourth round, 2026-11-20): the same
// questions as the form at /intake, asked one at a time in the conversation.
// A choice is a button; a name, a figure or an amount is typed in a small
// box under the question; "I don't know" and "Skip for now" are real
// answers here as they are there (rule 5).
//
// It talks to the interview's own API and to nothing else: POST /api/intake
// for where the interview stands, PUT for each answer, PATCH for a table's
// rows, GET with a part or a question to ask from, and the reconcile route
// for two answers that disagree. Which question comes next is the
// resolver's decision over the bank (rule 4), the fact is recorded by the
// same service with the same source, and no model is called.
//
// Since 2026-11-20 nothing is sent to the form (the owner: "work on the
// three things you said it doesn't do"): a month is picked here, a table is
// built one row and one field at a time, and a file says what the form says,
// since uploads are not open on either. The owner can ask from another part,
// change an answer given in this sitting, and settle two answers that
// disagree, all in the conversation.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { ASSISTANT } from "../../lib/core/assistant";
import { intlTag } from "../../lib/i18n/locales";
import type { AppLocale } from "../../lib/i18n/locales";
import type {
  AnswerAction,
  AnswerResponse,
  IntakeArea,
  IntakeFinding,
  IntakeQuestion,
  IntakeState,
  ReconcileResponse,
} from "../../lib/intake/types";
import { areaAskable, areaName, areaStatusWord, channelNo, leftInArea } from "../intake/record";
import { INTAKE_ERROR_CODES } from "../intake/words";
import { Fold } from "../sheet/Fold";
import { useTr } from "../sheet/useTr";
import { Speaker } from "./ChatTurn";
import type { AnswerKind, Choice, Exchange, RowSay, RowsDraft } from "./interview-model";
import {
  ROWS_MAX,
  anotherRow,
  answerKind,
  answerWords,
  choicesOf,
  fieldAnswered,
  fieldKind,
  monthAnswer,
  pickedAnswer,
  rowDetail,
  rowWords,
  rowsPlan,
  startRows,
  typedAnswer,
  withoutRow,
} from "./interview-model";

/** A refusal from the interview's routes: its code, worded in the reader's language. */
interface Refusal {
  code?: string;
  values?: Record<string, string | number>;
}

/** English keeps en-GB, as the app's dates always have. */
const tagOf = (locale: AppLocale): string => (locale === "en" ? "en-GB" : intlTag(locale));

/** "March 2021" from a picked month; anything else is said as it was typed. */
function monthWords(raw: string, locale: AppLocale): string {
  const v = raw.trim();
  if (!/^\d{4}-\d{2}$/.test(v)) return v;
  return new Date(`${v}-01T12:00:00Z`).toLocaleDateString(tagOf(locale), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * One thing answered: a question, or one field of a table's row. A choice is
 * pressed, several are picked and then sent, the rest is typed or picked and
 * sent with Next. It holds only what is half typed; the caller gives it a
 * key per question, so a new one starts empty.
 */
function Answerer({
  kind,
  choices,
  long,
  unit,
  label,
  busy,
  emptyHint,
  onEmpty,
  onAnswer,
}: {
  kind: AnswerKind;
  choices: readonly Choice[];
  /** A few lines rather than one (the bank's long_text). */
  long: boolean;
  /** The currency beside an amount's box. */
  unit: string | null;
  /** What the box is for, for a screen reader. */
  label: string;
  busy: boolean;
  /** Said when Next is pressed on nothing. Null: nothing typed is `onEmpty`. */
  emptyHint: string | null;
  onEmpty?: () => void;
  /** The answer as the endpoint takes it, and in the words kept beside the question. */
  onAnswer: (wire: unknown, said: string) => void;
}) {
  const { tr, locale } = useTr("chat");
  const { tr: it } = useTr("intake");
  const [typed, setTyped] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [hint, setHint] = useState<string | null>(null);

  const nothing = () => {
    if (emptyHint === null) onEmpty?.();
    else setHint(emptyHint);
  };

  const submit = () => {
    if (kind === "month") {
      const action = monthAnswer(typed);
      if (action === null || action.kind !== "value") return nothing();
      return onAnswer(action.wire, monthWords(typed, locale));
    }
    const read = typedAnswer(kind, typed);
    if (read.ok && read.action.kind === "value") return onAnswer(read.action.wire, typed.trim());
    if (!read.ok && read.reason === "empty") return nothing();
    if (!read.ok && read.reason === "unclear") {
      // An amount written the reader's way with no mark for thousands (rule 3
      // of the catalogue: the figure is formatted here, never typed into a message).
      const example = new Intl.NumberFormat(intlTag(locale), {
        useGrouping: false,
        minimumFractionDigits: 2,
      }).format(1200.5);
      return setHint(tr("interview.unclear", { example }));
    }
    setHint(it("error.unreadable_amount"));
  };

  const hintLine = hint !== null && (
    <p className="lxi-hint" role="alert">
      {hint}
    </p>
  );

  if (kind === "choice") {
    return (
      <div className="lxi-opts">
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            className="ak-chip"
            disabled={busy}
            onClick={() => onAnswer(c.wire, c.label)}
          >
            {c.label}
          </button>
        ))}
      </div>
    );
  }

  if (kind === "many") {
    return (
      <>
        <div className="lxi-opts">
          {choices.map((c) => {
            const on = picked.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                className={on ? "ak-chip on" : "ak-chip"}
                aria-pressed={on}
                disabled={busy}
                onClick={() => {
                  setHint(null);
                  setPicked((p) => (on ? p.filter((x) => x !== c.id) : [...p, c.id]));
                }}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        <p className="lxi-row">
          <button
            type="button"
            className="act solid"
            disabled={busy}
            onClick={() => {
              const action = pickedAnswer(picked);
              if (action === null || action.kind !== "value") return nothing();
              onAnswer(action.wire, answerWords(action, choices, "", { unknown: "", skipped: "" }));
            }}
          >
            {it("question.next")}
          </button>
        </p>
        {hintLine}
      </>
    );
  }

  if (kind !== "words" && kind !== "figure" && kind !== "amount" && kind !== "month") return null;
  const change = (v: string) => {
    setHint(null);
    setTyped(v);
  };
  return (
    <>
      <form
        className="lxi-typed"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {long ? (
          <textarea
            className="lxi-field"
            aria-label={label}
            rows={3}
            autoFocus
            value={typed}
            disabled={busy}
            onChange={(e) => change(e.target.value)}
          />
        ) : (
          <input
            className="lxi-field"
            aria-label={label}
            // A browser with no month picker shows a text box, where a date is typed out.
            type={kind === "month" ? "month" : "text"}
            inputMode={kind === "figure" || kind === "amount" ? "decimal" : undefined}
            autoComplete="off"
            autoFocus
            value={typed}
            disabled={busy}
            onChange={(e) => change(e.target.value)}
          />
        )}
        {unit !== null && <span className="lxi-unit">{unit}</span>}
        <button type="submit" className="act solid" disabled={busy}>
          {it("question.next")}
        </button>
      </form>
      {hintLine}
    </>
  );
}

/**
 * A table (what the business sells, its suppliers), built in the
 * conversation: Lex asks one row's fields one at a time, then whether there
 * is another. What every row is asked and what is only detail is the bank's
 * own marking (interview-model rowsPlan); the rows go back whole, through
 * the endpoint the form's table uses.
 */
function RowsAnswer({
  question,
  busy,
  onRows,
}: {
  question: IntakeQuestion;
  busy: boolean;
  /** The finished rows as the endpoint takes them, and their names for the conversation. */
  onRows: (rows: Record<string, unknown>[], said: string) => void;
}) {
  const { tr, locale } = useTr("chat");
  const { tr: it } = useTr("intake");
  const fields = useMemo(() => question.entity_fields ?? [], [question.entity_fields]);
  const plan = useMemo(() => rowsPlan(fields), [fields]);
  const [draft, setDraft] = useState<RowsDraft | null>(() => (plan ? startRows(plan) : null));

  const say: RowSay = useMemo(
    () => ({
      yes: it("question.yes"),
      no: it("question.no"),
      figure: (n) => new Intl.NumberFormat(intlTag(locale)).format(n),
      money: (major, currency) => {
        try {
          return new Intl.NumberFormat(intlTag(locale), { style: "currency", currency }).format(
            major,
          );
        } catch {
          return `${new Intl.NumberFormat(intlTag(locale)).format(major)} ${currency}`;
        }
      },
    }),
    [it, locale],
  );

  if (!plan || !draft) {
    // A table none of whose fields can be asked here: the form has it.
    return (
      <p className="lxi-row">
        <span className="lxi-meta">{tr("interview.onForm")}</span>
        <Link className="act" href={`/intake?ask=${encodeURIComponent(question.id)}`}>
          {tr("interview.openForm")}
        </Link>
      </p>
    );
  }

  const asked = draft.asking === null ? null : fields.find((f) => f.key === draft.asking);
  const askedKind = asked ? fieldKind(asked) : null;
  /** The row being spoken of, counted from one. */
  const rowNo = (draft.editing ?? draft.rows.length) + 1;
  const between = draft.current === null;
  const isAnchor = asked?.key === plan.anchor.key && draft.editing === null;
  const leave = () => setDraft((d) => (d ? fieldAnswered(d, plan, undefined) : d));

  return (
    <div className="lxi-table">
      {draft.rows.length > 0 && (
        <ol className="lxi-rows">
          {draft.rows.map((row, i) => (
            <li key={i}>
              <span className="lxi-rows-words">{rowWords(fields, row, say).join(" · ")}</span>
              {between && (
                <button
                  type="button"
                  className="lxi-link"
                  disabled={busy}
                  aria-label={it("entity.removeRow", { row: i + 1 })}
                  onClick={() => setDraft((d) => (d ? withoutRow(d, plan, i) : d))}
                >
                  {it("entity.remove")}
                </button>
              )}
            </li>
          ))}
        </ol>
      )}

      {asked && askedKind && (
        <div className="lxi-sub">
          <p className="lxi-sub-q">
            <span className="fig">{rowNo}</span> · {asked.prompt}
          </p>
          <Answerer
            key={`${rowNo}-${asked.key}-${draft.editing === null ? "new" : "detail"}`}
            kind={askedKind}
            choices={choicesOf(asked, { yes: it("question.yes"), no: it("question.no") })}
            long={false}
            unit={askedKind === "amount" ? asked.currency : null}
            label={asked.prompt}
            busy={busy}
            // A row cannot do without its first field; any other, left empty, is left out.
            emptyHint={isAnchor ? it("question.entityEmpty") : null}
            onEmpty={leave}
            onAnswer={(wire) => setDraft((d) => (d ? fieldAnswered(d, plan, wire) : d))}
          />
          {!isAnchor && (
            <p className="lxi-row lxi-quiet">
              <button type="button" className="lxi-link" disabled={busy} onClick={leave}>
                {tr("interview.fieldSkip")}
              </button>
            </p>
          )}
        </div>
      )}

      {between && (
        <p className="lxi-row">
          {draft.rows.length < ROWS_MAX && (
            <button
              type="button"
              className="act"
              disabled={busy}
              onClick={() => setDraft((d) => (d ? anotherRow(d, plan) : d))}
            >
              {it("entity.addRow")}
            </button>
          )}
          {plan.rest.length > 0 && draft.rows.length > 0 && !draft.detailed && (
            <button
              type="button"
              className="act"
              disabled={busy}
              onClick={() => setDraft((d) => (d ? rowDetail(d, plan) : d))}
            >
              {it("entity.addDetail")}
            </button>
          )}
          <button
            type="button"
            className="act solid"
            disabled={busy || draft.rows.length === 0}
            onClick={() =>
              onRows(
                draft.rows,
                draft.rows
                  .map((row) => rowWords([plan.anchor], row, say)[0] ?? "")
                  .filter((name) => name !== "")
                  .join(", "),
              )
            }
          >
            {tr("interview.rowsDone")}
          </button>
        </p>
      )}
    </div>
  );
}

/** The parts of the interview, to ask from another one. A part with nothing to ask cannot be picked. */
function Parts({
  areas,
  active,
  busy,
  onChoose,
}: {
  areas: readonly IntakeArea[];
  active: string | null;
  busy: boolean;
  onChoose: (section: string) => void;
}) {
  const { tr } = useTr("chat");
  const { tr: it } = useTr("intake");
  const channelOf = (section: string): string | null => {
    const i = areas.findIndex((a) => a.section === section);
    return i === -1 ? null : channelNo(i);
  };
  return (
    <ul className="lxi-parts">
      {areas.map((a, i) => {
        const here = a.section === active;
        const askable = areaAskable(a);
        return (
          <li key={a.section}>
            <button
              type="button"
              className="lxi-part"
              disabled={busy || here || !askable}
              aria-current={here ? "true" : undefined}
              onClick={() => onChoose(a.section)}
            >
              <span className="lxi-part-name">
                {it("record.channelTitle", {
                  channel: channelNo(i),
                  area: areaName(a.section, it),
                })}
              </span>
              <span className="lxi-part-state">
                {askable
                  ? tr("interview.left", { count: leftInArea(a) })
                  : areaStatusWord(a, { channelOf, tr: it }).word}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Two answers that disagree, or one outside the usual range: said, with the form's own two ways out. */
function Reconcile({
  finding,
  busy,
  onChoose,
}: {
  finding: IntakeFinding;
  busy: boolean;
  onChoose: (choice: "confirm" | "fix") => void;
}) {
  const { tr: it } = useTr("intake");
  return (
    // The rule that found it is for whoever debugs a report of it, not words for an owner.
    <div className="lxi-card lxi-reconcile" data-rule={finding.rule_id}>
      <p className="ak-who">
        <Speaker />
        <span className="flag drift">{it("reconcile.flag")}</span>
      </p>
      <p className="lxi-prompt">{it(`reconcile.${finding.kind}`)}</p>
      <p className="lxi-meta inset">{finding.message}</p>
      <p className="lxi-row">
        <button type="button" className="act" disabled={busy} onClick={() => onChoose("confirm")}>
          {it("reconcile.confirm")}
        </button>
        <button type="button" className="act" disabled={busy} onClick={() => onChoose("fix")}>
          {it("reconcile.fix")}
        </button>
      </p>
    </div>
  );
}

export function LexInterview({
  onStop,
  ask = null,
  aside,
}: {
  onStop: () => void;
  /** A question to begin from (a gap on the fact sheet names one); the usual order otherwise. */
  ask?: string | null;
  /** What was asked of Lex while the interview runs: drawn above the question it is about. */
  aside?: ReactNode;
}) {
  const { tr } = useTr("chat");
  const { tr: it } = useTr("intake");
  const { tr: nav } = useTr("nav");
  const [state, setState] = useState<IntakeState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [past, setPast] = useState<(Exchange & { n: number })[]>([]);
  /** The part the owner chose to be asked from; null in the usual order. */
  const [focus, setFocus] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const seq = useRef(0);
  const end = useRef<HTMLDivElement | null>(null);

  // The words as of the latest render, for what runs later (a request's
  // answer). useTr() hands back a new translator on every render, so nothing
  // that must run once may depend on it: the read below did, and asked the
  // server where the interview stands after every render, without end, each
  // answer putting back the usual question over a part the owner had chosen.
  const words = useRef(it);
  words.current = it;

  /** A refusal in the reader's language: its code when the catalogue has it. */
  const refusal = useCallback((payload: Refusal | null, fallback: string): string => {
    const say = words.current;
    const code = payload?.code;
    if (!code || !INTAKE_ERROR_CODES.has(code)) return say(fallback);
    const values = payload?.values ?? {};
    const problem = say(`error.${code}`, values);
    return typeof values.field === "string"
      ? say("error.field", { field: values.field, problem })
      : problem;
  }, []);

  /** Take a new state; a chosen part ends once it has nothing left to ask. */
  const adopt = useCallback((next: IntakeState, part: string | null) => {
    setState(next);
    setFocus(part !== null && next.question?.section === part ? part : null);
  }, []);

  // Where the interview stands: the question the resolver has next, or the one
  // asked for. Read once when the interview opens.
  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch("/api/intake", { method: "POST" });
      if (!res.ok) throw new Error("no");
      let next = (await res.json()) as IntakeState;
      if (ask !== null && ask !== "") {
        const preferred = await fetch(`/api/intake?ask=${encodeURIComponent(ask)}`);
        if (preferred.ok) next = (await preferred.json()) as IntakeState;
      }
      if (alive) adopt(next, null);
    })().catch(() => {
      if (alive) setFailed(words.current("error.open"));
    });
    return () => {
      alive = false;
    };
  }, [ask, adopt]);

  const question = state?.question ?? null;
  const id = question?.id ?? null;
  const finding =
    state?.findings.find((f) => f.kind === "contradiction" || f.kind === "implausible") ?? null;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [id, past.length, finding?.id, choosing]);

  /** One call to the interview's routes; a refusal is said in the reader's words. */
  const call = useCallback(
    async <T,>(
      url: string,
      init: RequestInit | undefined,
      fallback: string,
      then: (body: T) => void,
    ): Promise<void> => {
      if (busy) return;
      setBusy(true);
      setFailed(null);
      try {
        const res = await fetch(url, init);
        if (!res.ok) {
          setFailed(refusal((await res.json().catch(() => null)) as Refusal | null, fallback));
          return;
        }
        then((await res.json()) as T);
      } catch {
        setFailed(words.current("error.unreachable"));
      } finally {
        setBusy(false);
      }
    },
    [busy, refusal],
  );
  const json = (method: string, body: Record<string, unknown>): RequestInit => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(focus ? { ...body, section: focus } : body),
  });

  const keep = (q: IntakeQuestion, answer: string, answered: boolean) => {
    seq.current += 1;
    const n = seq.current;
    setPast((p) => [...p, { id: q.id, prompt: q.prompt, answer, answered, n }]);
  };

  const answer = (action: AnswerAction, said: string) => {
    if (!question) return;
    const q = question;
    void call<AnswerResponse>(
      "/api/intake",
      json("PUT", { question_id: q.id, action }),
      "error.record",
      (next) => {
        keep(q, said, action.kind !== "skip");
        adopt(next.state, focus);
      },
    );
  };

  const answerRows = (rows: Record<string, unknown>[], said: string) => {
    if (!question) return;
    const q = question;
    void call<AnswerResponse>(
      "/api/intake",
      json("PATCH", { question_id: q.id, rows }),
      "error.record",
      (next) => {
        keep(q, said, true);
        adopt(next.state, focus);
      },
    );
  };

  /** Ask from another part while it has questions open, as the form's row of parts does. */
  const choosePart = (section: string) => {
    setChoosing(false);
    void call<IntakeState>(
      `/api/intake?section=${encodeURIComponent(section)}`,
      undefined,
      "error.open",
      (next) => adopt(next, section),
    );
  };

  /** An answer given in this sitting goes back to be asked again; the old one stays in history. */
  const change = (x: Exchange & { n: number }) => {
    void call<AnswerResponse>(
      "/api/intake",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question_id: x.id,
          action: { kind: "reopen", reason: `changed in the conversation with ${ASSISTANT}` },
        }),
      },
      "error.reopen",
      (next) => {
        setPast((p) => p.filter((e) => e.n !== x.n));
        adopt(next.state, null);
      },
    );
  };

  const reconcile = (found: IntakeFinding, choice: "confirm" | "fix") => {
    void call<ReconcileResponse>(
      "/api/intake/reconcile",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ finding_id: found.id, choice }),
      },
      "error.record",
      (next) => adopt(next.state, null),
    );
  };

  const kind = question ? answerKind(question) : null;
  const choices = question
    ? choicesOf(question, { yes: it("question.yes"), no: it("question.no") })
    : [];
  const areas = state?.areas ?? [];
  const area = question ? (areas.find((a) => a.section === question.section) ?? null) : null;
  const areaIndex = area ? areas.indexOf(area) : -1;
  /** More than one part with something to ask: only then is there another to choose. */
  const canChoose = areas.filter(areaAskable).length > 1;

  return (
    <div className="lxi" aria-live="polite">
      <p className="lxi-intro">{tr("interview.intro")}</p>

      {past.map((x) => (
        <div className="lxi-past" key={x.n}>
          <p className="lxi-past-q">{x.prompt}</p>
          <p className="lxi-past-a">
            <span>{x.answer}</span>
            {x.answered && (
              <button type="button" className="lxi-link" disabled={busy} onClick={() => change(x)}>
                {it("record.change")}
              </button>
            )}
          </p>
        </div>
      ))}

      {aside}

      {state === null && failed === null && <p className="lx-note">{tr("loading")}</p>}

      {state?.done && (
        <div className="lxi-card">
          <p className="ak-who">
            <Speaker />
          </p>
          <p className="lxi-prompt">{it("done.title")}</p>
          <p className="lxi-meta">{it("done.lede")}</p>
          <p className="lxi-row">
            <Link className="act solid" href="/profile">
              {nav("item.factsheet")}
            </Link>
          </p>
        </div>
      )}

      {finding && !state?.done && (
        <Reconcile
          finding={finding}
          busy={busy}
          onChoose={(choice) => reconcile(finding, choice)}
        />
      )}

      {question && kind && (
        <div className="lxi-card" aria-busy={busy}>
          <p className="ak-who">
            <Speaker live={busy} />
            {area && areaIndex >= 0 && (
              <span className="ak-at">
                {it("record.channelTitle", {
                  channel: channelNo(areaIndex),
                  area: areaName(area.section, it),
                })}
                {" · "}
                {tr("interview.left", { count: leftInArea(area) })}
              </span>
            )}
          </p>
          <p className="lxi-prompt">{question.prompt}</p>
          {question.help && (
            <Fold label="why" className="lxi-why">
              <p>{question.help}</p>
            </Fold>
          )}

          {kind === "rows" ? (
            <RowsAnswer key={question.id} question={question} busy={busy} onRows={answerRows} />
          ) : kind === "file" ? (
            // Uploads are not open on the form either: the same words, and the two answers below.
            <>
              <p className="lxi-meta">{it("question.fileStub")}</p>
              <p className="lxi-meta cap1">
                {question.allow_unknown ? it("question.fileUnknown") : it("question.fileSkip")}
              </p>
            </>
          ) : kind === "form" ? (
            <p className="lxi-row">
              <span className="lxi-meta">{tr("interview.onForm")}</span>
              <Link className="act" href={`/intake?ask=${encodeURIComponent(question.id)}`}>
                {tr("interview.openForm")}
              </Link>
            </p>
          ) : (
            <Answerer
              key={question.id}
              kind={kind}
              choices={choices}
              long={question.input_type === "long_text"}
              unit={kind === "amount" ? question.currency : null}
              label={question.prompt}
              busy={busy}
              emptyHint={
                question.allow_unknown ? it("question.emptyUnknown") : it("question.emptySkip")
              }
              onAnswer={(wire, said) => answer({ kind: "value", wire }, said)}
            />
          )}

          {failed !== null && (
            <p className="lxi-hint" role="alert">
              {failed}
            </p>
          )}

          <p className="lxi-row lxi-quiet">
            {question.allow_unknown && (
              <button
                type="button"
                className="lxi-link"
                disabled={busy}
                onClick={() => answer({ kind: "unknown" }, it("question.unknown"))}
              >
                {it("question.unknown")}
              </button>
            )}
            <button
              type="button"
              className="lxi-link"
              disabled={busy}
              onClick={() => answer({ kind: "skip" }, it("question.skip"))}
            >
              {it("question.skip")}
            </button>
            {canChoose && (
              <button
                type="button"
                className="lxi-link"
                disabled={busy}
                aria-expanded={choosing}
                onClick={() => setChoosing((o) => !o)}
              >
                {choosing ? it("bank.hide") : it("bank.all")}
              </button>
            )}
            <button type="button" className="lxi-link" disabled={busy} onClick={onStop}>
              {tr("interview.stop")}
            </button>
          </p>
          {focus !== null && area && !choosing && (
            <p className="lxi-meta">{it("stage.focus", { area: areaName(area.section, it) })}</p>
          )}
          {choosing && (
            <Parts areas={areas} active={question.section} busy={busy} onChoose={choosePart} />
          )}
        </div>
      )}

      {/* With a question on screen the refusal is said in its card; otherwise here. */}
      {!question && failed !== null && (
        <p className="lxi-hint" role="alert">
          {failed}
        </p>
      )}
      <div ref={end} />
    </div>
  );
}

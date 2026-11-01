"use client";

// The question panel (owner design intake-v2): a dark header band naming
// the bank id, the channel and the area, with how many questions are left
// there; then a paper body on faint graph paper with the bank id as an
// outlined watermark.
//
// Inside, top to bottom, each piece only when the data holds it:
//   ALREADY MEASURED · <provider>  the connector measurement on record for
//                                  this question (already_read)
//   THE MISSING PIECE              beside it, when that measurement sits
//                                  beneath this question's field and the
//                                  question is still open for the rest
//   the prompt                     the sheet's one Zilla heading — no
//                                  marker highlight: the bank marks no
//                                  emphasis, and guessing one would put
//                                  words in its mouth
//   the choices                    a row of tiles with boxed number keys
//   the ruler                      money only, when a measured reference
//                                  exists: an axis with its cobalt marker
//   NO READING — I DON'T KNOW      the dashed tile wherever the bank allows
//                                  an unknown; an explicit unknown stays
//                                  distinct from a skip (rule 5)
//   PURPOSE: <help>                the bank's own help text
//   ← Q <prev> · SKIP FOR NOW · NEXT →
//
// The design's WORTH KNOWING box ("every €1 here moves your margin by
// €134") is not drawn: no sensitivity figure exists in the data.
//
// Number keys 1–9 press tiles — never while the owner is typing in a
// field. Validation is inline and specific, and clears on the next input
// (§4.2). Nothing here branches on a question's content (rule 4): the
// input type and the bank's flags decide everything.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import type { AnswerAction, IntakeQuestion } from "@/lib/intake/types";
import type { ControlChange } from "./controls/shared";
import { CONFIRM_MS, beat } from "./motion";
import {
  areaName,
  currencyMark,
  factLabel,
  factValue,
  keyHint,
  minutesFor,
  moneyReference,
  numberKeyIndex,
  rulerScale,
} from "./record";
import { num } from "../sheet/num";
import { DateControl } from "./controls/DateInput";
import { EntityListControl } from "./controls/EntityList";
import type { EntityRow } from "./controls/EntityList";
import { FileStubControl } from "./controls/FileStub";
import { LongTextControl } from "./controls/LongText";
import { MoneyControl } from "./controls/Money";
import { NumberControl } from "./controls/Number";
import { OptionRow, OptionRows } from "./controls/Rows";
import type { RowSpec } from "./controls/Rows";
import { TextControl } from "./controls/Text";
import { clearPrefill, prefillFor } from "../../lib/intake/browser-prefill";
import { useIntakeWords } from "./words";

interface QuestionCardProps {
  question: IntakeQuestion;
  /** "03": the channel number of the question's area on the bank. */
  channel: string | null;
  /** Questions left in this area, this one included. */
  left: number;
  /** The question "← Q …" reopens, when there is one. */
  previous: string | null;
  leaving: boolean;
  serverError: string | null;
  onAnswer: (action: AnswerAction) => void;
  onEntityRows: (rows: EntityRow[]) => void;
  onBack: (questionId: string) => void;
  onClearError: () => void;
  /** P0-87: first interaction with the control — the hesitation mark. */
  onFirstInput?: () => void;
}

const CHOICE_TYPES = new Set<IntakeQuestion["input_type"]>([
  "single_select",
  "boolean",
  "multi_select",
]);

/** Minor ticks per labelled step on the money ruler. */
const RULER_MINOR = 5;

function MoneyRuler({ question }: { question: IntakeQuestion }) {
  const { tr, locale } = useIntakeWords();
  const ref = moneyReference(question, locale);
  const scale = ref ? rulerScale(ref.major) : null;
  if (!ref || !scale || !question.already_read) return null;
  const { mark, before } = currencyMark(ref.currency, locale);
  const label = (n: number): string => {
    const decimals = Number.isInteger(n) ? 0 : 1;
    return before ? `${mark}${num(n, decimals, locale)}` : `${num(n, decimals, locale)} ${mark}`;
  };
  const ticks = Array.from({ length: 5 * RULER_MINOR + 1 }, (_, i) => i);
  const at = `${Math.min(1, scale.at) * 100}%`;
  return (
    <figure className="ix-ruler" aria-label={tr("question.ruler", { value: ref.text })}>
      <figcaption className="ix-ruler-ref" style={{ left: at }}>
        {question.already_read.provider} · <span className="fig">{ref.text}</span>
      </figcaption>
      <div className="ix-ruler-axis" aria-hidden="true">
        {ticks.map((i) => (
          <span
            key={i}
            className={i % RULER_MINOR === 0 ? "ix-tick major" : "ix-tick"}
            style={{ left: `${(i / (5 * RULER_MINOR)) * 100}%` }}
          />
        ))}
        <span className="ix-ruler-mark" style={{ left: at }} />
      </div>
      <div className="ix-ruler-labels" aria-hidden="true">
        {scale.labels.map((n) => (
          <span key={n} className="fig" style={{ left: `${(n / scale.max) * 100}%` }}>
            {label(n)}
          </span>
        ))}
      </div>
    </figure>
  );
}

export function QuestionCard({
  question,
  channel,
  left,
  previous,
  leaving,
  serverError,
  onAnswer,
  onEntityRows,
  onBack,
  onClearError,
  onFirstInput,
}: QuestionCardProps) {
  const [draft, setDraft] = useState<ControlChange>({ wire: null });
  const [entityRows, setEntityRows] = useState<EntityRow[] | null>(null);
  const [entityValid, setEntityValid] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [isMac, setIsMac] = useState(false);
  const committing = useRef(false);
  const firstRow = useRef<HTMLButtonElement>(null);
  const t = useTranslations("intake.question");
  const { tr, locale } = useIntakeWords();
  const fig = (chunks: ReactNode) => <span className="fig">{chunks}</span>;

  const type = question.input_type;
  const isChoice = CHOICE_TYPES.has(type);
  // Read after mount: storage is browser-only, and the server render must match.
  const [prefill, setPrefill] = useState<string | null>(null);
  useEffect(() => {
    setPrefill(prefillFor(question.writes_to));
  }, [question.writes_to]);
  const labelId = `q-${question.id}`;

  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform)) setIsMac(true);
  }, []);

  // A choice question starts on the first tile so the number keys work at once.
  useEffect(() => {
    if (isChoice) firstRow.current?.focus({ preventScroll: true });
  }, [isChoice]);

  const touched = (): void => {
    onFirstInput?.();
    setLocalError(null);
    onClearError();
  };

  const handleChange = (change: ControlChange): void => {
    touched();
    setDraft(change);
  };

  /** Once per card: the depart animation follows, and a second press must not record twice. */
  const commit = useCallback(
    (action: AnswerAction): void => {
      if (leaving || committing.current) return;
      committing.current = true;
      clearPrefill(question.writes_to);
      onAnswer(action);
      // The card stays mounted if the server refuses; let it try again.
      window.setTimeout(() => {
        committing.current = false;
      }, 600);
    },
    [leaving, onAnswer],
  );

  const emptyMessage = question.allow_unknown ? t("emptyUnknown") : t("emptySkip");

  const record = (change: ControlChange): void => {
    if (leaving) return;
    if (type === "entity_list") {
      if (!entityValid || !entityRows) {
        setLocalError(t("entityEmpty"));
        return;
      }
      onEntityRows(entityRows);
      return;
    }
    if (change.wire === null || change.wire === undefined) {
      setLocalError(emptyMessage);
      return;
    }
    commit(
      change.estimate === true
        ? { kind: "value", wire: change.wire, estimate: true }
        : { kind: "value", wire: change.wire },
    );
  };

  /** A single choice: ink fills the tile, a confirm beat, then it records (§4.2). */
  const choose = (id: string, wire: unknown): void => {
    if (leaving || committing.current) return;
    touched();
    setPicked([id]);
    window.setTimeout(() => commit({ kind: "value", wire }), beat(CONFIRM_MS));
  };

  const choiceRows: RowSpec[] = (() => {
    switch (type) {
      case "single_select":
        return question.options.map((o) => ({
          id: o.code,
          label: o.label,
          pressed: picked.includes(o.code),
          onPress: () => choose(o.code, o.code),
        }));
      case "boolean":
        return [
          {
            id: "yes",
            label: t("yes"),
            pressed: picked.includes("yes"),
            onPress: () => choose("yes", true),
          },
          {
            id: "no",
            label: t("no"),
            pressed: picked.includes("no"),
            onPress: () => choose("no", false),
          },
        ];
      case "multi_select":
        return question.options.map((o) => ({
          id: o.code,
          label: o.label,
          pressed: picked.includes(o.code),
          onPress: () => {
            touched();
            const next = picked.includes(o.code)
              ? picked.filter((c) => c !== o.code)
              : [...picked.filter((c) => c !== "__unknown__"), o.code];
            setPicked(next);
            setDraft({ wire: next.length > 0 ? [...next] : null });
          },
        }));
      default:
        return [];
    }
  })();

  const unknownRow: RowSpec | null = question.allow_unknown
    ? {
        id: "__unknown__",
        label: t("unknown"),
        pressed: picked.includes("__unknown__"),
        unknown: true,
        onPress: () => {
          if (leaving || committing.current) return;
          touched();
          setPicked(["__unknown__"]);
          window.setTimeout(() => commit({ kind: "unknown" }), beat(CONFIRM_MS));
        },
      }
    : null;
  const rows: RowSpec[] = unknownRow ? [...choiceRows, unknownRow] : choiceRows;

  // Number keys press tiles — read from the tiles actually drawn.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const i = numberKeyIndex(e.key, e.target as HTMLElement | null, {
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
      });
      if (i === null) return;
      const row = rowsRef.current[i];
      if (!row) return;
      e.preventDefault();
      row.onPress();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const field = ((): ReactNode => {
    const props = { question, onChange: handleChange, onCommit: record, initial: prefill };
    switch (type) {
      case "text":
        // Keyed on the draft: storage is read after mount, so a waiting draft re-creates the field with it.
        return <TextControl key={prefill ?? ""} {...props} />;
      case "long_text":
        return <LongTextControl {...props} />;
      case "number":
        return <NumberControl {...props} />;
      case "money":
        return <MoneyControl {...props} />;
      case "date":
        return <DateControl {...props} />;
      case "entity_list":
        return (
          <EntityListControl
            question={question}
            onRowsChange={(next) => {
              setEntityRows(next);
              setEntityValid(next.length > 0);
              setLocalError(null);
              onClearError();
            }}
            onRequestSubmit={() => record(draft)}
          />
        );
      case "file":
        return <FileStubControl question={question} />;
      default:
        return null;
    }
  })();

  const error = serverError ?? localError;
  const hint = keyHint(type, isMac, tr);
  const needsNext = !(type === "single_select" || type === "boolean" || type === "file");
  const nextDisabled =
    leaving ||
    (type === "entity_list" ? !entityValid : draft.wire === null || draft.wire === undefined);
  const read = question.already_read;
  const readValue = read ? factValue(read, tr, locale) : null;
  const missingMark = type === "money" ? currencyMark(question.currency, locale) : null;
  // Money and the plain fields share the last row with the unknown tile.
  const inLastRow = type === "money" || type === "number" || type === "date" || type === "text";

  return (
    <article className={leaving ? "ix-q sheet leaving" : "ix-q sheet"} aria-labelledby={labelId}>
      <header className="ix-q-band">
        <span className="ix-cap">
          {t.rich("ref", { id: question.id, fig })}
          {channel && <> · {t.rich("channel", { channel, fig })}</>} ·{" "}
          {areaName(question.section, tr)}
        </span>
        {left > 0 && (
          <span className="ix-cap ix-q-left">
            {t.rich("left", { left, minutes: minutesFor(left), fig })}
          </span>
        )}
      </header>

      <div className="ix-q-body">
        <span className="ix-watermark" aria-hidden="true">
          {question.id}
        </span>

        {read && readValue && (
          <div className="ix-insets">
            <div className="ix-measured">
              <p className="ix-cap">{t("measured", { provider: read.provider ?? "" })}</p>
              <p className="ix-measured-row">
                <strong className="ix-measured-val fig">{readValue.text}</strong>
                <span className="ix-measured-what">{factLabel(read)}</span>
              </p>
            </div>
            {question.missing_piece && (
              <div className="ix-missing">
                <p className="ix-cap">{t("missing")}</p>
                <p className="ix-measured-row">
                  <strong className="ix-measured-val fig" aria-hidden="true">
                    {missingMark?.before ? `${missingMark.mark} ?` : "?"}
                  </strong>
                  <span className="ix-measured-what">
                    {t("missingRest", { provider: read.provider ?? "" })}
                  </span>
                </p>
              </div>
            )}
          </div>
        )}

        <h2 className="ix-prompt" id={labelId}>
          {question.prompt}
        </h2>

        {!inLastRow && field && <div className="ix-field">{field}</div>}
        {choiceRows.length > 0 && (
          <OptionRows
            rows={choiceRows}
            labelledBy={labelId}
            disabled={leaving}
            firstRef={firstRow}
          />
        )}
        {type === "money" && <MoneyRuler question={question} />}
        {(unknownRow || inLastRow) && (
          <div className={inLastRow ? "ix-q-last" : "ix-q-last solo"}>
            {unknownRow && (
              <OptionRow
                ref={choiceRows.length === 0 && !inLastRow ? firstRow : undefined}
                row={unknownRow}
                index={choiceRows.length}
                disabled={leaving}
              />
            )}
            {inLastRow && field}
          </div>
        )}

        {error && (
          <p className="ix-err" role="alert">
            {error}
          </p>
        )}

        <footer className="ix-q-foot">
          {question.help ? (
            <p className="ix-purpose">
              {t.rich("purpose", {
                help: question.help,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          ) : (
            <span />
          )}
          <div className="ix-q-nav">
            {previous && (
              <button
                type="button"
                className="ix-navlink"
                disabled={leaving}
                onClick={() => onBack(previous)}
                title={t("backTitle")}
              >
                &larr; {t.rich("ref", { id: previous, fig })}
              </button>
            )}
            <button
              type="button"
              className="ix-navlink"
              disabled={leaving}
              onClick={() => commit({ kind: "skip" })}
            >
              {t("skip")}
            </button>
            {needsNext && (
              <button
                type="button"
                className="ix-navlink strong"
                disabled={nextDisabled}
                onClick={() => record(draft)}
              >
                {t("next")} &rarr;
              </button>
            )}
          </div>
        </footer>
        {hint && <p className="ix-note ix-hint">{hint}</p>}
      </div>
    </article>
  );
}

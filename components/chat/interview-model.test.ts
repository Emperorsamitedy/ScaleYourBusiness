// The interview with Lex: how a question is answered in the conversation,
// and what goes back to the interview's own endpoint (interview-model.ts).

import { describe, expect, it } from "vitest";
import type { EntityField, IntakeQuestion } from "../../lib/intake/types";
import {
  ROWS_MAX,
  anotherRow,
  answerKind,
  answerWords,
  asksForInterview,
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

const q = (input_type: IntakeQuestion["input_type"], options: [string, string][] = []) => ({
  input_type,
  options: options.map(([code, label]) => ({ code, label })),
});
const WORDS = { yes: "Yes", no: "No" };
const SAID = { unknown: "I don't know", skipped: "Skipped for now" };

describe("how a question is answered in the conversation", () => {
  it("presses for a choice, picks for several, types for the rest", () => {
    expect(answerKind(q("single_select"))).toBe("choice");
    expect(answerKind(q("boolean"))).toBe("choice");
    expect(answerKind(q("multi_select"))).toBe("many");
    expect(answerKind(q("text"))).toBe("words");
    expect(answerKind(q("long_text"))).toBe("words");
    expect(answerKind(q("number"))).toBe("figure");
    expect(answerKind(q("money"))).toBe("amount");
  });

  it("picks a month, builds a table row by row, and says a file cannot be given yet", () => {
    expect(answerKind(q("date"))).toBe("month");
    expect(answerKind(q("entity_list"))).toBe("rows");
    expect(answerKind(q("file"))).toBe("file");
  });

  it("gives the way to the form only for a kind it does not know", () => {
    expect(answerKind({ input_type: "signature" as IntakeQuestion["input_type"] })).toBe("form");
  });
});

describe("a picked month", () => {
  it("goes back as the first of that month, as the form's picker sends it", () => {
    expect(monthAnswer("2021-03")).toEqual({ kind: "value", wire: "2021-03-01" });
  });

  it("keeps a full date typed where there is no picker, and nothing picked is no answer", () => {
    expect(monthAnswer(" 2021-03-15 ")).toEqual({ kind: "value", wire: "2021-03-15" });
    expect(monthAnswer("  ")).toBeNull();
  });
});

describe("the buttons of a question", () => {
  it("are its options, each sending its own code", () => {
    expect(
      choicesOf(
        q("single_select", [
          ["retail", "Retail shop"],
          ["cafe", "Café"],
        ]),
        WORDS,
      ),
    ).toEqual([
      { id: "retail", label: "Retail shop", wire: "retail" },
      { id: "cafe", label: "Café", wire: "cafe" },
    ]);
  });

  it("are Yes and No for a yes-or-no question, sending true and false", () => {
    expect(choicesOf(q("boolean"), WORDS)).toEqual([
      { id: "yes", label: "Yes", wire: true },
      { id: "no", label: "No", wire: false },
    ]);
  });
});

describe("a typed answer", () => {
  it("is the words as typed, trimmed", () => {
    expect(typedAnswer("words", "  Harbour Lane Bakery ")).toEqual({
      ok: true,
      action: { kind: "value", wire: "Harbour Lane Bakery" },
    });
  });

  it("is a number for a figure, however the person writes it", () => {
    expect(typedAnswer("figure", "12")).toEqual({ ok: true, action: { kind: "value", wire: 12 } });
    expect(typedAnswer("figure", "12,5")).toEqual({
      ok: true,
      action: { kind: "value", wire: 12.5 },
    });
    expect(typedAnswer("figure", "1 234")).toEqual({
      ok: true,
      action: { kind: "value", wire: 1234 },
    });
  });

  it("is a decimal amount for money: the server turns it into minor units (rule 1)", () => {
    expect(typedAnswer("amount", "1,234.50")).toEqual({
      ok: true,
      action: { kind: "value", wire: { amount_major: 1234.5 } },
    });
    expect(typedAnswer("amount", "34")).toEqual({
      ok: true,
      action: { kind: "value", wire: { amount_major: 34 } },
    });
  });

  it("is never guessed: nothing typed, not a number, or a figure that reads two ways", () => {
    expect(typedAnswer("words", "   ")).toEqual({ ok: false, reason: "empty" });
    expect(typedAnswer("figure", "")).toEqual({ ok: false, reason: "empty" });
    expect(typedAnswer("figure", "about twelve")).toEqual({ ok: false, reason: "unreadable" });
    // Twelve hundred, or one point two?
    expect(typedAnswer("amount", "1.200")).toEqual({ ok: false, reason: "unclear" });
    expect(typedAnswer("figure", "12,000")).toEqual({ ok: false, reason: "unclear" });
    // A kind that is not typed at all.
    expect(typedAnswer("choice", "yes")).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("several options picked", () => {
  it("go back as their codes, and nothing picked is no answer", () => {
    expect(pickedAnswer(["a", "c"])).toEqual({ kind: "value", wire: ["a", "c"] });
    expect(pickedAnswer([])).toBeNull();
  });
});

describe("the answer the conversation keeps beside its question", () => {
  const choices = choicesOf(
    q("single_select", [
      ["retail", "Retail shop"],
      ["cafe", "Café"],
    ]),
    WORDS,
  );

  it("is the option's own words, not its code", () => {
    expect(answerWords({ kind: "value", wire: "cafe" }, choices, "", SAID)).toBe("Café");
    expect(answerWords({ kind: "value", wire: ["retail", "cafe"] }, choices, "", SAID)).toBe(
      "Retail shop, Café",
    );
    expect(
      answerWords({ kind: "value", wire: true }, choicesOf(q("boolean"), WORDS), "", SAID),
    ).toBe("Yes");
  });

  it("is what was typed, and says so when a question was skipped or not known", () => {
    expect(answerWords({ kind: "value", wire: 34 }, [], " 34 ", SAID)).toBe("34");
    expect(answerWords({ kind: "unknown" }, choices, "", SAID)).toBe("I don't know");
    expect(answerWords({ kind: "skip" }, choices, "", SAID)).toBe("Skipped for now");
  });
});

// A table of rows (what the business sells, its suppliers), built in the
// conversation: one row at a time, one field of it at a time.
describe("a table built in the conversation", () => {
  const field = (
    key: string,
    input_type: EntityField["input_type"],
    priority: EntityField["priority"] = "core",
    options: [string, string][] = [],
  ): EntityField => ({
    key,
    prompt: key,
    input_type,
    priority,
    currency: "EUR",
    options: options.map(([code, label]) => ({ code, label })),
  });
  const FIELDS = [
    field("name", "text"),
    field("price", "money"),
    field("kind", "single_select", "important", [
      ["good", "A product"],
      ["service", "A service"],
    ]),
    field("photo", "file", "optional"),
    field("since", "date", "optional"),
  ];
  const plan = rowsPlan(FIELDS)!;
  const SAY = {
    yes: "Yes",
    no: "No",
    money: (major: number, currency: string) => `${currency} ${major.toFixed(2)}`,
    figure: (n: number) => String(n),
  };

  it("asks the first field and the other core ones for every row, the rest only as detail", () => {
    expect(plan.anchor.key).toBe("name");
    expect(plan.core.map((f) => f.key)).toEqual(["name", "price"]);
    // A file inside a row is not asked; a date in a row is typed, as on the form.
    expect(plan.rest.map((f) => f.key)).toEqual(["kind", "since"]);
    expect(fieldKind(FIELDS[4]!)).toBe("words");
    expect(fieldKind(FIELDS[3]!)).toBeNull();
  });

  it("makes the first askable field the one a row needs when the bank marks none as core", () => {
    const loose = rowsPlan([field("photo", "file", "optional"), field("label", "text", "deep")])!;
    expect(loose.anchor.key).toBe("label");
    expect(loose.core.map((f) => f.key)).toEqual(["label"]);
    expect(loose.rest).toEqual([]);
    expect(rowsPlan([field("photo", "file")])).toBeNull();
  });

  it("builds a row field by field, and a field left out is simply not in the row", () => {
    let d = startRows(plan);
    expect(d.asking).toBe("name");
    d = fieldAnswered(d, plan, "Speckled mug");
    expect(d.asking).toBe("price");
    d = fieldAnswered(d, plan, undefined); // left out
    expect(d).toEqual({
      rows: [{ name: "Speckled mug" }],
      current: null,
      asking: null,
      editing: null,
      detailed: false,
    });
  });

  it("adds a row, gives the last one its detail, and takes a row out", () => {
    let d = fieldAnswered(fieldAnswered(startRows(plan), plan, "Mug"), plan, { amount_major: 24 });
    d = anotherRow(d, plan);
    expect(d.asking).toBe("name");
    d = fieldAnswered(fieldAnswered(d, plan, "Plate"), plan, { amount_major: 31.5 });
    expect(d.rows).toHaveLength(2);

    // Detail is for the last row: its other fields, in order.
    d = rowDetail(d, plan);
    expect([d.asking, d.editing]).toEqual(["kind", 1]);
    d = fieldAnswered(d, plan, "good");
    expect(d.asking).toBe("since");
    d = fieldAnswered(d, plan, undefined);
    expect(d.rows[1]).toEqual({ name: "Plate", price: { amount_major: 31.5 }, kind: "good" });
    expect([d.current, d.detailed]).toEqual([null, true]);

    d = withoutRow(d, plan, 0);
    expect(d.rows.map((r) => r.name)).toEqual(["Plate"]);
    // With no row left, the first one is asked for again.
    expect(withoutRow(d, plan, 0)).toEqual(startRows(plan));
  });

  it("changes nothing when a step makes no sense where the table stands", () => {
    const building = fieldAnswered(startRows(plan), plan, "Mug"); // price is being asked
    expect(anotherRow(building, plan)).toBe(building);
    expect(rowDetail(building, plan)).toBe(building);
    expect(withoutRow(building, plan, 0)).toBe(building);
    const done = fieldAnswered(building, plan, undefined);
    expect(fieldAnswered(done, plan, "stray")).toBe(done);
    expect(withoutRow(done, plan, 5)).toBe(done);
  });

  it("holds no more rows than the form's table", () => {
    let d = startRows(plan);
    for (let i = 0; i < ROWS_MAX; i++) {
      if (i > 0) d = anotherRow(d, plan);
      d = fieldAnswered(fieldAnswered(d, plan, `Item ${i}`), plan, undefined);
    }
    expect(d.rows).toHaveLength(ROWS_MAX);
    expect(anotherRow(d, plan)).toBe(d);
  });

  it("says a row in words: a code by its label, money and figures as the screen formats them", () => {
    expect(
      rowWords(
        FIELDS,
        { name: "Plate", price: { amount_major: 31.5 }, kind: "good", since: "2021" },
        SAY,
      ),
    ).toEqual(["Plate", "EUR 31.50", "A product", "2021"]);
    expect(
      rowWords(
        [field("vegan", "boolean"), field("sizes", "number")],
        { vegan: false, sizes: 3 },
        SAY,
      ),
    ).toEqual(["No", "3"]);
    expect(
      rowWords(
        [
          field("tags", "multi_select", "core", [
            ["a", "Glazed"],
            ["b", "Matte"],
          ]),
        ],
        { tags: ["a", "b"] },
        SAY,
      ),
    ).toEqual(["Glazed, Matte"]);
  });
});

describe("asking for the interview in words", () => {
  it("starts it for a plain request", () => {
    for (const said of [
      "do the interview with me",
      "Let's do the interview",
      "start the interview",
      "Please continue my interview here",
      "Can you do the interview with me?",
      "could we start the interview now",
      "I'd like to do the interview with you",
      "I want to finish the interview",
      "interview me",
      "Ask me the questions",
      "ok, let’s do the interview",
    ]) {
      expect(asksForInterview(said), said).toBe(true);
    }
  });

  it("leaves a question about the interview, or a request for another time or place, to Lex", () => {
    for (const said of [
      "How do I do the interview?",
      "how long does the interview take",
      "Where is the interview?",
      "What is the interview for?",
      "Do I have to do the interview?",
      "Should I start the interview now?",
      "Can we do the interview later?",
      "start the interview on the form",
      "I did the interview yesterday",
      "what did I say in the interview",
      "",
      `do the interview ${"and tell me everything about my margins ".repeat(4)}`,
    ]) {
      expect(asksForInterview(said), said).toBe(false);
    }
  });
});

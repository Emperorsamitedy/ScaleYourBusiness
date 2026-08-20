#!/usr/bin/env python3
"""
Validates the question bank.

Usage:
    python scripts/lint_bank.py                       # defaults to specs/question-bank-v1.json
    python scripts/lint_bank.py path/to/bank.json

Exits 0 when clean, 1 when any issue is found. Safe to run in CI.
"""
import json
import sys
import collections
from pathlib import Path

DEFAULT = Path("specs/question-bank-v1.json")


def load(path: Path):
    if not path.exists():
        print(f"ERROR: bank not found at {path}", file=sys.stderr)
        sys.exit(1)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"ERROR: invalid JSON in {path}: {exc}", file=sys.stderr)
        sys.exit(1)


def cond_fields(cond, acc):
    """Collect every field path referenced anywhere in a condition tree."""
    if not cond:
        return acc
    if "terms" in cond:
        for t in cond["terms"]:
            cond_fields(t, acc)
    elif "term" in cond:
        cond_fields(cond["term"], acc)
    elif "field" in cond:
        acc.append(cond["field"])
    return acc


def lint(bank):
    questions = bank["questions"]
    schemas = bank["entity_schemas"]
    vocabs = bank["vocabularies"]
    issues = collections.defaultdict(list)

    question_ids = {q["id"] for q in questions}

    # everything a question or entity field can write to
    written = {q["writes_to"] for q in questions}
    for name, schema in schemas.items():
        for f in schema["fields"]:
            written.add(f"{name}.{f['key']}")

    # duplicate ids
    for qid, count in collections.Counter(q["id"] for q in questions).items():
        if count > 1:
            issues["duplicate_question_id"].append(f"{qid} appears {count} times")

    def check_input(spec, label):
        kind = spec.get("type")
        if kind in ("single_select", "multi_select"):
            vid = spec.get("vocabulary_id")
            if not vid:
                issues["select_without_vocabulary"].append(label)
            elif not vid.startswith("__") and vid not in vocabs:
                issues["missing_vocabulary"].append(f"{label} -> {vid}")
        if kind == "entity_list":
            es = spec.get("entity_schema")
            if not es:
                issues["entity_list_without_schema"].append(label)
            elif es not in schemas:
                issues["missing_entity_schema"].append(f"{label} -> {es}")

    for q in questions:
        label = q["id"]

        for field in cond_fields(q.get("condition"), []):
            base = field.replace(".length", "")
            if base not in written and not any(
                w.startswith(base) or base.startswith(w) for w in written
            ):
                issues["dangling_condition_reference"].append(f"{label} -> {field}")

        for unlocked in q.get("unlocks", []):
            if unlocked not in question_ids:
                issues["unlocks_missing_question"].append(f"{label} -> {unlocked}")

        check_input(q["input"], label)

        prompt = q.get("prompt")
        if not isinstance(prompt, dict) or not prompt.get("en"):
            issues["missing_english_prompt"].append(label)

    # entity schema fields get the same input checks
    for name, schema in schemas.items():
        for f in schema["fields"]:
            check_input(f["input"], f"{name}.{f['key']}")

    return issues, questions, vocabs, schemas


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    bank = load(path)
    issues, questions, vocabs, schemas = lint(bank)

    if issues:
        total = sum(len(v) for v in issues.values())
        print(f"FAIL - {total} issue(s) in {path}\n")
        for kind, items in sorted(issues.items()):
            print(f"  {kind}: {len(items)}")
            for item in items:
                print(f"      {item}")
        sys.exit(1)

    tiers = collections.Counter(q["priority"] for q in questions)
    always_core = sum(
        1 for q in questions if q["priority"] == "core" and q.get("condition") is None
    )
    print(f"OK - {path}")
    print(
        f"   {len(questions)} questions | {len(vocabs)} vocabularies | "
        f"{len(schemas)} entity schemas"
    )
    print(
        f"   core {tiers['core']} ({always_core} always asked) | "
        f"important {tiers['important']} | deep {tiers['deep']}"
    )
    sys.exit(0)


if __name__ == "__main__":
    main()

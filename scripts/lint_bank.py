#!/usr/bin/env python3
"""
Validates the question bank.

Usage:
    python scripts/lint_bank.py                       # defaults to specs/question-bank-v1.json
    python scripts/lint_bank.py path/to/bank.json
    python scripts/lint_bank.py bank.json --glossary g.json --locales de-DE,fr-FR --require-overlays

Exits 0 when clean, 1 when any issue is found. Safe to run in CI.

Language overlays (L-2 of TASKS-LANGUAGES.md) sit beside the bank as
<bank stem>.<locale>.json (specs/question-bank-v1.de-DE.json) and hold
only words, keyed by the bank's own ids. Every overlay found beside a bank
is linted with it; the default bank must have one for every language in
lib/i18n/locales.ts (--require-overlays says the same for another path).
"""
import json
import re
import sys
import collections
from pathlib import Path

DEFAULT = Path("specs/question-bank-v1.json")
DEFAULT_GLOSSARY = Path("specs/glossary-v1.json")
LOCALES_TS = Path("lib/i18n/locales.ts")

# A prompt opening with an auxiliary verb reads as yes/no.
YES_NO_PROMPT = re.compile(
    r"^(do|does|did|is|are|was|were|have|has|had|can|could|will|would|should)\b",
    re.IGNORECASE,
)

# Inputs with no way to express "no". A yes/no prompt on one of these is a
# trap: the owner reads a yes/no question and is handed a number box.
# Found live — "Do you know your gross profit margin?" took a percentage,
# so answering "no" was rejected outright; and "Does the business carry
# debt or financing?" had no way to say "none" short of typing 0.
# text/long_text are excluded: they absorb a written "no" harmlessly.
# multi_select is handled separately — it is fine when it offers a "none".
VALUE_ONLY_INPUTS = {"number", "money", "date", "percent"}
NONE_LIKE = {"none", "none_yet", "no", "nothing", "not_applicable"}


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
        # option_labels: the owner's words for a select's codes ("solo" reads
        # "Just me"). Each key must be a code of the question's own static
        # vocabulary, and each label needs English, or the intake would
        # print a label for an option that cannot be chosen.
        labels = spec.get("option_labels")
        if labels is not None:
            vid = spec.get("vocabulary_id")
            if kind not in ("single_select", "multi_select") or not isinstance(labels, dict):
                issues["option_labels_on_non_select"].append(label)
            elif not vid or vid.startswith("__") or vid not in vocabs:
                issues["option_labels_without_static_vocabulary"].append(label)
            else:
                codes = set(vocabs[vid])
                for code, text in labels.items():
                    if code not in codes:
                        issues["option_label_for_unknown_code"].append(f"{label} -> {code}")
                    elif not isinstance(text, dict) or not str(text.get("en", "")).strip():
                        issues["option_label_missing_english"].append(f"{label} -> {code}")
        if kind == "entity_list":
            es = spec.get("entity_schema")
            if not es:
                issues["entity_list_without_schema"].append(label)
            elif es not in schemas:
                issues["missing_entity_schema"].append(f"{label} -> {es}")

    def check_prompt_matches_input(prompt_en, spec, label):
        """A question phrased as yes/no must be answerable with "no"."""
        if not YES_NO_PROMPT.match(prompt_en.strip()):
            return
        kind = spec.get("type")
        if kind in VALUE_ONLY_INPUTS:
            issues["yes_no_prompt_wants_a_value"].append(f"{label}: {prompt_en}")
        elif kind == "multi_select":
            vid = spec.get("vocabulary_id")
            options = vocabs.get(vid) or []
            codes = {o if isinstance(o, str) else o.get("code") for o in options}
            if not codes & NONE_LIKE:
                issues["yes_no_prompt_multi_select_without_none"].append(
                    f"{label}: {prompt_en}"
                )

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
        else:
            check_prompt_matches_input(prompt["en"], q["input"], label)

    # entity schema fields get the same input checks
    for name, schema in schemas.items():
        for f in schema["fields"]:
            check_input(f["input"], f"{name}.{f['key']}")

    return issues, questions, vocabs, schemas


# ── language overlays (L-2) ──────────────────────────────────────────────

# Words that are the same in every language: names and acronyms, not
# English. An overlay string may equal the English one only when every word
# of it is one of these, or when the overlay lists the key in its own
# "same_as_english" with the reason (a cognate: German "Software").
SHARED_WORDS = {
    "SYB", "Shopify", "WooCommerce", "WordPress", "Webflow", "Wix", "Squarespace",
    "Amazon", "Etsy", "eBay", "Ebay", "TikTok", "Tiktok", "Instagram", "Facebook",
    "YouTube", "Youtube", "Google", "LinkedIn", "Linkedin", "Pinterest", "WhatsApp",
    "Whatsapp", "Messenger", "Stripe", "PayPal", "Paypal", "Square", "Adyen", "Mollie",
    "Klarna", "Apple", "Meta", "Fresha", "Treatwell", "Booksy", "Woocommerce",
    "Wordpress", "SEO", "Seo", "CRM", "Crm", "ERP", "Erp", "SaaS", "Saas", "MVP", "Mvp",
    "B2B", "B2b", "B2C", "B2c", "POS", "SOP", "SOPs", "Sops", "AI",
}

# What a translation carries over from English exactly: digit runs (13
# weeks, 20:00–01:00, the 25 of "one in four"), the percent sign, any
# {placeholder}, any currency sign. Figures are the bank's, never the
# translator's (rule 3 of TASKS-LANGUAGES.md).
DIGITS = re.compile(r"\d+")
PLACEHOLDER = re.compile(r"\{[^{}]*\}")
CURRENCY_SIGN = re.compile(r"[€$£¥₽₹₩]")

# A letter, as Python's re spells \p{L}: a word character that is not a digit or "_".
LETTER = r"[^\W\d_]"

OVERLAY_KEYS = {
    "about",
    "locale",
    "bank_version",
    "questions",
    "entity_schemas",
    "vocabularies",
    "same_as_english",
    "glossary_exceptions",
}


def humanize(code):
    """The intake's own English for a bare code (lib/intake/service.ts humanizeCode)."""
    words = code.replace("_", " ").strip()
    return words[:1].upper() + words[1:]


def translatable(bank):
    """Every string of the bank a person reads, keyed by the bank's own ids.

    questions/<id>/prompt, questions/<id>/help_text,
    questions/<id>/option_labels/<code>, entity_schemas/<name>/label,
    entity_schemas/<name>/fields/<key>, vocabularies/<id>/<code>. A
    vocabulary option's English is its humanised code, as the intake prints
    it; a question's option_labels (its own words) are keyed under it.
    """
    out = {}
    for q in bank["questions"]:
        qid = q["id"]
        out[f"questions/{qid}/prompt"] = q["prompt"]["en"]
        if isinstance(q.get("help_text"), dict) and q["help_text"].get("en"):
            out[f"questions/{qid}/help_text"] = q["help_text"]["en"]
        for code, text in (q["input"].get("option_labels") or {}).items():
            out[f"questions/{qid}/option_labels/{code}"] = text["en"]
    for name, schema in bank["entity_schemas"].items():
        out[f"entity_schemas/{name}/label"] = schema["label"]["en"]
        for f in schema["fields"]:
            out[f"entity_schemas/{name}/fields/{f['key']}"] = f["prompt"]["en"]
    for vid, codes in bank["vocabularies"].items():
        for code in codes:
            out[f"vocabularies/{vid}/{code}"] = humanize(code)
    return out


def flatten_overlay(overlay, issues, label):
    """An overlay's words in translatable()'s key space; anything that isn't a string is structure."""
    out = {}

    def put(key, value):
        if isinstance(value, str):
            out[key] = value
        else:
            issues["overlay_not_words"].append(f"{label}: {key} is not a string")

    for qid, entry in (overlay.get("questions") or {}).items():
        if not isinstance(entry, dict):
            issues["overlay_not_words"].append(f"{label}: questions/{qid}")
            continue
        for part, value in entry.items():
            if part == "option_labels" and isinstance(value, dict):
                for code, text in value.items():
                    put(f"questions/{qid}/option_labels/{code}", text)
            else:
                put(f"questions/{qid}/{part}", value)
    for name, entry in (overlay.get("entity_schemas") or {}).items():
        if not isinstance(entry, dict):
            issues["overlay_not_words"].append(f"{label}: entity_schemas/{name}")
            continue
        for part, value in entry.items():
            if part == "fields" and isinstance(value, dict):
                for key, text in value.items():
                    put(f"entity_schemas/{name}/fields/{key}", text)
            else:
                put(f"entity_schemas/{name}/{part}", value)
    for vid, entry in (overlay.get("vocabularies") or {}).items():
        if not isinstance(entry, dict):
            issues["overlay_not_words"].append(f"{label}: vocabularies/{vid}")
            continue
        for code, text in entry.items():
            put(f"vocabularies/{vid}/{code}", text)
    return out


def uses_term(text, forms):
    """messages/catalogue.test.ts usesTerm: a whole word, any case, a plural ending allowed."""
    for f in forms:
        if re.search(rf"(?<!{LETTER}){re.escape(f)}(?:s|es)?(?!{LETTER})", text, re.IGNORECASE):
            return True
    return False


def shared_only(text):
    """True when every word of a string is a name or an acronym (SHARED_WORDS), or it has none."""
    words = [w.strip(".,;:!?()[]«»“”\"'’-–—/") for w in text.split()]
    words = [w for w in words if re.search(LETTER, w)]
    return all(w in SHARED_WORDS for w in words)


CJK = r"[㐀-䶿一-鿿]"


def typography(locale, text):
    """The register's typography (specs/glossary-v1.json registers), as the L-1 catalogues keep it.

    French: a narrow no-break space (U+202F) before ? ! ; and a no-break
    space (U+00A0 or U+202F) before a colon that isn't inside a time.
    Chinese: full-width punctuation after Chinese text, and a space between
    Chinese and Latin letters or digits.
    """
    problems = []
    if locale == "fr-FR":
        if re.search(r"[^ ][?!;]", text):
            problems.append("needs U+202F before ? ! ;")
        for m in re.finditer(":", text):
            before = text[m.start() - 1] if m.start() > 0 else ""
            after = text[m.end()] if m.end() < len(text) else ""
            in_time = before.isdigit() and after.isdigit()
            if not in_time and before not in (" ", " "):
                problems.append("needs U+00A0 before :")
                break
    elif locale == "zh-Hans":
        if re.search(rf"{CJK}[,.?!;:()]", text):
            problems.append("half-width punctuation after Chinese text")
        if re.search(rf"{CJK}[A-Za-z0-9]|[A-Za-z0-9]{CJK}", text):
            problems.append("no space between Chinese and Latin text or a number")
    return problems


def lint_overlay(english, overlay, locale, bank_version, glossary, issues):
    """One overlay against the bank's English: coverage, figures, sameness, the glossary."""
    label = locale
    if overlay.get("locale") != locale:
        issues["overlay_locale_mismatch"].append(f"{label}: file says {overlay.get('locale')!r}")
    if overlay.get("bank_version") != bank_version:
        issues["overlay_bank_version_mismatch"].append(
            f"{label}: overlay {overlay.get('bank_version')!r}, bank {bank_version!r}"
        )
    for key in overlay:
        if key not in OVERLAY_KEYS:
            issues["overlay_not_words"].append(f"{label}: top-level {key!r}")

    words = flatten_overlay(overlay, issues, label)
    for key in english:
        if key not in words:
            issues["overlay_missing_string"].append(f"{label}: {key}")
    for key in words:
        if key not in english:
            issues["overlay_unknown_id"].append(f"{label}: {key}")

    same = overlay.get("same_as_english") or {}
    for key, reason in same.items():
        if key not in english or not str(reason).strip():
            issues["overlay_same_as_english_stale"].append(f"{label}: {key}")
        elif words.get(key) != english[key]:
            issues["overlay_same_as_english_stale"].append(
                f"{label}: {key} is listed as English's own words but differs"
            )

    exceptions = overlay.get("glossary_exceptions") or {}
    terms = {t["id"]: t for t in glossary.get("terms", [])}
    for key, by_term in exceptions.items():
        if key not in english or not isinstance(by_term, dict):
            issues["overlay_glossary_exception_stale"].append(f"{label}: {key}")
            continue
        for term_id, reason in by_term.items():
            term = terms.get(term_id)
            if term is None or not str(reason).strip():
                issues["overlay_glossary_exception_stale"].append(f"{label}: {key} {term_id}")
            elif not uses_term(english[key], term["en"]["match"]):
                issues["overlay_glossary_exception_stale"].append(
                    f"{label}: {key}: English does not use {term_id!r}"
                )

    for key, en in english.items():
        text = words.get(key)
        if text is None:
            continue
        if text.strip() == "":
            issues["overlay_empty_string"].append(f"{label}: {key}")
            continue
        if text != text.strip():
            issues["overlay_untrimmed_string"].append(f"{label}: {key}")
        for problem in typography(locale, text):
            issues["overlay_typography"].append(f"{label}: {key}: {problem}: {text}")
        if sorted(PLACEHOLDER.findall(text)) != sorted(PLACEHOLDER.findall(en)):
            issues["overlay_placeholder_mismatch"].append(f"{label}: {key}: {text}")
        if sorted(DIGITS.findall(text)) != sorted(DIGITS.findall(en)) or (
            text.count("%") != en.count("%")
        ):
            issues["overlay_figure_mismatch"].append(f"{label}: {key}: {en!r} -> {text!r}")
        if sorted(CURRENCY_SIGN.findall(text)) != sorted(CURRENCY_SIGN.findall(en)):
            issues["overlay_currency_sign"].append(f"{label}: {key}: {text}")
        if text == en and not shared_only(en) and key not in same:
            issues["overlay_same_as_english"].append(f"{label}: {key}: {text}")
        for term in glossary.get("terms", []):
            if not uses_term(en, term["en"]["match"]):
                continue
            if term["id"] in (exceptions.get(key) or {}):
                continue
            row = term.get(locale) or {}
            stems = [s.lower() for s in row.get("stems", [])]
            if stems and not any(s in text.lower() for s in stems):
                issues["overlay_glossary_term"].append(
                    f"{label}: {key}: \"{term['en']['term']}\" needs "
                    f"{' | '.join(row['stems'])}: {text}"
                )


def app_locales(path=LOCALES_TS):
    """The languages the app speaks, read from lib/i18n/locales.ts (the one list)."""
    if not path.exists():
        return []
    m = re.search(r"export const LOCALES = \[([^\]]*)\]", path.read_text(encoding="utf-8"))
    return re.findall(r'"([^"]+)"', m.group(1)) if m else []


def overlay_paths(bank_path):
    """Overlays beside a bank, <stem>.<locale>.json, by locale."""
    found = {}
    for p in sorted(bank_path.parent.glob(f"{bank_path.stem}.*.json")):
        locale = p.name[len(bank_path.stem) + 1 : -len(".json")]
        if locale and "." not in locale:
            found[locale] = p
    return found


def lint_overlays(bank, bank_path, glossary, locales, require, issues):
    english = translatable(bank)
    found = overlay_paths(bank_path)
    wanted = [l for l in locales if l != "en"]
    for locale, p in found.items():
        if locale not in wanted:
            issues["overlay_unknown_locale"].append(p.name)
    if require:
        for locale in wanted:
            if locale not in found:
                issues["overlay_missing_locale"].append(locale)
    linted = []
    for locale, p in found.items():
        if locale not in wanted:
            continue
        try:
            overlay = json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            issues["overlay_invalid_json"].append(f"{p.name}: {exc}")
            continue
        lint_overlay(english, overlay, locale, bank["bank_version"], glossary, issues)
        linted.append(locale)
    return english, linted


def parse_args(argv):
    args = {"bank": DEFAULT, "glossary": DEFAULT_GLOSSARY, "locales": None, "require": None}
    rest = list(argv)
    while rest:
        a = rest.pop(0)
        if a == "--glossary" and rest:
            args["glossary"] = Path(rest.pop(0))
        elif a == "--locales" and rest:
            args["locales"] = [l for l in rest.pop(0).split(",") if l]
        elif a == "--require-overlays":
            args["require"] = True
        else:
            args["bank"] = Path(a)
    if args["require"] is None:
        # The real bank must speak every language; a scratch bank may speak only English.
        args["require"] = args["bank"].resolve() == DEFAULT.resolve()
    if args["locales"] is None:
        args["locales"] = app_locales()
    return args


def main():
    args = parse_args(sys.argv[1:])
    path = args["bank"]
    bank = load(path)
    issues, questions, vocabs, schemas = lint(bank)
    glossary = (
        json.loads(args["glossary"].read_text(encoding="utf-8"))
        if args["glossary"].exists()
        else {"terms": []}
    )
    english, linted = lint_overlays(
        bank, path, glossary, args["locales"], args["require"], issues
    )

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
    print(
        f"   {len(english)} strings to translate | overlays: "
        f"{', '.join(sorted(linted)) or 'none'}"
    )
    sys.exit(0)


if __name__ == "__main__":
    main()

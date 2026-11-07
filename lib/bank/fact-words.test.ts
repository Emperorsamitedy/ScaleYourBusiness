// L-3a: a recorded fact named in the person's language from the bank's
// overlay — and English left exactly as the screens always printed it.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { entityTextValue, factWords, labelFactMap } from "./fact-words";
import type { OverlayWords } from "./words";
import { ENGLISH_WORDS, bankWords } from "./words";
import { factLabel, factValue } from "../../components/intake/record";
import type { RecordFact } from "../intake/types";

const overlay = (l: string) =>
  JSON.parse(
    readFileSync(join(process.cwd(), "specs", `question-bank-v1.${l}.json`), "utf8"),
  ) as OverlayWords;
const DE = factWords(bankWords("de-DE", overlay("de-DE")));
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("factWords", () => {
  it("English keeps the key's own words, naming only codes that read badly", () => {
    const en = factWords(ENGLISH_WORDS);
    expect(en.label("revenue.monthly_revenue")).toBeNull();
    expect(en.value("identity.business_type", { code: "salon_beauty" })).toBe(
      "Hair or beauty salon",
    );
    expect(en.value("identity.business_type", { code: "restaurant" })).toBeNull();
    const map = { "a.b": { value: "x" } };
    expect(labelFactMap(map, en)).toBe(map);
    expect(labelFactMap({ "identity.business_type": { value: "ecommerce store" } }, en)).toEqual({
      "identity.business_type": { value: "ecommerce store", value_words: "Online shop" },
    });
  });

  it("labels a fact by its question's prompt, and an entity field by its own", () => {
    const de = overlay("de-DE");
    expect(DE.label("identity.legal_name")).toBe(de.questions?.["1.1"]?.prompt);
    expect(DE.label(`offers.${ID}.price`, "Becher")).toBe(
      `Becher · ${de.entity_schemas?.offer?.fields?.price}`,
    );
    expect(DE.label(`offers.${ID}.price`)).toBe(
      `${de.entity_schemas?.offer?.label} · ${de.entity_schemas?.offer?.fields?.price}`,
    );
    expect(DE.label("connector.only.key")).toBeNull();
  });

  it("words a coded value, and never owner text", () => {
    const words = overlay("de-DE").vocabularies?.business_size ?? {};
    const own = overlay("de-DE").questions?.["1.6a"]?.option_labels?.solo;
    expect(DE.value("identity.size_band", "solo")).toBe(own ?? words.solo);
    expect(DE.value("identity.legal_name", "Acme Kft")).toBeNull();
    expect(DE.textValue("identity.legal_name", "acme")).toBeNull();
    expect(DE.value("identity.size_band", "not_a_code")).toBeNull();
    // A multi-select is stored as [{ code }, …].
    const sells = overlay("de-DE").vocabularies?.sells_type?.physical_products;
    expect(DE.value("identity.sells", [{ code: "physical_products" }])).toBe(sells);
  });

  it("reads a humanised code back to its words, and an entity field by spine", () => {
    const kind = overlay("de-DE").vocabularies?.offer_kind?.physical;
    expect(entityTextValue(DE, "offers", "kind", "physical")).toBe(kind);
    expect(DE.field("offers", "price")).toBe(overlay("de-DE").entity_schemas?.offer?.fields?.price);
  });
});

describe("the record panel in another language", () => {
  const fact = (over: Partial<RecordFact>): RecordFact => ({
    key: "identity.founded",
    entity: null,
    field: "identity.founded",
    value: "2019-03-01",
    text: "2019-03-01",
    status: "answered",
    source_kind: "owner_input",
    provider: null,
    note: null,
    confidence: 1,
    observed_at: "2026-10-01",
    recorded_at: "2026-10-01",
    method: null,
    question_id: null,
    ...over,
  });

  it("prints the server's label, the option's words, a date and a count in the language", () => {
    const tr = (k: string, v?: Record<string, string | number>) => `${k}:${v?.count ?? ""}`;
    expect(factLabel(fact({ label: "Gründung" }))).toBe("Gründung");
    expect(factValue(fact({}), tr, "de-DE").text).toBe("1. März 2019");
    expect(factValue(fact({ value: "b2c", text: "b2c", value_words: "Privatkunden" })).text).toBe(
      "Privatkunden",
    );
    expect(factValue(fact({ value: { entity_ids: ["a", "b"] } }), tr, "de-DE").text).toBe(
      "fact.entityCount:2",
    );
    // English: the stored text, exactly as before.
    expect(factValue(fact({})).text).toBe("2019-03-01");
    expect(factValue(fact({ value: { entity_ids: ["a"] }, text: "1 on file" })).text).toBe(
      "1 on file",
    );
  });
});

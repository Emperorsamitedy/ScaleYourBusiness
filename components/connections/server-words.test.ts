// L-4c: what the server says on /connections (a refusal, a stored last
// error) in the reader's language — said again only when it is one of
// SYB's own sentences, byte for byte; anything else shown as it came.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localeTr } from "../../lib/i18n/request-tr";
import { englishTr } from "../../lib/i18n/tr";
import { CONNECTIONS_WORDS, parseServer, sayServer } from "./server-words";

const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

describe("connectionsWords English is the code's own", () => {
  it("holds the stored sentences to the code that writes them", () => {
    const en = englishTr(CONNECTIONS_WORDS);
    expect(en("said.route.notFound")).toBe("connection not found");
    expect(source("lib/connectors/service.ts")).toContain('"connection not found"');
    // Every provider writes the same network-failure sentence.
    expect(en("said.source.netFailure", { provider: "shopify", attempts: 3 })).toBe(
      "shopify: network failure after 3 attempts",
    );
    expect(source("lib/connectors/providers/shopify.ts")).toContain(
      "`shopify: network failure after ${attempt} attempts`",
    );
  });

  it("leaves English exactly as it came", () => {
    const en = englishTr(CONNECTIONS_WORDS);
    const stored = "ProviderError: shopify: network failure after 3 attempts";
    expect(sayServer(stored, en, "en")).toBe(stored);
    expect(parseServer("shopify: network failure after 3 attempts")).toEqual({
      key: "said.source.netFailure",
      values: { provider: "shopify", attempts: 3 },
    });
  });
});

describe("connectionsWords in other languages", () => {
  it("says a known last error in German, and shows a provider's own words as stored", async () => {
    const de = await localeTr("de-DE", CONNECTIONS_WORDS);
    expect(sayServer("connection not found", de, "de-DE")).toBe("Verbindung nicht gefunden");
    expect(sayServer("ProviderError: shopify: network failure after 3 attempts", de, "de-DE")).toBe(
      "Shopify: Netzwerkfehler nach 3 Versuchen",
    );
    const foreign = "Shopify says: Invalid API key or access token (unrecognized login)";
    expect(sayServer(foreign, de, "de-DE")).toBe(foreign);
    // An older or altered wording isn't SYB's sentence any more: as stored.
    expect(sayServer("connection not found!", de, "de-DE")).toBe("connection not found!");
  });

  it("gives Russian its forms at 1, 3, 5 and 21", async () => {
    const ru = await localeTr("ru-RU", CONNECTIONS_WORDS);
    const say = (n: number) =>
      sayServer(`stripe: network failure after ${n} attempts`, ru, "ru-RU");
    expect(say(1)).toBe("Stripe: сбой сети после 1 попытки");
    expect(say(3)).toBe("Stripe: сбой сети после 3 попыток");
    expect(say(5)).toBe("Stripe: сбой сети после 5 попыток");
    expect(say(21)).toBe("Stripe: сбой сети после 21 попытки");
  });

  it("joins Chinese sentences with no space after full-width punctuation", async () => {
    const zh = await localeTr("zh-Hans", CONNECTIONS_WORDS);
    const out = sayServer(
      "That Facebook sign-in expired or was already used. Start again from Connections.",
      zh,
      "zh-Hans",
    );
    expect(out).toBe("这次 Facebook 登录已过期或已被使用。请从“连接”重新开始。");
    expect(out).not.toMatch(/[。，：] /);
  });
});

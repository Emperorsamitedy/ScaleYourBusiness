// I-50a: the microphone listens in the person's chosen language.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCALES } from "../i18n/locales";
import { SPEECH_LANG, speechLang } from "./lang";

const ROOT = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("speechLang", () => {
  it("gives every app language a recogniser tag", () => {
    expect(Object.keys(SPEECH_LANG).sort()).toEqual([...LOCALES].sort());
    for (const l of LOCALES) expect(speechLang(l)).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
  });

  it("keeps English as it listened before, and names each region", () => {
    expect(speechLang("en")).toBe("en-GB");
    expect(speechLang("es-ES")).toBe("es-ES");
    expect(speechLang("de-DE")).toBe("de-DE");
    expect(speechLang("fr-FR")).toBe("fr-FR");
    expect(speechLang("hu-HU")).toBe("hu-HU");
    expect(speechLang("ru-RU")).toBe("ru-RU");
  });

  it("names Simplified Chinese by its region, not its script", () => {
    expect(speechLang("zh-Hans")).toBe("zh-CN");
    expect(speechLang("zh-Hans")).not.toBe("zh-Hans");
  });
});

describe("where the microphone's language comes from", () => {
  it("MicButton listens in the request's locale through speechLang", () => {
    const src = read("components/voice/MicButton.tsx");
    expect(src).toContain('const { tr, locale } = useTr("voice");');
    expect(src).toContain("lang: speechLang(locale)");
  });

  it("the hook falls back to neither the browser's language nor a fixed en-GB", () => {
    const src = read("components/voice/useSpeechAnswer.ts");
    expect(src).not.toContain("navigator.language");
    expect(src).not.toContain('"en-GB"');
  });

  it("no box sets the microphone's language itself", () => {
    for (const rel of [
      "components/chat/Composer.tsx", // the conversation's box, on its page, on Home and in Lex's sheet
      "components/intake/controls/LongText.tsx",
      "components/intake/controls/Text.tsx",
      "components/support/ReplyBox.tsx",
    ]) {
      const src = read(rel);
      expect(src, rel).toContain("<MicButton");
      const tag = src.slice(
        src.indexOf("<MicButton"),
        src.indexOf("/>", src.indexOf("<MicButton")),
      );
      expect(tag, rel).not.toMatch(/\blang=/);
    }
  });
});

// L-4c: why a draft isn't proposed for publishing, as a code — in English
// exactly as publishReadiness always said it, and in the reader's language
// at presentation. The screen's "Connections" button follows a flag, not
// the English word.

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { localeTr } from "../i18n/request-tr";
import type { MetaAssets, ReadinessItem } from "./publish";
import { publishBlockOf, publishReadiness } from "./publish";
import type { PublishBlock } from "./publish-words";
import { CONTENT_WORDS, blockWords, opensConnections } from "./publish-words";

const DRAFT: ReadinessItem = {
  kind: "post",
  status: "drafted",
  channel_label: "facebook",
  scheduled_for: "2026-11-20",
  media_path: null,
  publish_proposal_id: null,
};
const ASSETS = { page_id: "pg", ig_user_id: null } as unknown as MetaAssets;
const args = (over: Partial<Parameters<typeof publishReadiness>[0]> = {}) => ({
  item: DRAFT,
  platform: "facebook",
  assets: ASSETS,
  zone: "Europe/Budapest",
  ...over,
});

describe("contentWords English is what publishReadiness said before L-4c", () => {
  it("words every refusal byte for byte", () => {
    const say = (b: PublishBlock) => blockWords(b);
    expect(say({ code: "proposed" })).toBe("already proposed for publishing");
    expect(say({ code: "notDraft", values: { status: "published" } })).toBe(
      "it is published, not a draft",
    );
    expect(say({ code: "kind", values: { kind: "banner" } })).toBe("a banner isn't published");
    expect(say({ code: "channel", values: { channel: "tiktok" } })).toBe(
      "SYB can't publish to tiktok — only to a Facebook Page or Instagram account you connect",
    );
    expect(say({ code: "connect", values: { platform: "Facebook" } })).toBe(
      "connect Meta publishing on Connections to publish this to Facebook",
    );
    expect(say({ code: "zone", values: { reason: "the business's timezone isn't known" } })).toBe(
      "the posting time can't be set: the business's timezone isn't known",
    );
    expect(say({ code: "declined", values: { count: 3 } })).toBe(
      "you've declined publishing 3 times — I've stopped proposing it",
    );
    expect(say({ code: "passed", values: { date: "2026-10-15" } })).toBe(
      "its date (2026-10-15) has passed",
    );
  });

  it("gives the reason and the code from the same check", () => {
    const a = args({ assets: null });
    const r = publishReadiness(a);
    const block = publishBlockOf(a);
    expect(r).toEqual({
      ok: false,
      reason: "connect Meta publishing on Connections to publish this to Facebook",
    });
    expect(block).toEqual({ code: "connect", values: { platform: "Facebook" } });
    expect(block && opensConnections(block)).toBe(true);
    expect(publishBlockOf(args())).toBeNull();
    // Only connecting Meta publishing sends the owner to Connections.
    const noIg = publishBlockOf(args({ platform: "instagram" }));
    expect(noIg?.code).toBe("noInstagram");
    expect(noIg && opensConnections(noIg)).toBe(false);
  });
});

describe("contentWords in other languages", () => {
  it("says a refusal in German, the status and the date its way", async () => {
    const de = await localeTr("de-DE", CONTENT_WORDS);
    expect(blockWords({ code: "connect", values: { platform: "Facebook" } }, de, "de-DE")).toBe(
      "richten Sie unter Verbindungen das Veröffentlichen über Meta ein, um dies auf Facebook zu veröffentlichen",
    );
    expect(blockWords({ code: "notDraft", values: { status: "failed" } }, de, "de-DE")).toBe(
      "der Status ist „fehlgeschlagen“, kein Entwurf",
    );
    expect(
      blockWords({ code: "zone", values: { reason: "the country isn't known" } }, de, "de-DE"),
    ).toBe(
      "die Uhrzeit der Veröffentlichung lässt sich nicht festlegen: das Land ist nicht bekannt",
    );
    // A reason SYB doesn't word is shown as it came.
    expect(blockWords({ code: "zone", values: { reason: "XYZ" } }, de, "de-DE")).toBe(
      "die Uhrzeit der Veröffentlichung lässt sich nicht festlegen: XYZ",
    );
    expect(blockWords({ code: "passed", values: { date: "2026-10-15" } }, de, "de-DE")).toMatch(
      /^sein Datum \(15\. Okt(\.|ober) 2026\) ist vorbei$/,
    );
  });

  it("gives Russian its forms at 1, 3, 5 and 21", async () => {
    const ru = await localeTr("ru-RU", CONTENT_WORDS);
    const n = (count: number) =>
      blockWords({ code: "declined", values: { count } }, ru, "ru-RU").split(" — ")[0];
    expect(n(1)).toBe("вы отклонили публикацию 1 раз");
    expect(n(3)).toBe("вы отклонили публикацию 3 раза");
    expect(n(5)).toBe("вы отклонили публикацию 5 раз");
    expect(n(21)).toBe("вы отклонили публикацию 21 раз");
  });

  it("writes Chinese with full-width punctuation and spaces only around Latin text", async () => {
    const zh = await localeTr("zh-Hans", CONTENT_WORDS);
    expect(blockWords({ code: "connect", values: { platform: "Instagram" } }, zh, "zh-Hans")).toBe(
      "请在“连接”中开通 Meta 发布，才能将此内容发布到 Instagram",
    );
    expect(
      blockWords({ code: "zone", values: { reason: "no country given" } }, zh, "zh-Hans"),
    ).toBe("无法设定发布时间：未填写国家");
  });
});

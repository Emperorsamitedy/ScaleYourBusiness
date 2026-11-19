// A shot list's title becomes its video's (lib/content/media-item). Titles are
// stored, so the reader has to take both ways one has been written: with the
// long dash every title had until 2026-11-19, and with the colon they have
// since (docs/DASHBOARD-OVERHAUL.md, L7: no long dashes on a screen).
// (The module beside the function writes rows, so it loads the database's address.)

import "dotenv/config";
import { describe, expect, it } from "vitest";
import { videoTitle } from "./media-item";

describe("videoTitle", () => {
  it("reads a title written today", () => {
    expect(videoTitle({ kind: "shot_list", title: "Film for Instagram: Autumn menu" })).toBe(
      "Autumn menu: video",
    );
    expect(videoTitle({ kind: "shot_list", title: "Shot list: Speckled Everyday Mug" })).toBe(
      "Speckled Everyday Mug: video",
    );
  });

  it("reads a title written before the dashes went, the same way", () => {
    expect(videoTitle({ kind: "shot_list", title: "Film for Instagram — Autumn menu" })).toBe(
      "Autumn menu: video",
    );
    expect(videoTitle({ kind: "shot_list", title: "Shot list — Speckled Everyday Mug" })).toBe(
      "Speckled Everyday Mug: video",
    );
  });

  it("never takes a mark out of the subject itself", () => {
    // The channel's name holds neither a dash nor a colon; what follows may hold either.
    expect(
      videoTitle({ kind: "shot_list", title: "Film for Facebook Page: Mugs — the new glaze" }),
    ).toBe("Mugs — the new glaze: video");
    expect(videoTitle({ kind: "shot_list", title: "Film for TikTok — Mugs: the new glaze" })).toBe(
      "Mugs: the new glaze: video",
    );
  });

  it("names a post's video in brackets, and leaves a plain title alone", () => {
    expect(videoTitle({ kind: "post", title: "Winter glazes" })).toBe("Winter glazes (video)");
    expect(videoTitle({ kind: "shot_list", title: "Winter glazes" })).toBe("Winter glazes: video");
  });
});

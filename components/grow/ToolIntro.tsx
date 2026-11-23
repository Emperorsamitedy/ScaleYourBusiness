"use client";

// Under every Grow tool's heading (2026-11-23): what the tool does for the
// owner, in one line, and how it works, in three steps, so a first visit is
// never a page to decode. The words are the catalogue's (grow.tools.<tool>),
// the same line its card on Grow's front page carries.

import { useTranslations } from "next-intl";
import type { GrowTool } from "./grow-tools";
import "../../app/grow.css";

const STEPS = ["s1", "s2", "s3"] as const;

export function ToolIntro({ tool }: { tool: GrowTool }) {
  const t = useTranslations("grow");
  return (
    <section className="gw-intro" aria-label={t("how")}>
      <p className="gw-line">{t(`tools.${tool}.line`)}</p>
      <ol className="gw-steps">
        {STEPS.map((s, i) => (
          <li key={s}>
            <span className="gw-n" aria-hidden="true">
              {i + 1}
            </span>
            <span>{t(`tools.${tool}.${s}`)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

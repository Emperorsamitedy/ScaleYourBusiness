"use client";

// The keyboard (docs/DASHBOARD-OVERHAUL.md B5). The rules are pure
// (shortcuts-model.ts); this listens, acts, and holds the sheet that lists
// them. Escape is not here: every overlay closes itself
// (components/ui/overlay.ts).

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Kbd } from "../ui/Kbd";
import { overlayOpen } from "../ui/overlay";
import { Sheet } from "../ui/Sheet";
import { useLex } from "./NavContext";
import { NAVIGATE } from "./RouteProgress";
import { IDLE_KEYS, isTyping, keyStep } from "./shortcuts-model";

function Row({ keys, then, children }: { keys: string[]; then?: string; children: string }) {
  return (
    <div className="sk-row">
      <dt>
        {keys.map((k, i) => (
          <span key={k} className="sk-keys">
            {i > 0 && then && <span className="sk-then">{then}</span>}
            <Kbd>{k}</Kbd>
          </span>
        ))}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The sheet that lists every shortcut, the queue's own included. */
export function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("shortcuts");
  const nav = useTranslations("nav");
  const p = useTranslations("proposals");
  // ⌘ on a Mac, Ctrl elsewhere; known only in the browser.
  const [mac, setMac] = useState(false);
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), []);
  const then = t("then");
  const go = (screen: string) => t("go", { screen });
  return (
    <Sheet open={open} onClose={onClose} title={t("title")} width={440}>
      <p className="ui-label">{t("everywhere")}</p>
      <dl className="sk-list">
        <Row keys={[mac ? "⌘" : "Ctrl", "K"]}>{t("palette")}</Row>
        <Row keys={["/"]}>{nav("ask")}</Row>
        <Row keys={["G", "H"]} then={then}>
          {go(nav("item.home"))}
        </Row>
        <Row keys={["G", "W"]} then={then}>
          {go(nav("item.proposals"))}
        </Row>
        <Row keys={["G", "R"]} then={then}>
          {go(nav("item.report"))}
        </Row>
        <Row keys={["G", "C"]} then={then}>
          {go(nav("item.cash"))}
        </Row>
        <Row keys={["G", "F"]} then={then}>
          {go(nav("item.factsheet"))}
        </Row>
        <Row keys={["?"]}>{t("help")}</Row>
        <Row keys={["Esc"]}>{t("close")}</Row>
      </dl>
      <p className="ui-label">{nav("item.proposals")}</p>
      <dl className="sk-list">
        <Row keys={["J", "K"]}>{t("next")}</Row>
        <Row keys={["A"]}>{p("act.approve")}</Row>
        <Row keys={["R"]}>{p("decide.changes")}</Row>
        <Row keys={["D"]}>{p("decide.decline")}</Row>
      </dl>
    </Sheet>
  );
}

export function Shortcuts({
  onPalette,
  help,
  onHelp,
}: {
  /** Ctrl+K: open the palette, or close it when it is open. */
  onPalette: () => void;
  help: boolean;
  onHelp: (open: boolean) => void;
}) {
  const router = useRouter();
  const lex = useLex();
  const keys = useRef(IDLE_KEYS);
  // The latest handlers, so the listener is attached once.
  const act = useRef({ onPalette, onHelp, lex, router });
  act.current = { onPalette, onHelp, lex, router };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const step = keyStep(keys.current, {
        key: e.key,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        alt: e.altKey,
        typing: isTyping(e.target instanceof HTMLElement ? e.target : null),
        overlay: overlayOpen() || document.querySelector(".ui-menu") !== null,
        now: Date.now(),
      });
      keys.current = step.state;
      if (!step.action) return;
      e.preventDefault();
      const now = act.current;
      switch (step.action.kind) {
        case "palette":
          now.onPalette();
          break;
        case "ask":
          now.lex.open();
          break;
        case "help":
          now.onHelp(true);
          break;
        case "go":
          if (window.location.pathname !== step.action.href) {
            window.dispatchEvent(new Event(NAVIGATE));
            now.router.push(step.action.href);
          }
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return <ShortcutsHelp open={help} onClose={() => onHelp(false)} />;
}

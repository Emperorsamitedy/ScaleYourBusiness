"use client";

// The command palette (docs/DASHBOARD-OVERHAUL.md B1): Ctrl+K, or the
// search button in the strip. One field: type to jump to any screen this
// person's menu holds, to run one of the few global actions, or to hand
// the words to Lex as a question. With nothing typed it lists the screens
// visited last. The list's arithmetic is pure (palette-model.ts); this
// file is the combobox: the field keeps the focus, ↑ ↓ move the marked
// row, Enter opens it, Escape closes.

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import { useTranslations } from "next-intl";
import type { NavAccess } from "../../app/api/nav/route";
import { IconButton } from "../ui/IconButton";
import { Kbd } from "../ui/Kbd";
import { useOverlay } from "../ui/overlay";
import { useLex } from "./NavContext";
import type { PaletteItem, PaletteKind } from "./palette-model";
import { moveActive, paletteRows, pushRecent } from "./palette-model";
import { NAVIGATE } from "./RouteProgress";
import "../../app/ui.css";

const RECENT_KEY = "scalex.recent_screens";

function readRecent(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return []; // storage blocked or not JSON: no recents, nothing lost
  }
}

/** Notes that an owner screen was visited, for the palette's "Recent". */
export function rememberScreen(href: string): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(pushRecent(readRecent(), href)));
  } catch {
    /* storage blocked: the palette simply lists no recents */
  }
}

export interface PaletteScreen {
  href: string;
  /** In the reader's language. */
  label: string;
  group: string;
  /** The English name and group, so an English word still finds the screen. */
  keywords: string;
}

export function CommandPalette({
  open,
  onClose,
  path,
  screens,
  access,
  onHelp,
}: {
  open: boolean;
  onClose: () => void;
  path: string;
  screens: readonly PaletteScreen[];
  access: NavAccess | null;
  /** Opens the list of shortcuts. */
  onHelp: () => void;
}): ReactElement | null {
  const t = useTranslations("palette");
  const nav = useTranslations("nav");
  const common = useTranslations("common");
  const router = useRouter();
  const lex = useLex();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<string[]>([]);
  useOverlay(open && mounted, onClose, root);

  // Each opening starts clean, with the latest recents.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    setRecent(readRecent());
  }, [open]);

  const rows = useMemo(() => {
    const screenItems: PaletteItem[] = screens.map((s) => ({
      id: `screen:${s.href}`,
      kind: "screen",
      label: s.label,
      hint: s.group,
      href: s.href,
      keywords: s.keywords,
    }));
    const others = access?.businesses.filter((b) => !b.current) ?? [];
    const actions: PaletteItem[] = [
      { id: "action:ask", kind: "action", label: nav("ask") },
      ...others.map((b): PaletteItem => ({
        id: `action:switch:${b.account_id}`,
        kind: "action",
        label: t("switchTo", { name: b.name ?? nav("switchBusiness") }),
        keywords: nav("switchBusiness"),
      })),
      { id: "action:shortcuts", kind: "action", label: t("shortcuts") },
      { id: "action:signout", kind: "action", label: nav("signOut") },
    ];
    return paletteRows({
      query,
      screens: screenItems,
      actions,
      recent,
      current: path,
      ask: (question) => ({ id: "ask", kind: "ask", label: question }),
    });
  }, [screens, access, nav, t, query, recent, path]);

  // Keep the marked row inside the list as the list changes, and in view.
  const at = rows.length === 0 ? -1 : Math.min(active, rows.length - 1);
  useEffect(() => {
    if (at >= 0) document.getElementById(`${id}-${at}`)?.scrollIntoView({ block: "nearest" });
  }, [at, id]);

  if (!open || !mounted) return null;

  const go = (href: string) => {
    onClose();
    if (href !== window.location.pathname) {
      window.dispatchEvent(new Event(NAVIGATE));
      router.push(href);
    }
  };

  const run = (row: PaletteItem) => {
    if ((row.kind === "screen" || row.kind === "recent") && row.href) return go(row.href);
    if (row.kind === "ask") {
      onClose();
      return lex.open(row.label);
    }
    if (row.id === "action:ask") {
      onClose();
      return lex.open();
    }
    if (row.id === "action:shortcuts") {
      onClose();
      return onHelp();
    }
    if (row.id === "action:signout") {
      onClose();
      void fetch("/api/auth/logout", { method: "POST" })
        .catch(() => undefined)
        .then(() => router.push("/login"));
      return;
    }
    if (row.id.startsWith("action:switch:")) {
      // The same plain form post the rail's switcher makes (idea 52).
      const form = document.createElement("form");
      form.method = "post";
      form.action = "/api/auth/switch";
      const field = document.createElement("input");
      field.type = "hidden";
      field.name = "account_id";
      field.value = row.id.slice("action:switch:".length);
      form.append(field);
      document.body.append(form);
      form.submit();
    }
  };

  const heading: Record<PaletteKind, string> = {
    recent: t("group.recent"),
    screen: t("group.screens"),
    action: t("group.actions"),
    ask: nav("ask"),
  };

  return createPortal(
    <div className="ui-palette-layer">
      <div className="ui-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={root}
        className="ui-palette"
        role="dialog"
        aria-modal="true"
        aria-label={t("label")}
      >
        <div className="ui-palette-field">
          <Search size={18} strokeWidth={1.75} aria-hidden="true" />
          <input
            data-autofocus=""
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={at >= 0 ? `${id}-${at}` : undefined}
            aria-label={t("label")}
            placeholder={t("label")}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive(moveActive(rows.length, at, e.key === "ArrowDown" ? 1 : -1));
              } else if (e.key === "Home" && rows.length > 0) {
                e.preventDefault();
                setActive(0);
              } else if (e.key === "End" && rows.length > 0) {
                e.preventDefault();
                setActive(rows.length - 1);
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const row = rows[at];
                if (row) run(row);
              }
            }}
          />
          {/* A phone has no Escape key and no scrim to tap: the palette fills its screen. */}
          <IconButton label={common("close")} className="ui-palette-x" onClick={onClose}>
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </IconButton>
        </div>
        <div id={`${id}-list`} className="ui-palette-list" role="listbox" aria-label={t("label")}>
          {rows.length === 0 && <p className="ui-palette-empty">{t("empty")}</p>}
          {rows.map((row, i) => (
            <div key={row.id} role="presentation">
              {(i === 0 || rows[i - 1]?.kind !== row.kind) && (
                <p className="ui-palette-group" role="presentation">
                  {heading[row.kind]}
                </p>
              )}
              <div
                id={`${id}-${i}`}
                role="option"
                aria-selected={i === at}
                className={`ui-palette-row${i === at ? " on" : ""}`}
                onPointerMove={() => setActive(i)}
                onClick={() => run(row)}
              >
                <span className="ui-palette-label">
                  {row.kind === "ask" ? t("askLine", { question: row.label }) : row.label}
                </span>
                {row.hint && <span className="ui-palette-hint">{row.hint}</span>}
              </div>
            </div>
          ))}
        </div>
        <p className="ui-palette-foot" aria-hidden="true">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> {t("hint.move")}
          </span>
          <span>
            <Kbd>Enter</Kbd> {t("hint.open")}
          </span>
          <span>
            <Kbd>Esc</Kbd> {t("hint.close")}
          </span>
        </p>
      </div>
    </div>,
    document.body,
  );
}

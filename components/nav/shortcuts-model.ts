// The keyboard's rules (docs/DASHBOARD-OVERHAUL.md B5), pure so they are
// tested: Ctrl+K (or ⌘K) opens the palette from anywhere; `/` asks Lex;
// `g` then a letter goes to a main screen; `?` lists the shortcuts.
// Nothing but Ctrl+K fires while the focus is in a field, with a modifier
// held, or while an overlay is open. Escape is each overlay's own.

export type ShortcutAction =
  { kind: "palette" } | { kind: "ask" } | { kind: "help" } | { kind: "go"; href: string };

/** `g` then one of these. The letters are the screens' English initials. */
export const GO_KEYS: Readonly<Record<string, string>> = {
  h: "/home",
  w: "/proposals",
  r: "/report",
  c: "/cash",
  f: "/profile",
};

/** How long `g` waits for its second key. */
export const SEQUENCE_MS = 1500;

export interface KeyState {
  /** `g` was pressed and waits for its letter. */
  pending: boolean;
  /** When it was pressed (ms). */
  at: number;
}

export const IDLE_KEYS: KeyState = { pending: false, at: 0 };

export interface KeyPress {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  /** The focus is in a field, a select or editable text. */
  typing: boolean;
  /** A sheet, the palette or a menu is open. */
  overlay: boolean;
  now: number;
}

export function keyStep(
  state: KeyState,
  press: KeyPress,
): { state: KeyState; action: ShortcutAction | null } {
  const key = press.key.length === 1 ? press.key.toLowerCase() : press.key;
  if ((press.ctrl || press.meta) && !press.alt && key === "k") {
    return { state: IDLE_KEYS, action: { kind: "palette" } };
  }
  if (press.ctrl || press.meta || press.alt || press.typing || press.overlay) {
    return { state: IDLE_KEYS, action: null };
  }
  if (state.pending && press.now - state.at <= SEQUENCE_MS) {
    const href = GO_KEYS[key];
    return { state: IDLE_KEYS, action: href ? { kind: "go", href } : null };
  }
  if (key === "g") return { state: { pending: true, at: press.now }, action: null };
  if (key === "/") return { state: IDLE_KEYS, action: { kind: "ask" } };
  if (key === "?") return { state: IDLE_KEYS, action: { kind: "help" } };
  return { state: IDLE_KEYS, action: null };
}

/** Whether a key press lands in something the owner is typing into. */
export function isTyping(
  target: {
    tagName?: string;
    isContentEditable?: boolean;
  } | null,
): boolean {
  if (!target) return false;
  const tag = (target.tagName ?? "").toUpperCase();
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true
  );
}

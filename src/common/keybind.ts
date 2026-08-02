// Rebindable keyboard shortcuts. A keybind is position-based (`event.code`, e.g.
// "KeyP"), so it's keyboard-layout independent and, because we preventDefault,
// fires our action instead of typing the character (Alt+P won't insert π on a
// Mac). `null` means the action is unbound.
export type Keybind = {
  code: string; // KeyboardEvent.code, e.g. "KeyP", "Digit1"
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
} | null;

// The actions a user can rebind. `parse` acts on the page (parse the page, or the
// selection if any); the rest act on the word currently under the pointer.
export type KeybindAction = "parse" | "again" | "hard" | "good" | "easy" | "save" | "known";

// What the settings page lets you rebind. The grade actions keep their type,
// their labels and their defaults: they are simply not offered while the reader
// has no grade row to fire them (see REVIEW_IN_READER in content/actions.ts), so
// nobody binds a key to a button that isn't there.
export const KEYBIND_ACTIONS: KeybindAction[] = ["parse", "save", "known"];

// Human labels for the settings UI, in display order.
export const KEYBIND_LABELS: Record<KeybindAction, string> = {
  parse: "Parse page",
  again: "Grade: Again",
  hard: "Grade: Hard",
  good: "Grade: Good",
  easy: "Grade: Easy",
  save: "Save word",
  known: "Mark known",
};

// Defaults preserve today's behaviour: bare 1–4 / S / K on the hovered word, plus
// a new Alt+P page-parse shortcut.
export const DEFAULT_KEYBINDS: Record<KeybindAction, Keybind> = {
  parse: { code: "KeyP", alt: true, ctrl: false, shift: false, meta: false },
  again: { code: "Digit1", alt: false, ctrl: false, shift: false, meta: false },
  hard: { code: "Digit2", alt: false, ctrl: false, shift: false, meta: false },
  good: { code: "Digit3", alt: false, ctrl: false, shift: false, meta: false },
  easy: { code: "Digit4", alt: false, ctrl: false, shift: false, meta: false },
  save: { code: "KeyS", alt: false, ctrl: false, shift: false, meta: false },
  known: { code: "KeyK", alt: false, ctrl: false, shift: false, meta: false },
};

const MODIFIER_CODES = new Set(["AltLeft", "AltRight", "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]);

// True when a keydown matches the bind exactly (same code AND same modifier set).
export function matchesKeybind(event: KeyboardEvent, bind: Keybind): boolean {
  if (!bind) return false;
  return (
    event.code === bind.code &&
    event.altKey === bind.alt &&
    event.ctrlKey === bind.ctrl &&
    event.shiftKey === bind.shift &&
    event.metaKey === bind.meta
  );
}

// Capture a keybind from a keydown (for the settings capture control). Returns
// null while only modifiers are held, so the user must include a real key.
export function keybindFromEvent(event: KeyboardEvent): Keybind {
  if (MODIFIER_CODES.has(event.code)) return null;
  return {
    code: event.code,
    alt: event.altKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}


// Pretty label, e.g. "Alt + P", "Shift + 1", "⌘ + K". Uses Mac glyphs when the
// popup is running on a Mac.
export function formatKeybind(bind: Keybind, isMac = navigator.platform.startsWith("Mac")): string {
  if (!bind) return "Unbound";
  const parts: string[] = [];
  if (bind.ctrl) parts.push(isMac ? "⌃" : "Ctrl");
  if (bind.alt) parts.push(isMac ? "⌥" : "Alt");
  if (bind.shift) parts.push(isMac ? "⇧" : "Shift");
  if (bind.meta) parts.push(isMac ? "⌘" : "Meta");
  parts.push(codeLabel(bind.code));
  return parts.join(isMac ? " " : " + ");
}

// A readable key name from an `event.code`.
function codeLabel(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${code.slice(6)}`;
  const named: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Escape: "Esc",
    Backspace: "⌫",
    Tab: "Tab",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Semicolon: ";",
    Quote: "'",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Backquote: "`",
  };
  return named[code] ?? code;
}

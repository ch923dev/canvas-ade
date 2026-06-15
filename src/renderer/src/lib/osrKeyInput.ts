/**
 * OS-3 Phase 3 — pure keyboard routing for the offscreen (OSR) Browser preview.
 *
 * The OSR preview's keyboard target is a hidden composition-proxy `<textarea>` (see
 * `useOffscreenInput.ts`). Every keydown on it is classified here into one of four routes,
 * with NO DOM dependency so the decision is unit-testable in isolation:
 *
 *   - `ignore`    — an IME-in-progress sentinel (`isComposing` / `keyCode 229`) or a lone
 *                   modifier / unmapped key. The hook does nothing (the composition events
 *                   drive the page; a lone Shift/Control press has nothing to forward).
 *   - `clipboard` — Ctrl/Cmd + C/X/V/A → routed to the WebContents edit methods
 *                   (`wc.copy/cut/paste/selectAll`), NOT a synthetic chord (the page's
 *                   `navigator.clipboard` is denied, so a synthetic Ctrl+V can't read the OS
 *                   clipboard). The chord is swallowed (preventDefault) — never double-applied.
 *   - `command`   — a named non-text key (Enter/Tab/Esc/arrows/Backspace/Delete/Home/End/PageUp/
 *                   PageDown/F1–F12) OR any Ctrl/Cmd-modified key (Ctrl+S, Ctrl+Z, …). Forwarded as
 *                   a real `sendInputEvent` keyDown/keyUp so the page's key handlers + shortcuts
 *                   fire. preventDefault'd (so the proxy doesn't edit + React Flow doesn't act).
 *   - `text`      — printable input, INCLUDING AltGr-composed (`€`) and dead-key (`é`) results.
 *                   The hook does NOT forward it from keydown; it lets the proxy `input` event
 *                   fire and routes the resulting text via CDP `Input.insertText`. This dissolves
 *                   the AltGr corruption (Windows reports AltGr as Ctrl+Alt) and the dead-key /
 *                   IME-commit cases through one path — the browser composes the grapheme for us.
 */

/** The fields of a DOM KeyboardEvent this classifier reads (a real KeyboardEvent satisfies it). */
export interface OsrKeyInfo {
  key: string
  /** Legacy numeric code; `229` is the cross-browser "IME is handling this" sentinel. */
  keyCode?: number
  /** True while an IME composition is active — the composition path owns those keys. */
  isComposing?: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  /** Present on real events; used to detect AltGr precisely where the OS reports it. */
  getModifierState?: (key: string) => boolean
}

export type ClipboardAction = 'copy' | 'cut' | 'paste' | 'selectAll'

export type KeyClass =
  | { kind: 'ignore' }
  | { kind: 'clipboard'; action: ClipboardAction }
  | { kind: 'command'; keyCode: string }
  | { kind: 'text' }

/** Named non-text keys → their Electron `sendInputEvent` keyCode. (Space is intentionally
 *  absent — it is a TEXT character, routed via insertText into the focused field.) */
const NAMED_KEYS: Record<string, string> = {
  Enter: 'Return',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Escape: 'Escape',
  Delete: 'Delete',
  Insert: 'Insert',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown'
}

const F_KEY = /^F([1-9]|1[0-2])$/ // F1..F12

/** A key that is a navigation/command key (not text): a named key or a function key. */
function isNamedCommandKey(key: string): boolean {
  return key in NAMED_KEYS || F_KEY.test(key)
}

/**
 * Map a DOM `KeyboardEvent.key` to an Electron `keyCode`, or null for keys that carry no
 * forwardable code (lone modifiers, `Dead`, `Process`, `Unidentified`, …). Named keys and
 * F-keys map explicitly; any single character passes through as-is (letters/digits/punctuation).
 */
export function keyCodeOf(key: string): string | null {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key]
  if (F_KEY.test(key)) return key
  if (key.length === 1) return key
  return null
}

/**
 * AltGr detection. Browsers expose it via `getModifierState('AltGraph')`; on Windows the OS
 * synthesizes **Ctrl+Alt** for AltGr (so `€`/`AltGr+E` arrives with `ctrlKey===true`). Either
 * signal means "this is an AltGr text key", which must NOT be treated as a Ctrl/Cmd chord.
 */
export function isAltGr(e: OsrKeyInfo): boolean {
  if (e.getModifierState?.('AltGraph')) return true
  return e.ctrlKey && e.altKey && !e.metaKey
}

/** Classify a keydown into its forwarding route (see the module doc). */
export function classifyKeydown(e: OsrKeyInfo): KeyClass {
  // IME in progress — the composition events (not raw keys) drive the page.
  if (e.isComposing || e.keyCode === 229) return { kind: 'ignore' }

  const altGr = isAltGr(e)
  const commandModified = (e.ctrlKey || e.metaKey) && !altGr

  if (commandModified) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
    if (k === 'c') return { kind: 'clipboard', action: 'copy' }
    if (k === 'x') return { kind: 'clipboard', action: 'cut' }
    if (k === 'v') return { kind: 'clipboard', action: 'paste' }
    if (k === 'a') return { kind: 'clipboard', action: 'selectAll' }
    const code = keyCodeOf(e.key)
    return code ? { kind: 'command', keyCode: code } : { kind: 'ignore' }
  }

  // Unmodified (or AltGr) keys.
  if (isNamedCommandKey(e.key)) {
    const code = keyCodeOf(e.key)
    return code ? { kind: 'command', keyCode: code } : { kind: 'ignore' }
  }
  // Printable, AltGr-composed, or dead-key result → text (the proxy `input` event forwards it).
  if (e.key.length === 1 || altGr) return { kind: 'text' }
  return { kind: 'ignore' } // lone modifiers, Dead, Process, Unidentified, …
}

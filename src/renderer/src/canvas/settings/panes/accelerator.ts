/**
 * Pure helpers for capturing an Electron Accelerator string from a live keydown (Settings ›
 * Shortcuts "Record"). Extracted from ShortcutsPane so they can be unit-tested without a DOM.
 *
 * A RECORDED chord maps the physical Ctrl key to the literal `Control` modifier — NOT
 * `CommandOrControl`, which `globalShortcut.register` resolves to Cmd on macOS. Using
 * `CommandOrControl` for a recorded raw chord would make a Mac user who held Control end up with
 * an accelerator that only fires on Cmd (recorded ≠ fired). `CommandOrControl` is reserved for the
 * platform-intentional DEFAULT binding (hotkeyConfig.DEFAULT_HOTKEYS), not for captured input.
 */
const NAMED: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown'
}

/** The non-modifier key of an accelerator, or null for a lone modifier / unusable key. */
export function accelKey(e: Pick<KeyboardEvent, 'key'>): string | null {
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') return null
  if (NAMED[e.key]) return NAMED[e.key]
  if (/^F\d{1,2}$/.test(e.key)) return e.key
  if (e.key.length === 1) return e.key.toUpperCase()
  return null
}

type ModFields = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

/** Build an Electron accelerator from a keydown, or null if it lacks a strong modifier. */
export function chordFromEvent(e: ModFields): string | null {
  const key = accelKey(e)
  if (!key) return null
  // A bare (or Shift-only) global chord would hijack that key system-wide — require Ctrl/Alt/Meta.
  if (!e.ctrlKey && !e.altKey && !e.metaKey) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Control') // literal Ctrl — NOT CommandOrControl (→ Cmd on macOS)
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  return [...mods, key].join('+')
}

/** Human-friendly rendering of an accelerator string for the Settings chip. */
export function pretty(accel: string): string {
  return accel
    .replace('CommandOrControl', 'Ctrl/⌘')
    .replace('Control', 'Ctrl')
    .replace('Super', '⌘')
    .split('+')
    .join(' + ')
}

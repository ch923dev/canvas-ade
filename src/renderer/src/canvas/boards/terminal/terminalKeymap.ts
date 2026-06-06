/**
 * Pure terminal key-chord → action resolver, mirroring the canvas keymap pattern
 * (resolveCanvasKeyAction). The TerminalBoard registers this via xterm's
 * attachCustomKeyEventHandler; an action means "we own this key" (suppress xterm's
 * default and run it), null means "let xterm handle it" (Enter→\r, Ctrl+C→\x03, …).
 *
 * Ctrl+C is selection-aware: copy ONLY when text is selected, else null so xterm
 * sends SIGINT — keeps the reflexive single-press interrupt and Claude Code's own
 * single/double Ctrl+C intact. The primary modifier is Cmd on macOS, Ctrl elsewhere,
 * so Ctrl+C remains SIGINT on a Mac.
 */
export interface TermKeyChord {
  /** 'keydown' | 'keyup' | 'keypress' — the handler fires for all; act only on keydown. */
  type: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type TerminalKeyAction = { kind: 'newline' } | { kind: 'copy' } | { kind: 'paste' }

export function resolveTerminalKey(
  e: TermKeyChord,
  ctx: { hasSelection: boolean; isMac: boolean }
): TerminalKeyAction | null {
  if (e.type !== 'keydown') return null

  // Shift+Enter inserts a newline (no other modifier).
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    return { kind: 'newline' }
  }

  // Copy/paste use the platform primary modifier; never with Alt (Alt+V is reserved
  // for Claude Code's native image paste, which must pass straight through).
  const primary = ctx.isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary || e.altKey) return null
  const k = e.key.toLowerCase()
  if (k === 'c' && !e.shiftKey && ctx.hasSelection) return { kind: 'copy' }
  if (k === 'v' && !e.shiftKey) return { kind: 'paste' }
  return null
}

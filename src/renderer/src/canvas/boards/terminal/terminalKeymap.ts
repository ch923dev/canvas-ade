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

export type TerminalKeyAction =
  | { kind: 'newline' }
  | { kind: 'copy' }
  | { kind: 'paste' }
  | { kind: 'fontInc' }
  | { kind: 'fontDec' }
  | { kind: 'fontReset' }

/**
 * Byte written to the PTY for a Shift+Enter newline insert. LF (0x0A) — identical to Ctrl+J,
 * which Anthropic's terminal docs (code.claude.com/docs/en/terminal-config) call the newline that
 * works "in every terminal with no setup". The earlier ESC+CR (`\x1b\r`, Meta/Option+Enter) form is
 * emulator/version/ConPTY-fragile: on Windows ConPTY the lone ESC can split from the CR, so the agent
 * reads Escape (cancel) then CR (submit) and inserts no newline (the reported Shift+Enter bug;
 * cf. claude-code issue #9321). LF carries no ESC, so it has no such ambiguity and is agent-agnostic.
 */
export const TERMINAL_NEWLINE = '\n'

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

  // Font-size chords: primary modifier (Cmd on mac, Ctrl else), no Alt/Shift. We
  // deliberately SHADOW these from the shell — matches VS Code / iTerm terminal zoom.
  if (primary && !e.altKey && !e.shiftKey) {
    // '+' is reachable un-shifted on the numpad, so it stays an alias for inc. '_' is only
    // Shift+'-' (always carries shiftKey, blocked above), so '-' alone covers dec.
    if (e.key === '=' || e.key === '+') return { kind: 'fontInc' }
    if (e.key === '-') return { kind: 'fontDec' }
    if (e.key === '0') return { kind: 'fontReset' }
  }

  if (!primary || e.altKey) return null
  const k = e.key.toLowerCase()
  if (k === 'c' && !e.shiftKey && ctx.hasSelection) return { kind: 'copy' }
  if (k === 'v' && !e.shiftKey) return { kind: 'paste' }
  return null
}

/** Side effects the TerminalBoard wires to its live xterm/PTY for the owned chords. */
export interface TerminalKeyEffects {
  /** Write the newline byte (TERMINAL_NEWLINE) to the PTY. */
  newline(): void
  /**
   * Copy the current xterm selection to the clipboard. Returns true if something was
   * copied; false if the selection vanished between keydown and now — in which case the
   * caller must FALL THROUGH to xterm's Ctrl+C (SIGINT) instead of swallowing the key.
   */
  copySelection(): boolean
  /** Smart-paste clipboard contents into the terminal (image → staged path, else text). */
  paste(): void
  /** Nudge the per-board font size by `delta` px (clamped by the board). */
  fontStep(delta: number): void
  /** Reset the per-board font size to the default. */
  fontReset(): void
}

/**
 * The xterm `attachCustomKeyEventHandler` callback, as a pure function over (event, ctx,
 * effects). Returns true → let xterm handle the key; false → WE own it and xterm suppresses
 * its default path.
 *
 * CRITICAL: for every key we own we call `e.preventDefault()`. xterm's `_keyDown` bails the
 * instant this returns false — BEFORE its own `preventDefault` — so without ours the browser
 * still fires the follow-up `keypress`; for Enter that keypress emits a CR (\r) that reaches
 * the PTY AFTER our LF, so an agent newlines then immediately submits (the reported Shift+Enter
 * bug). The one exception is a copy whose selection vanished after resolve: we did NOT consume
 * the key, so we must NOT preventDefault — let it fall through to xterm's SIGINT.
 */
export function handleTerminalKey(
  e: TermKeyChord & { preventDefault(): void },
  ctx: { hasSelection: boolean; isMac: boolean },
  fx: TerminalKeyEffects
): boolean {
  const action = resolveTerminalKey(e, ctx)
  if (!action) return true

  if (action.kind === 'copy') {
    // Selection may have vanished between keydown and now → fall through to SIGINT, no preventDefault.
    if (!fx.copySelection()) return true
    e.preventDefault()
    return false
  }

  e.preventDefault()
  if (action.kind === 'newline') fx.newline()
  else if (action.kind === 'paste') fx.paste()
  else if (action.kind === 'fontInc') fx.fontStep(1)
  else if (action.kind === 'fontDec') fx.fontStep(-1)
  else if (action.kind === 'fontReset') fx.fontReset()
  return false
}

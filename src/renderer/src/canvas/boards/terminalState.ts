/**
 * Pure presentation logic for the Terminal board (no React, no DOM) — kept
 * separate so the state→chrome mapping is unit-testable. Maps the PTY lifecycle
 * state to the agent identity pill (DESIGN.md §7.1: `--ok` running / `--warn`
 * awaiting / `--err` failed) and formats the run timer + braille spinner.
 */

/** Lifecycle states the board can be in (superset of the main `PtyState`). */
export type TerminalState =
  | 'idle'
  | 'spawning'
  | 'running'
  | 'awaiting-input'
  | 'exited'
  | 'spawn-failed'

/** Status-pill descriptor: a colour-token dot + a mono label. */
export interface TerminalStatus {
  /** A CSS colour-token string consumed by `BoardFrame`. */
  dot: string
  label: string
}

/** True while the PTY is live (board shows the progress sliver + spinner). */
export function isRunning(state: TerminalState): boolean {
  return state === 'running'
}

/** True for any state that has a live PTY process behind it. */
export function isLive(state: TerminalState): boolean {
  return state === 'running' || state === 'awaiting-input'
}

/**
 * Identity pill for a state. `name` is the agent identity derived from the
 * launchCommand (or the shell label when no agent is launched). Dot colour
 * follows §7.1: running/spawning `--ok`, awaiting input `--warn`, failure
 * `--err`, otherwise neutral `--text-3`.
 */
export function statusFor(state: TerminalState, name: string, timer?: string): TerminalStatus {
  const suffix = timer ? ` · ${timer}` : ''
  switch (state) {
    case 'spawning':
      return { dot: 'var(--ok)', label: `${name} · starting` }
    case 'running':
      return { dot: 'var(--ok)', label: `${name}${suffix}` }
    case 'awaiting-input':
      return { dot: 'var(--warn)', label: `${name} · awaiting input` }
    case 'spawn-failed':
      return { dot: 'var(--err)', label: `${name} · spawn failed` }
    case 'exited':
      return { dot: 'var(--text-3)', label: `${name} · exited` }
    case 'idle':
    default:
      return { dot: 'var(--text-3)', label: `${name} · idle` }
  }
}

/**
 * Derive a short agent/shell identity from the launchCommand and shell. A
 * launchCommand wins (`claude --resume` → `claude`); otherwise the basename of
 * the shell path, extension stripped (`C:\…\pwsh.exe` → `pwsh`). Empty inputs
 * fall back to `shell`.
 */
export function agentIdentity(launchCommand?: string, shell?: string): string {
  const cmd = launchCommand?.trim()
  if (cmd) {
    const first = cmd.split(/\s+/)[0]
    const base = first.split(/[\\/]/).pop() ?? first
    return base.replace(/\.(exe|cmd|bat)$/i, '') || 'agent'
  }
  if (shell) {
    const base = shell.split(/[\\/]/).pop() ?? shell
    return base.replace(/\.(exe|cmd|bat)$/i, '') || 'shell'
  }
  return 'shell'
}

/** Seconds → `mm:ss` (clamps negatives to 0; minutes are not zero-padded past 99). */
export function formatTimer(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

/** Braille spinner frames (DESIGN.md §9: ~90ms/frame cycle while running). */
export const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Spinner glyph for a monotonically increasing frame index (wraps). */
export function brailleFrame(index: number): string {
  const n = BRAILLE_FRAMES.length
  const i = ((Math.floor(index) % n) + n) % n
  return BRAILLE_FRAMES[i]
}

/**
 * Per-board terminal scrollback (lines of output retained above the viewport): bounds,
 * presets, clamp, and the global "sticky" last-used default. Pure (the only side effect is
 * localStorage, guarded). The TerminalBoard persists the per-board pin in `board.scrollback`;
 * the sticky default seeds the NEXT terminal so a chosen depth carries forward. Mirrors
 * terminalFont.ts.
 *
 * Scrollback is bounded ON PURPOSE (perf cap SLICE-012): xterm retains ~12 B/cell of buffer
 * that never releases while a board stays mounted, so a hard ceiling keeps a runaway log from
 * exhausting RAM. There is deliberately NO "unlimited" option (decided 2026-06-24). See
 * docs/research/2026-06-24-terminal-scrollback/SPEC.md.
 */
export const DEFAULT_TERMINAL_SCROLLBACK = 2000
export const MIN_TERMINAL_SCROLLBACK = 0
export const MAX_TERMINAL_SCROLLBACK = 50000

/** Selectable presets shown as chips in the dialog's Appearance tab (ascending). */
export const SCROLLBACK_PRESETS = [1000, 2000, 10000, 50000] as const

/** localStorage key for the global new-terminal default (per machine, all projects). */
const STICKY_KEY = 'ca.terminal.scrollback'

/** Clamp to [MIN, MAX], floored to an integer; non-finite input collapses to the default. */
export function clampScrollback(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_SCROLLBACK
  return Math.min(MAX_TERMINAL_SCROLLBACK, Math.max(MIN_TERMINAL_SCROLLBACK, Math.floor(n)))
}

/** Read the sticky default (clamped). Default on miss / parse-fail / no storage. */
export function readStickyScrollback(): number {
  try {
    const raw = window.localStorage.getItem(STICKY_KEY)
    if (raw == null) return DEFAULT_TERMINAL_SCROLLBACK
    return clampScrollback(Number.parseInt(raw, 10))
  } catch {
    return DEFAULT_TERMINAL_SCROLLBACK
  }
}

/** Persist the sticky default (clamped). No-op if storage is unavailable. */
export function writeStickyScrollback(n: number): void {
  try {
    window.localStorage.setItem(STICKY_KEY, String(clampScrollback(n)))
  } catch {
    /* storage disabled (private mode / test) — the sticky default just won't persist */
  }
}

/** Initial scrollback for a board: its own pin if set, else the sticky default. */
export function resolveInitialScrollback(boardScrollback: number | undefined): number {
  return boardScrollback != null ? clampScrollback(boardScrollback) : readStickyScrollback()
}

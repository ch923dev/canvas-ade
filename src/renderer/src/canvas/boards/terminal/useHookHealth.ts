/**
 * F4 (terminal-resume research): the Inspector's hook-health fault, derived from MAIN's
 * `recap:health` probe. The capture hook dies silently (no node on PATH in a packaged build;
 * a third-party tool clobbering .claude/settings.local.json mid-session; the hook simply not
 * firing) and the user's only symptom was "Resume never appears" — this surfaces WHY, as one
 * quiet line, only when something is wrong.
 *
 * Fault priority (one at a time): 'runner' > 'hook' > 'no-capture'. Null = render nothing —
 * covers healthy, consent-off / no project (MAIN returns null: capture off is then EXPECTED),
 * and any IPC failure (fail-quiet; a health line must never itself be noise).
 *
 * Re-checks: on PTY lifecycle flips (like useResumeValidity), on window focus (delayed past
 * MAIN's browser-window-focus re-ensure so we observe the HEALED file), and once ~15s after a
 * Claude board starts running — the no-capture grace: if the map still has no entry for this
 * board by then, the hook demonstrably did not fire for a session that should have captured.
 */
import { useEffect, useState } from 'react'
import type { TerminalBoard as TerminalBoardData } from '../../../lib/boardSchema'
import { isRunning, type TerminalState } from '../terminalState'

export type HookHealthFault = 'runner' | 'hook' | 'no-capture' | null

type RecapHealthView = NonNullable<Awaited<ReturnType<typeof window.api.recap.health>>>

/** How long a running Claude session gets to produce its first map entry before we call it. */
export const NO_CAPTURE_GRACE_MS = 15_000
/** Focus re-query delay: let MAIN's focus re-ensure win the race before re-reading. */
const FOCUS_REQUERY_DELAY_MS = 400

/**
 * Only a Claude session can capture (recordSession.js is a Claude Code hook), so the
 * no-capture fault is gated to boards that launch claude. A hand-typed `claude` in a bare
 * shell board is invisible from here — the configured launch is the supported surface.
 */
export function isClaudeLaunch(
  board: Pick<TerminalBoardData, 'agentKind' | 'launchCommand'>
): boolean {
  if (board.agentKind) return board.agentKind === 'claude'
  return /\bclaude\b/i.test(board.launchCommand ?? '')
}

export function useHookHealth(board: TerminalBoardData, state: TerminalState): HookHealthFault {
  const [health, setHealth] = useState<RecapHealthView | null>(null)
  const [nudge, setNudge] = useState(0)
  const { id } = board
  const claudeish = isClaudeLaunch(board)

  useEffect(() => {
    // Mid-spawn the answer flips within milliseconds (mirrors useResumeValidity) — wait for
    // the state to settle, which re-runs this effect.
    if (state === 'spawning') return undefined
    let cancelled = false
    window.api.recap
      .health(id)
      .then((h) => {
        if (!cancelled) setHealth(h)
      })
      .catch(() => {
        if (!cancelled) setHealth(null)
      })
    return () => {
      cancelled = true
    }
  }, [id, state, nudge])

  // The no-capture grace boundary: the fault derives from MAIN's session-age clock (below), so
  // this timer only schedules the ONE re-query that carries an uncaptured running Claude board
  // across the boundary (the map may also have gained its entry mid-grace — the re-read decides).
  useEffect(() => {
    if (!isRunning(state) || !claudeish || !health || health.captured) return undefined
    const age = health.sessionAgeMs
    if (age === null || age >= NO_CAPTURE_GRACE_MS) return undefined
    const t = window.setTimeout(() => setNudge((n) => n + 1), NO_CAPTURE_GRACE_MS - age + 500)
    return () => window.clearTimeout(t)
  }, [state, claudeish, health])

  // Window focus → re-query, delayed so MAIN's browser-window-focus re-ensure (the self-heal)
  // has already rewritten settings.local.json — the line then CLEARS on the alt-tab back.
  useEffect(() => {
    let t: number | undefined
    const onFocus = (): void => {
      if (t) window.clearTimeout(t)
      t = window.setTimeout(() => setNudge((n) => n + 1), FOCUS_REQUERY_DELAY_MS)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      if (t) window.clearTimeout(t)
    }
  }, [])

  if (!health) return null
  if (health.runner === 'missing') return 'runner'
  if (!health.hookInstalled) return 'hook'
  if (
    !health.captured &&
    claudeish &&
    isRunning(state) &&
    (health.sessionAgeMs ?? 0) >= NO_CAPTURE_GRACE_MS
  ) {
    return 'no-capture'
  }
  return null
}

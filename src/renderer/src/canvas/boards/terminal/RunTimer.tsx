import type { ReactElement } from 'react'
import { useRunTimer } from './useRunTimer'

/**
 * The status pill's elapsed-run suffix (` · mm:ss`), as a LEAF so its 1s tick
 * re-renders only this fragment (audit R13 — the tick used to live in
 * `TerminalBoard` and re-render the whole board every second). `TerminalBoard`
 * passes it via `BoardStatus.labelSuffix` only while running, and BoardFrame's
 * label span stays MOUNTED (CSS-hidden at rest) — so this leaf mounts on the run's
 * rising edge and the elapsed count is anchored to the true run start. Never
 * announced: the SR live region reads `BoardStatus.srLabel`, which maps the whole
 * running state to a stable word.
 */
export function RunTimer(): ReactElement | null {
  const timer = useRunTimer(true)
  return timer ? <>{` · ${timer}`}</> : null
}

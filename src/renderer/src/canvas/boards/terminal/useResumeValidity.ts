/**
 * F1 (terminal-resume research): the MAIN-validated replacement for the old
 * `canResume = !!board.agentSessionId` gate.
 *
 * The stored id is captured EAGERLY at Claude's SessionStart — before the transcript exists —
 * and persists in canvas.json forever, so its bare presence proved nothing: launch-then-quit
 * sessions, rotated-away transcripts, and 30-day-pruned ones all kept offering a Resume that
 * could only error `No conversation found`. MAIN (`terminal:resumeCheck`) now answers from the
 * transcript's on-disk reality (exists + non-empty + lineage contains the id).
 *
 * Fail-CLOSED: `false` until a check confirms, and on any IPC error — a Resume button that
 * appears a beat later is strictly better than one that lies. Re-validates on the identity
 * fields and on every PTY lifecycle flip (an exit is exactly when the transcript gains its
 * final turns), not per-render.
 */
import { useEffect, useState } from 'react'
import type { TerminalBoard as TerminalBoardData } from '../../../lib/boardSchema'
import type { TerminalState } from '../terminalState'
import { isE2E, e2eResumeChecks } from '../../../smoke/e2eRegistry'

export function useResumeValidity(board: TerminalBoardData, state: TerminalState): boolean {
  const [canResume, setCanResume] = useState(false)
  const { id, agentSessionId, agentTranscriptPath } = board
  useEffect(() => {
    // Mid-spawn the answer would be stale within milliseconds (the session is about to be
    // replaced) — wait for the flip out of 'spawning', which re-runs this effect.
    if (state === 'spawning') return undefined
    let cancelled = false
    const apply = (ok: boolean): void => {
      if (cancelled) return
      setCanResume(ok)
      if (isE2E()) e2eResumeChecks.set(id, { sessionId: agentSessionId, canResume: ok })
    }
    if (!agentSessionId) {
      apply(false)
      return undefined
    }
    void window.api.terminal
      .resumeCheck(id, { sessionId: agentSessionId, transcriptPath: agentTranscriptPath })
      .then((r) => apply(!!r?.canResume))
      .catch(() => apply(false))
    return () => {
      cancelled = true
    }
  }, [id, agentSessionId, agentTranscriptPath, state])
  return canResume
}

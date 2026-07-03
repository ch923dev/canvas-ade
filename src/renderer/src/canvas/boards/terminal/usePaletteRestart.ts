/**
 * Palette → terminal restart bridge (D4-A). The restart machinery (launch override +
 * PTY respawn) lives inside TerminalBoard's spawn hook, so the command palette posts
 * a one-shot intent and this hook — mounted by the owning TerminalBoard — consumes it
 * by board id. Resume mirrors TerminalBoard's resumeSession exactly (F3: MAIN builds the
 * launch line at click time via `terminal:resumeLaunch`, sanitizing the canvas.json-sourced
 * session id behind the process boundary and degrading a dead id to `--continue`/fresh);
 * 'new' clears the override for a fresh launch. An IPC failure also falls back to fresh —
 * never a stale renderer-side guess.
 */
import { useEffect, type MutableRefObject } from 'react'
import { usePaletteIntentStore } from '../../palette/paletteIntentStore'

export function usePaletteRestart(
  boardId: string,
  agentSessionId: string | undefined,
  agentTranscriptPath: string | undefined,
  launchOverrideRef: MutableRefObject<string | undefined>,
  restart: () => void
): void {
  const intent = usePaletteIntentStore((s) => s.intent)
  useEffect(() => {
    if (!intent || intent.boardId !== boardId) return
    if (intent.kind !== 'restart-resume' && intent.kind !== 'restart-new') return
    usePaletteIntentStore.getState().consume(intent.nonce)
    if (intent.kind !== 'restart-resume') {
      launchOverrideRef.current = undefined
      restart()
      return
    }
    void window.api.terminal
      .resumeLaunch(boardId, { sessionId: agentSessionId, transcriptPath: agentTranscriptPath })
      .then((r) => {
        launchOverrideRef.current = r?.command
        restart()
      })
      .catch(() => {
        launchOverrideRef.current = undefined
        restart()
      })
  }, [intent, boardId, agentSessionId, agentTranscriptPath, launchOverrideRef, restart])
}

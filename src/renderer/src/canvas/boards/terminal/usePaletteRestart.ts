/**
 * Palette → terminal restart bridge (D4-A). The restart machinery (launch override +
 * PTY respawn) lives inside TerminalBoard's spawn hook, so the command palette posts
 * a one-shot intent and this hook — mounted by the owning TerminalBoard — consumes it
 * by board id. Resume mirrors TerminalRestartMenu's onResume exactly (resumeCommand
 * sanitises the canvas.json-sourced session id to one inert token before it nears the
 * PTY); 'new' clears the override for a fresh launch.
 */
import { useEffect, type MutableRefObject } from 'react'
import { usePaletteIntentStore } from '../../palette/paletteIntentStore'
import { resumeCommand } from './resumeCommand'

export function usePaletteRestart(
  boardId: string,
  agentSessionId: string | undefined,
  launchOverrideRef: MutableRefObject<string | undefined>,
  restart: () => void
): void {
  const intent = usePaletteIntentStore((s) => s.intent)
  useEffect(() => {
    if (!intent || intent.boardId !== boardId) return
    if (intent.kind !== 'restart-resume' && intent.kind !== 'restart-new') return
    usePaletteIntentStore.getState().consume(intent.nonce)
    launchOverrideRef.current =
      intent.kind === 'restart-resume' ? resumeCommand(agentSessionId) : undefined
    restart()
  }, [intent, boardId, agentSessionId, launchOverrideRef, restart])
}

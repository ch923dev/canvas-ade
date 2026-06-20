import { useCallback, useEffect, useState } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { digestRefreshReason, type DigestRefreshResult } from '../../lib/digestPanel'

/**
 * The reopen DigestPanel's cached Tier-2 prose container logic (T-M4 / T-F4), extracted from
 * Canvas.tsx so that god-file stays under the max-lines ratchet. Two responsibilities:
 *   • fetch cached `board-<id>.md` prose once per project open (pure disk read, NO LLM call),
 *   • expose a manual ⟳ refresh that re-summarizes one board (budgeted + passive in MAIN) and,
 *     MCP-04, returns WHY a refresh produced nothing (no project / provider-key / budget).
 *
 * `openedProjectKey` is Canvas's per-open identity (projectDir | 'open' | null); a change marks a
 * project open/switch (re-fetch); null clears the prose. The refresh never throws — both memory
 * IPC handlers resolve rather than reject; the catch is a defensive guard.
 */
export function useDigestProse(openedProjectKey: string | null): {
  prose: Record<string, string>
  refreshBoardProse: (boardId: string) => Promise<DigestRefreshResult>
} {
  const [prose, setProse] = useState<Record<string, string>>({})
  useEffect(() => {
    if (openedProjectKey === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProse({})
      return
    }
    let cancelled = false
    // Fire once per open/switch (openedProjectKey changes on each project-open transition); boards
    // are read live via getState so this does not re-fetch on every board edit.
    const ids = useCanvasStore.getState().boards.map((b) => b.id)
    void window.api.memory
      .readBoards(ids)
      .then((map) => {
        if (!cancelled) setProse(map)
      })
      .catch(() => {
        // readBoards never rejects (returns {} on any guard/no-dir case); guard a surprise rejection
        // so it can't surface as an unhandled promise. Prose stays empty → Tier-1 lines render.
      })
    return () => {
      cancelled = true
    }
  }, [openedProjectKey])

  const refreshBoardProse = useCallback(async (boardId: string): Promise<DigestRefreshResult> => {
    try {
      const r = await window.api.memory.refresh(boardId)
      const md = (await window.api.memory.readBoards([boardId]))[boardId]
      if (md !== undefined) {
        setProse((prev) => ({ ...prev, [boardId]: md }))
        return { ok: true }
      }
      const s = await window.api.llm.status().catch(() => null)
      const hasKey = !!s && s.hasProvider && s.hasKey
      return { ok: false, message: digestRefreshReason({ projectOpen: !!r?.ok, hasKey }) }
    } catch {
      return { ok: false, message: 'Couldn’t refresh the summary — try again.' }
    }
  }, [])

  return { prose, refreshBoardProse }
}

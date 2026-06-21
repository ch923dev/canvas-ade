/**
 * FileBoard save handler, extracted from FileBoard.tsx to keep that host under the file-size
 * doctrine (max-lines ratchet). Owns the Cmd/Ctrl+S atomic write AND the FIND-002
 * optimistic-concurrency guard: the last-known on-disk mtime is passed to `file.writeText`, so MAIN
 * refuses to BLIND-overwrite a file an external process (e.g. an agent in a terminal) changed since
 * — a last-writer-wins overwrite would silently discard that edit. On a conflict the user's buffer
 * is kept (stays dirty) and a toast warns; the new on-disk mtime becomes the baseline so an explicit
 * re-save is an INFORMED overwrite (or the user reopens the board to load the external version).
 */
import { useCallback } from 'react'
import { showToast } from '../../store/toastStore'
import { baseName } from './fileBoardSyntax'

/** The mutable refs + setters the save handler reads (structural `{ current }` shapes so it stays
 *  agnostic to React's RefObject/MutableRefObject typing). `savedMtimeRef` is read AND written. */
export interface FileSaveDeps {
  boardId: string
  pathRef: { current: string | undefined }
  textRef: { current: string }
  dirtyRef: { current: boolean }
  savingRef: { current: boolean }
  savedMtimeRef: { current: number | null }
  setSaving: (v: boolean) => void
  setSavedText: (v: string) => void
}

export function useFileSave(deps: FileSaveDeps): () => Promise<void> {
  const { boardId, pathRef, textRef, dirtyRef, savingRef, savedMtimeRef, setSaving, setSavedText } =
    deps
  return useCallback(async (): Promise<void> => {
    const p = pathRef.current
    if (!p || savingRef.current || !dirtyRef.current) return
    const toast = (id: string, message: string): void => {
      showToast({ id: `${id}-${boardId}`, kind: 'error', message })
    }
    setSaving(true)
    const snapshot = textRef.current
    try {
      const res = await window.api.file.writeText(p, snapshot, savedMtimeRef.current ?? undefined)
      // Adopt the current on-disk mtime as the baseline either way (the new one after a write, or the
      // conflicting one) so a follow-up save compares against reality.
      savedMtimeRef.current = res.mtimeMs
      if (!res.ok) {
        toast(
          'file-conflict',
          `${baseName(p)} changed on disk - your edits were NOT overwritten. Save again to overwrite, or reopen to load the new version.`
        )
        return
      }
      setSavedText(snapshot)
    } catch (e) {
      toast(
        'file-save',
        `Couldn't save ${baseName(p)} - ${e instanceof Error ? e.message : String(e)}`
      )
    } finally {
      setSaving(false)
    }
  }, [boardId, pathRef, textRef, dirtyRef, savingRef, savedMtimeRef, setSaving, setSavedText])
}

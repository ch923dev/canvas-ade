/**
 * Planning image I/O, extracted from PlanningBoard.tsx (god-file split 6.3).
 * Owns the clipboard-paste + file-drop image pipeline: the `imageExt` MIME map,
 * `addImageFromBlob` (persist a blob via `asset.write` then drop an image element,
 * live-read commit so a concurrent edit during the async write window survives),
 * the document-level `onWellPaste` listener (+ its add/remove effect), and the two
 * drag handlers. Behavior-preserving — only `onWellDragOver`/`onWellDrop` are
 * surfaced (wired onto the `.pl-well`); `addImageFromBlob`/`onWellPaste` are internal.
 */
import { useCallback, useEffect, type DragEvent as ReactDragEvent, type RefObject } from 'react'
import type { PlanningBoard as PlanningBoardData, PlanningElement } from '../../../lib/boardSchema'
import { useCanvasStore } from '../../../store/canvasStore'
import { makeImage, fitImageSize, IMAGE_MAX } from './elements'
import { showToast } from '../../../store/toastStore'

const newId = (): string => crypto.randomUUID()

/** Clipboard/file MIME → the ext the assets pipeline stores (undefined = not an image we accept). */
const imageExt = (type: string): string | undefined =>
  ({
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg'
  })[type]

interface PlanningImageIODeps {
  wellRef: RefObject<HTMLDivElement>
  toBoard: (e: { clientX: number; clientY: number }) => { x: number; y: number }
  commit: (next: PlanningElement[] | ((current: PlanningElement[]) => PlanningElement[])) => void
  beginChange: () => void
  board: PlanningBoardData
}

export function usePlanningImageIO(deps: PlanningImageIODeps): {
  onWellDragOver: (e: ReactDragEvent) => void
  onWellDrop: (e: ReactDragEvent) => void
} {
  const { wellRef, toBoard, commit, beginChange, board } = deps

  /** Persist an image blob and drop an image element at `at` (one undo step). */
  const addImageFromBlob = useCallback(
    async (blob: Blob, at: { x: number; y: number }): Promise<void> => {
      const ext = imageExt(blob.type)
      if (!ext) return
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const res = await window.api.asset.write(bytes, ext)
      if ('error' in res) {
        // Surface the write failure (disk full / no project open / bad ext) instead of
        // silently abandoning the paste/drop. Keep the early return — we never add a
        // broken image element — but route it to the app toast channel (D1-A) so it is
        // visible in a packaged build, not just the dev console (the open W5 follow-up).
        // eslint-disable-next-line no-console
        console.error('image write failed:', res.error)
        showToast({
          id: `image-write-failed-${board.id}`,
          kind: 'error',
          message: 'Could not add image — check the project folder and disk space'
        })
        return
      }
      let w = IMAGE_MAX
      let h = IMAGE_MAX
      try {
        const bmp = await createImageBitmap(blob)
        const fit = fitImageSize(bmp.width, bmp.height)
        w = fit.w
        h = fit.h
        bmp.close()
      } catch {
        /* undecodable → keep the square fallback size */
      }
      beginChange()
      // Re-read the LIVE elements at COMMIT time, not the closure captured at call time:
      // updateBoard fully REPLACES `elements` (no merge), so an edit landing during the
      // two awaits above (asset.write + createImageBitmap) would be silently dropped if we
      // spread the stale captured array (lost update). Mirrors growForChecklist's getState().
      const live = useCanvasStore.getState().boards.find((b) => b.id === board.id)
      const cur = live?.type === 'planning' ? live.elements : []
      commit([...cur, makeImage(newId(), at, res.assetId, w, h)])
    },
    [beginChange, commit, board.id]
  )

  /** Paste an image from the clipboard → board centre. Bound at the DOCUMENT level, not
   *  as the well's React onPaste: Chromium dispatches the `paste` event at the document
   *  (not the focused non-editable well), so an onPaste on the well never fires for a real
   *  Ctrl+V — only drag-drop reaches the well. We listen on the document and gate on this
   *  board's well owning focus, so Ctrl+V only lands an image on the board the user is
   *  working in (the Excalidraw/tldraw pattern). No image in the clipboard → we no-op
   *  without preventDefault, so a text paste into a focused note still proceeds normally. */
  const onWellPaste = useCallback(
    (e: ClipboardEvent): void => {
      const well = wellRef.current
      if (!well || !well.contains(document.activeElement)) return
      const data = e.clipboardData
      if (!data) return
      // A pasted bitmap can surface either as a DataTransferItem (kind 'file') OR only in
      // `.files` — which one depends on the OS/source. Check both so paste is robust.
      let file: File | null = null
      for (const it of data.items) {
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          file = it.getAsFile()
          if (file) break
        }
      }
      if (!file) file = Array.from(data.files).find((f) => f.type.startsWith('image/')) ?? null
      if (!file) return
      e.preventDefault()
      const r = well.getBoundingClientRect()
      void addImageFromBlob(
        file,
        toBoard({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })
      )
    },
    // `wellRef` (a stable RefObject) joins the deps now that it arrives via props rather
    // than an in-scope useRef — mirrors usePlanningPointer; identity-stable so it never
    // re-creates the callback. (Behavior-identical to the original [addImageFromBlob, toBoard].)
    [addImageFromBlob, toBoard, wellRef]
  )
  useEffect(() => {
    document.addEventListener('paste', onWellPaste)
    return () => document.removeEventListener('paste', onWellPaste)
  }, [onWellPaste])

  /** Allow a file drag over the well (required for onDrop to fire). */
  const onWellDragOver = useCallback((e: ReactDragEvent): void => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
  }, [])

  /** Drop an image file → at the cursor (board-local). */
  const onWellDrop = useCallback(
    (e: ReactDragEvent): void => {
      const files = e.dataTransfer?.files
      if (!files || files.length === 0) return
      const file = Array.from(files).find((f) => f.type.startsWith('image/'))
      if (!file) return
      e.preventDefault()
      void addImageFromBlob(file, toBoard(e))
    },
    [addImageFromBlob, toBoard]
  )

  return { onWellDragOver, onWellDrop }
}

/**
 * Whiteboard export popover (W5) — self-contained extraction from PlanningBoard.
 * The download trigger lives in the BoardFrame action slot; the PNG/SVG menu is
 * PORTALED to <body> (like BoardMenu): the title bar + board root are
 * `overflow:hidden`, so an in-place absolute popover would be clipped invisible.
 * Owns all of its own state/effects: open flag, measured position, close-on-
 * (pointerdown/Escape/resize), and the position layout pass.
 */
import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { PlanningBoard as PlanningBoardData } from '../../../lib/boardSchema'
import { IconBtn } from '../../BoardFrame'

export function ExportPopover({ board }: { board: PlanningBoardData }): ReactElement {
  const [exportOpen, setExportOpen] = useState(false)
  const exportTriggerRef = useRef<HTMLDivElement>(null)
  const [exportPos, setExportPos] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999
  })
  // D0-5: a failed export gets a visible transient note (the W5 follow-up "silent
  // export-failure feedback" gap). Interim surface reusing .ca-preview-note; final
  // home is the D1 toast channel. Held as an OBJECT so a repeated identical failure
  // still yields a fresh reference — the position effect below re-measures (the board
  // may have moved between failures).
  const [note, setNote] = useState<{ text: string } | null>(null)
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current)
    },
    []
  )
  const showNote = (msg: string): void => {
    if (noteTimer.current) clearTimeout(noteTimer.current)
    setNote({ text: msg })
    noteTimer.current = setTimeout(() => setNote(null), 4000)
  }
  const runExport = useCallback(
    async (format: 'png' | 'svg') => {
      setExportOpen(false)
      try {
        const { buildExport } = await import('./exportBoard')
        const { bytes, ext } = await buildExport(board, format)
        // export:save RETURNS a discriminated result — it never throws on a write failure,
        // so the catch below alone would let a real failure (permission denied / disk full)
        // look like a user cancel. Inspect the result: surface a genuine error, but stay
        // silent on an explicit cancel (the user dismissed the save dialog).
        const res = await window.api.export.save({
          bytes,
          ext,
          defaultName: board.title || 'whiteboard'
        })
        if (!res.ok && !res.canceled) {
          // eslint-disable-next-line no-console
          console.error('whiteboard export failed:', res.error)
          showNote(res.error ? `Export failed — ${res.error}` : 'Export failed')
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('whiteboard export failed', err)
        showNote('Export failed')
      }
    },
    [board]
  )
  useEffect(() => {
    if (!exportOpen) return
    const close = (): void => setExportOpen(false)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setExportOpen(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [exportOpen])
  // Measure the trigger and right-align the portaled popover under it (clamped into
  // the viewport), before paint so it never flashes at a stale corner.
  useLayoutEffect(() => {
    if (!exportOpen) return
    const t = exportTriggerRef.current?.getBoundingClientRect()
    if (!t) return
    const W = 148
    const PAD = 8
    const left = Math.max(PAD, Math.min(t.right - W, window.innerWidth - W - PAD))
    setExportPos({ top: t.bottom + 4, left })
  }, [exportOpen])
  // D0-5: same measure-and-clamp pass for the failure note (it outlives the menu).
  const [notePos, setNotePos] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999
  })
  useLayoutEffect(() => {
    if (!note) return
    const t = exportTriggerRef.current?.getBoundingClientRect()
    if (!t) return
    const W = 240
    const PAD = 8
    const left = Math.max(PAD, Math.min(t.right - W, window.innerWidth - W - PAD))
    setNotePos({ top: t.bottom + 4, left })
  }, [note])

  return (
    <div ref={exportTriggerRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <IconBtn
        name="download"
        title="Export"
        size={15}
        active={exportOpen}
        onClick={() => setExportOpen((v) => !v)}
      />
      {exportOpen &&
        createPortal(
          <div
            role="menu"
            onPointerDown={(e) => e.stopPropagation()}
            style={{
              position: 'fixed',
              top: exportPos.top,
              left: exportPos.left,
              zIndex: 50,
              width: 148,
              display: 'flex',
              flexDirection: 'column',
              padding: 4,
              background: 'var(--surface-overlay)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-inner)',
              boxShadow: 'var(--shadow-pop)'
            }}
          >
            <button className="board-menu-item" onClick={() => void runExport('png')}>
              Export PNG
            </button>
            <button className="board-menu-item" onClick={() => void runExport('svg')}>
              Export SVG
            </button>
          </div>,
          document.body
        )}
      {/* D0-5: transient export-failure note. Portaled + fixed (the title bar is
          overflow:hidden, so an in-place note would clip); .ca-preview-note's absolute
          board-overlay anchoring is overridden to the measured trigger position. */}
      {note &&
        createPortal(
          <div
            className="ca-preview-note"
            role="status"
            style={{
              position: 'fixed',
              top: notePos.top,
              left: notePos.left,
              right: 'auto',
              width: 240,
              zIndex: 50
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {note.text}
            <button className="ca-preview-dismiss" onClick={() => setNote(null)}>
              Dismiss
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}

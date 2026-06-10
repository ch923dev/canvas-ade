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
import { showToast } from '../../../store/toastStore'
import { IconBtn } from '../../BoardFrame'

export function ExportPopover({ board }: { board: PlanningBoardData }): ReactElement {
  const [exportOpen, setExportOpen] = useState(false)
  const exportTriggerRef = useRef<HTMLDivElement>(null)
  const [exportPos, setExportPos] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999
  })
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
          // Fixed copy: res.error is a raw OS/API string (paths, ENOENT) and the toast
          // is read aloud by the alert region; the console line above keeps the detail.
          // D1-A: failures route to the app toast channel (was a board-anchored note).
          showToast({
            kind: 'error',
            message: res.error
              ? 'Export failed — check file permissions and disk space'
              : 'Export failed'
          })
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('whiteboard export failed', err)
        showToast({ kind: 'error', message: 'Export failed' })
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
    </div>
  )
}

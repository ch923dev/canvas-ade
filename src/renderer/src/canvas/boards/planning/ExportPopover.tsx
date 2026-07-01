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
import { runBoardExport } from './runExport'
import { IconBtn } from '../../BoardFrame'
import { Icon } from '../../Icon'
import { InspectorAction } from '../../inspector/primitives'

/**
 * `toolbar` = the original BoardFrame action-slot IconBtn. `inspector` = a labelled
 * InspectorAction (P3, the PlanningInspector re-home) that opens the SAME PNG/SVG menu —
 * the positioning + menu markup below are shared verbatim, only the trigger differs.
 */
export function ExportPopover({
  board,
  variant = 'toolbar'
}: {
  board: PlanningBoardData
  variant?: 'toolbar' | 'inspector'
}): ReactElement {
  const inspector = variant === 'inspector'
  const [exportOpen, setExportOpen] = useState(false)
  const exportTriggerRef = useRef<HTMLDivElement>(null)
  const [exportPos, setExportPos] = useState<{ top: number; left: number }>({
    top: -9999,
    left: -9999
  })
  // Build → save → toast-on-failure lives in runBoardExport (shared with the
  // command palette's export verbs since D4-A).
  const runExport = useCallback(
    async (format: 'png' | 'svg') => {
      setExportOpen(false)
      await runBoardExport(board, format)
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
    <div
      ref={exportTriggerRef}
      style={{ position: 'relative', display: inspector ? 'block' : 'inline-flex' }}
    >
      {inspector ? (
        <InspectorAction
          icon={<Icon name="download" size={14} />}
          active={exportOpen}
          onClick={() => setExportOpen((v) => !v)}
          dataTest="inspector-export"
        >
          Export…
        </InspectorAction>
      ) : (
        <IconBtn
          name="download"
          title="Export"
          size={15}
          active={exportOpen}
          onClick={() => setExportOpen((v) => !v)}
        />
      )}
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

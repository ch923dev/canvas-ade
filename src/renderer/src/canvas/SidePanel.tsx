/**
 * File-tree epic (S2) — the docked, auto-hide file-tree panel (window chrome, like the Dock).
 *
 * Hides behind a slim left-edge handle so it never sits over board content; reveals when the
 * pointer MOVES into a left-edge proximity zone (window-level pointermove — element hover is a
 * flicker trap, per the Dock). A short entrance delay keeps a fast pass from flashing it; it
 * hides a grace period after the cursor leaves. Pinned open while keyboard focus is inside (a
 * hidden-but-focusable tree would tab blind). Only mounts when a project is open.
 *
 * This mirrors AppChrome's `Dock` reveal machine — registered ONCE with all mutable state in
 * closure locals so a deps-driven re-register can't drop the window listener mid-dispatch
 * (the mid-dispatch-listener-removal hazard); only the committed `inZone` crosses into React.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { FileTree } from './FileTree'

/** Revealed panel width (px). */
const PANEL_W = 264
/** Hidden → reveal when the cursor is within this many px of the left edge. */
const REVEAL_EDGE = 36
/** While open, stay open until the cursor passes this far from the left edge. */
const KEEP_OPEN = PANEL_W + 48
/** Entrance delay — a cursor slung along the left edge shouldn't flash the panel. */
const REVEAL_DELAY_MS = 100
/** Grace after the cursor exits before the panel hides. */
const HIDE_DELAY_MS = 1200

export function SidePanel(): ReactElement | null {
  const hasProject = useCanvasStore((s) => s.project.dir !== null)
  const [inZone, setInZone] = useState(false)
  const [focused, setFocused] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const revealed = inZone || focused

  useEffect(() => {
    if (!hasProject) return
    let zone: 'out' | 'pending' | 'in' = 'out'
    let enterTimer: number | null = null
    let hideTimer: number | null = null
    let last = { x: NaN, y: NaN }

    // The band is a full-height left strip; it widens once open so moving ONTO the panel keeps
    // it revealed (the reveal is driven here, not by element hover).
    const inBand = (x: number): boolean => x <= (zone === 'in' ? KEEP_OPEN : REVEAL_EDGE)
    const cancelEnter = (): void => {
      if (enterTimer !== null) {
        window.clearTimeout(enterTimer)
        enterTimer = null
      }
    }
    const cancelHide = (): void => {
      if (hideTimer !== null) {
        window.clearTimeout(hideTimer)
        hideTimer = null
      }
    }
    // Shared by far-away moves and cursor-left-the-window (without the latter, exiting through
    // the window's left/top edge would leave it stuck open).
    const goOutside = (): void => {
      if (zone === 'pending') {
        cancelEnter()
        zone = 'out'
      } else if (zone === 'in' && hideTimer === null) {
        hideTimer = window.setTimeout(() => {
          hideTimer = null
          zone = 'out'
          setInZone(false)
        }, HIDE_DELAY_MS)
      }
    }
    const onMove = (e: PointerEvent): void => {
      last = { x: e.clientX, y: e.clientY }
      if (inBand(e.clientX)) {
        cancelHide()
        if (zone === 'out') {
          zone = 'pending'
          enterTimer = window.setTimeout(() => {
            enterTimer = null
            if (inBand(last.x)) {
              zone = 'in'
              setInZone(true)
            } else {
              zone = 'out'
            }
          }, REVEAL_DELAY_MS)
        }
      } else {
        goOutside()
      }
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.addEventListener('mouseleave', goOutside)
    window.addEventListener('blur', goOutside)
    return () => {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseleave', goOutside)
      window.removeEventListener('blur', goOutside)
      cancelEnter()
      cancelHide()
    }
  }, [hasProject])

  if (!hasProject) return null

  return (
    // pointerEvents:none on the wrapper so the canvas under the (hidden) panel stays clickable;
    // the revealed panel opts back in via CSS. Focus events pass through pointer-events, so the
    // focus-within pin works from the wrapper.
    <div
      ref={wrapRef}
      className="ca-sidepanel-wrap"
      style={{ width: PANEL_W }}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
    >
      <div className="ca-sidepanel-handle" data-revealed={revealed} aria-hidden="true" />
      <aside className="ca-sidepanel" data-revealed={revealed} aria-label="Project files">
        <div className="ca-sidepanel-head">Files</div>
        <FileTree />
      </aside>
    </div>
  )
}

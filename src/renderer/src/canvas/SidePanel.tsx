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
 *
 * Perf (SLICE-013): the FileTree pulls react-arborist + react-window (~34KB gz). It is
 * code-split via React.lazy so that trio leaves the eager cold-start index chunk and loads on
 * first panel open. We only MOUNT the lazy boundary once the panel has been revealed at least
 * once (`revealedOnce`) — before that the panel is hidden anyway, so the chunk never loads at
 * boot — then keep it mounted so tree state (expansion/selection) survives hide/show.
 */
import { lazy, Suspense, useEffect, useRef, useState, type ReactElement } from 'react'
import { useCanvasStore } from '../store/canvasStore'
import { useFileTreeUiStore } from '../store/fileTreeUiStore'
import type { FileTreeHandle } from './FileTree'

// React.lazy needs a default export; FileTree is a named forwardRef export, so adapt the module
// shape here. lazy forwards refs through to the wrapped forwardRef component, so the SidePanel's
// imperative handle (collapseAll / openSelected) still works once the chunk has loaded.
const FileTree = lazy(() => import('./FileTree').then((m) => ({ default: m.FileTree })))

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
  // Forced reveal: bumped by an empty File board's "Browse files" button (fileTreeUiStore). Holds
  // the panel open for a grace window so the user can move onto the tree (which then keeps it open
  // via inZone/focus); auto-clears so it never sticks open on its own.
  const [forced, setForced] = useState(false)
  const revealNonce = useFileTreeUiStore((s) => s.revealNonce)
  const seenNonce = useRef(revealNonce)
  const wrapRef = useRef<HTMLDivElement>(null)
  const treeRef = useRef<FileTreeHandle>(null)
  // Number of FILES currently multi-selected in the tree → drives the "Open N boards" button.
  const [selCount, setSelCount] = useState(0)
  const revealed = inZone || focused || forced
  // Latch: stays true once the panel has been revealed for the first time. Gates the lazy
  // FileTree mount so its react-arborist/react-window chunk loads on first open, not at boot.
  // Guarded setState during render (React's sanctioned "adjust state from prior renders" pattern,
  // not a setState-in-effect): the first reveal mounts the lazy chunk, then it stays mounted so
  // tree expansion/selection survives hide/show.
  const [revealedOnce, setRevealedOnce] = useState(false)
  if (revealed && !revealedOnce) setRevealedOnce(true)

  useEffect(() => {
    if (revealNonce === seenNonce.current) return // ignore the mount-time value; react only to bumps
    seenNonce.current = revealNonce
    setForced(true)
    const t = window.setTimeout(() => setForced(false), 5000)
    return () => window.clearTimeout(t)
  }, [revealNonce])

  // VS Code parity: Ctrl/Cmd+Shift+B collapses every folder in the tree (registered once while a
  // project is open; mirrors "Collapse Folders in Explorer"). Read the ref at call time.
  useEffect(() => {
    if (!hasProject) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault()
        treeRef.current?.collapseAll()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasProject])

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
        <div className="ca-sidepanel-head">
          <span>Files</span>
          {selCount >= 2 && (
            <button
              className="ca-sidepanel-open-btn"
              title={`Open ${selCount} selected files as a grid of boards (Enter)`}
              onClick={() => treeRef.current?.openSelected()}
            >
              Open {selCount}
            </button>
          )}
          <button
            className="ca-ftree-collapse"
            title="Collapse folders (Ctrl+Shift+B)"
            aria-label="Collapse all folders"
            onClick={() => treeRef.current?.collapseAll()}
          >
            <svg
              width={14}
              height={14}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.7}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M7 7l5 5 5-5M7 17l5-5 5 5" />
            </svg>
          </button>
        </div>
        {/* Lazy boundary (SLICE-013): mount the code-split FileTree only after the panel has
            been revealed once, then keep it mounted. The Suspense fallback reuses the tree's
            own quiet placeholder styling — it only ever shows while the chunk is in flight on
            first open, inside the (now-visible) panel. */}
        {revealedOnce && (
          <Suspense fallback={<div className="ca-ftree-empty">Loading files…</div>}>
            <FileTree ref={treeRef} onSelectionCount={setSelCount} />
          </Suspense>
        )}
      </aside>
    </div>
  )
}

// Phase 5 · S4 — jump-to-bottom badge. A calm pill, bottom-right of the terminal well
// (the find bar's mirror image), shown ONLY while the buffer is scrolled above the live
// tail. Click → snap to the bottom. An optional accent count chip surfaces output that
// streamed in below the fold while the user was reading up-buffer.
//
// Self-contained like TerminalFindBar: it owns its scroll subscription and all visibility
// state LOCALLY, so a scroll / new-output event re-renders only this tiny memo'd component,
// never the whole TerminalBoard (which re-renders ~12×/s for the braille spinner). The host
// just mounts us with the stable `termRef` and a `ready` flag (term exists / has output).
import { memo, useEffect, useRef, useState, type ReactElement, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import { isScrolledUp, unreadSince, formatUnread } from './terminalJump'

function TerminalJumpButtonImpl({
  termRef,
  ready
}: {
  /** The live xterm instance (stable for the board's lifetime; reused across respawn). */
  termRef: RefObject<Terminal | null>
  /** The term exists and may hold scrollback (state ≠ idle). Gates the subscription. */
  ready: boolean
}): ReactElement | null {
  const [scrolledUp, setScrolledUp] = useState(false)
  const [unread, setUnread] = useState(0)
  // The buffer's tail (baseY) at the moment we were last AT the tail. While scrolled up,
  // unread = current baseY − anchor (lines appended below the fold since). A ref, not state:
  // it advances on every at-tail write without forcing a re-render.
  const anchorRef = useRef(0)

  useEffect(() => {
    if (!ready) return
    const term = termRef.current
    if (!term) return
    // Recompute from the live buffer on each scroll / parsed-write. At the tail we keep the
    // anchor advancing (and force unread back to 0 — a no-op setState once already 0, so an
    // at-tail firehose never re-renders); scrolled up we publish the growing delta.
    const sync = (): void => {
      const { viewportY, baseY } = term.buffer.active
      if (isScrolledUp(viewportY, baseY)) {
        setScrolledUp(true)
        setUnread(unreadSince(baseY, anchorRef.current))
      } else {
        anchorRef.current = baseY
        setScrolledUp(false)
        setUnread(0)
      }
    }
    const onScroll = term.onScroll(sync)
    const onWrite = term.onWriteParsed(sync)
    anchorRef.current = term.buffer.active.baseY
    sync() // initial (e.g. mounting while already scrolled up)
    return () => {
      onScroll.dispose()
      onWrite.dispose()
    }
  }, [ready, termRef])

  if (!scrolledUp) return null

  const jump = (): void => {
    const term = termRef.current
    if (!term) return
    term.scrollToBottom()
    term.focus()
    anchorRef.current = term.buffer.active.baseY
    setScrolledUp(false)
    setUnread(0)
  }

  const count = formatUnread(unread)
  return (
    <button
      type="button"
      className="tj-jump nodrag nowheel"
      data-test="terminal-jump"
      aria-label={count ? `Jump to bottom, ${unread} new lines below` : 'Jump to bottom'}
      title="Jump to bottom"
      // The well's onMouseDown focuses xterm — stop it here so clicking the pill doesn't
      // yank focus mid-click (mirrors the find bar's guard).
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={jump}
    >
      <span className="tj-chev" aria-hidden="true">
        ↓
      </span>
      Jump to bottom
      {count && (
        <span className="tj-new" data-test="terminal-jump-count">
          {count} new
        </span>
      )}
    </button>
  )
}

export const TerminalJumpButton = memo(TerminalJumpButtonImpl)

/**
 * Browser-board auto-connect engine (renderer). One always-on 1s interval drives
 * BOTH reconnect-on-refused and auto-push-detected-port via the pure `planAutoConnect`
 * policy. It reuses existing IPC/store: a `reload` bumps `previewStore.requestReload`
 * (reconcile re-navigates), a `detect` polls `detectPorts` on the linked terminal and
 * (only while NOT connected) sets the board's url via `updateBoard` (a plain setter →
 * no undo step). Per-board exponential backoff (1→2→4s) avoids hammering a dead server.
 *
 * Mounted ONCE beside usePreviewManager (BrowserPreviewLayer). Reads stores via
 * getState() each tick (no selector → no re-render). Security: never writes the PTY;
 * detected URLs are used as-is (origin form from portDetect) and only steer the board url.
 */
import { useEffect, useRef } from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { usePreviewStore } from '../../store/previewStore'
import type { BrowserBoard } from '../../lib/boardSchema'
import { planAutoConnect, backoffTicks, type PreviewStatusLike } from '../../lib/autoConnect'

const TICK_MS = 1000

interface Attempt {
  attempts: number
  waitTicks: number
  lastStatus: PreviewStatusLike
}

function isHttpUrl(u: string): boolean {
  try {
    const x = new URL(u)
    return x.protocol === 'http:' || x.protocol === 'https:'
  } catch {
    return false
  }
}

export function useBrowserAutoConnect(): void {
  const attemptsRef = useRef<Map<string, Attempt>>(new Map())

  useEffect(() => {
    const handle = setInterval(() => {
      const cs = useCanvasStore.getState()
      const pv = usePreviewStore.getState()
      const seen = new Set<string>()

      for (const b of cs.boards) {
        if (b.type !== 'browser') continue
        const board = b as BrowserBoard
        seen.add(board.id)
        const status = (pv.byId[board.id]?.status ?? 'idle') as PreviewStatusLike

        let a = attemptsRef.current.get(board.id)
        if (!a) {
          a = { attempts: 0, waitTicks: 0, lastStatus: status }
          attemptsRef.current.set(board.id, a)
        }
        // A status change restarts backoff (a fresh load-failed retries promptly).
        if (status !== a.lastStatus) {
          a.attempts = 0
          a.waitTicks = 0
          a.lastStatus = status
        }
        if (status === 'connected') {
          a.attempts = 0
          a.waitTicks = 0
          continue
        }
        if (a.waitTicks > 0) {
          a.waitTicks--
          continue
        }

        const plan = planAutoConnect({
          status,
          hasUrl: isHttpUrl(board.url),
          hasSource: !!board.previewSourceId
        })
        if (plan.kind === 'idle') continue

        a.attempts++
        a.waitTicks = backoffTicks(a.attempts)

        if (plan.kind === 'reload') {
          usePreviewStore.getState().requestReload(board.id)
        } else if (plan.kind === 'detect') {
          const sourceId = board.previewSourceId
          if (!sourceId) continue
          const bid = board.id
          void (async () => {
            let urls: Awaited<ReturnType<typeof window.api.detectPorts>>
            try {
              urls = await window.api.detectPorts(sourceId)
            } catch {
              return
            }
            if (!urls.length) return
            const next = urls[0].url
            // Re-read live state: skip if the board was deleted or has since connected.
            const live = useCanvasStore.getState()
            const fresh = live.boards.find((x) => x.id === bid)
            if (!fresh || fresh.type !== 'browser') return
            if ((usePreviewStore.getState().byId[bid]?.status ?? 'idle') === 'connected') return
            if ((fresh as BrowserBoard).url !== next) live.updateBoard(bid, { url: next })
          })()
        }
      }

      // GC bookkeeping for removed boards.
      for (const key of [...attemptsRef.current.keys()]) {
        if (!seen.has(key)) attemptsRef.current.delete(key)
      }
    }, TICK_MS)

    return () => clearInterval(handle)
  }, [])
}

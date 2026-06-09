import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { WebglAddon } from '@xterm/addon-webgl'
import type { Terminal } from '@xterm/xterm'

// ── Renderer-wide WebGL context budget (#12/#29) ──────────────────────────────
// Chromium caps live WebGL2 contexts per renderer (~16, shared across all terminal
// boards + Browser views + React Flow) and silently evicts the OLDEST once exceeded.
// The LOD release alone doesn't bound the many-visible-terminals case (lod is a
// global zoom-only flag), so we add a hard cap WELL under 16 — terminals over the
// cap stay on the slower DOM renderer instead of thrashing the shared budget. A
// freed slot (LOD detach, unmount, or context loss) re-upgrades one waiting
// DOM-fallback terminal so eviction is recoverable rather than permanent.
const WEBGL_BUDGET = 8
/** Board ids currently holding a live GL context. */
const liveWebgl = new Set<string>()
/** Board ids that want a GL context but are over budget — keyed retry callbacks. */
const wantWebgl = new Map<string, () => void>()

/** Reserve a GL slot for `id`. Returns false (caller stays on DOM renderer) at cap. */
function acquireWebglSlot(id: string): boolean {
  if (liveWebgl.has(id)) return true
  if (liveWebgl.size >= WEBGL_BUDGET) return false
  liveWebgl.add(id)
  return true
}

/** Free `id`'s slot and let one waiting DOM-fallback terminal try to upgrade. */
function releaseWebglSlot(id: string): void {
  if (!liveWebgl.delete(id)) return
  const next = wantWebgl.entries().next()
  if (!next.done) {
    const [waitingId, retry] = next.value
    wantWebgl.delete(waitingId)
    retry()
  }
}

export function useTerminalWebgl(
  boardId: string,
  lod: boolean,
  lodRef: RefObject<boolean>,
  termRef: RefObject<Terminal | null>
): { attachWebgl: (term: Terminal) => void; detachWebgl: () => void } {
  const webglRef = useRef<WebglAddon | null>(null)

  // ── WebGL renderer pooling (#10/#12/#29) ─────────────────────────────────────
  // Chromium caps live WebGL2 contexts (~16, shared with Browser views + React
  // Flow) and silently drops the OLDEST under churn. We (1) hold a GL context only
  // for DETAIL-view terminals — a board at LOD releases so on-screen terminals keep
  // theirs — AND (2) enforce a hard renderer-wide cap (WEBGL_BUDGET) via the
  // module-level registry, since `lod` is global zoom-only and never bounds the
  // many-visible-terminals case. Over the cap a terminal stays on the DOM renderer
  // and registers a retry that fires when a slot frees. The PTY session is
  // independent of the renderer, so this is purely a perf/quality lever.
  //
  // The over-budget retry (wantWebgl) and onContextLoss re-acquire closures must
  // re-invoke attachWebgl, but a useCallback can't reference its own binding from its
  // body (react-hooks). Route the recursive call through a ref kept in sync below.
  const attachWebglRef = useRef<(t: Terminal) => void>(() => {})
  const attachWebgl = useCallback(
    (term: Terminal): void => {
      if (webglRef.current) return
      // Over budget: stay on the DOM renderer and queue a retry for when a slot
      // frees (LOD detach / unmount / context loss elsewhere). Re-read the live
      // term then so a disposed/LOD'd board never upgrades.
      if (!acquireWebglSlot(boardId)) {
        wantWebgl.set(boardId, () => {
          const t = termRef.current
          if (!lodRef.current && t) attachWebglRef.current(t)
        })
        return
      }
      wantWebgl.delete(boardId)
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          webgl.dispose()
          webglRef.current = null
          // Free our slot (re-upgrades one waiting DOM-fallback terminal), then —
          // if still in detail view — try to re-acquire so an in-detail eviction
          // (#29) recovers rather than stranding us on the DOM renderer forever.
          releaseWebglSlot(boardId)
          setTimeout(() => {
            const t = termRef.current
            if (!lodRef.current && t) attachWebglRef.current(t)
          }, 0)
        })
        term.loadAddon(webgl)
        webglRef.current = webgl
      } catch {
        /* GL unavailable — xterm falls back to the DOM/canvas renderer */
        releaseWebglSlot(boardId)
      }
    },
    [boardId, lodRef, termRef]
  )

  const detachWebgl = useCallback((): void => {
    try {
      webglRef.current?.dispose()
    } catch {
      /* already disposed */
    }
    webglRef.current = null
    wantWebgl.delete(boardId)
    releaseWebglSlot(boardId)
  }, [boardId])

  // Keep the recursion ref pointed at the latest attachWebgl (stable per board.id).
  useEffect(() => {
    attachWebglRef.current = attachWebgl
  }, [attachWebgl])

  // Release the GL context at LOD; re-acquire on return to detail view. Guarded by
  // a live terminal (the spawn effect owns mount/unmount of `term` itself).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (lod) detachWebgl()
    else attachWebgl(term)
  }, [lod, attachWebgl, detachWebgl, termRef])

  return { attachWebgl, detachWebgl }
}

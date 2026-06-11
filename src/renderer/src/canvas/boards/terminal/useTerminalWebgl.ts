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
  suspend: boolean,
  suspendRef: RefObject<boolean>,
  termRef: RefObject<Terminal | null>
): { attachWebgl: (term: Terminal) => void; detachWebgl: () => void } {
  const webglRef = useRef<WebglAddon | null>(null)

  // ── WebGL renderer pooling (#10/#12/#29) ─────────────────────────────────────
  // Chromium caps live WebGL2 contexts (~16, shared with Browser views + React
  // Flow) and silently drops the OLDEST under churn. We (1) hold a GL context only
  // while the host doesn't `suspend` — LOD only since the FREEZE re-raster: the
  // settled-zoom counter-scale keeps the GL backing store 1:1 with device pixels at
  // EVERY settled zoom, so the old "release GL at non-crisp zoom" valve is gone
  // (docs/research/2026-06-12-terminal-native-reraster-audit.md) — AND (2)
  // enforce a hard renderer-wide cap (WEBGL_BUDGET) via the module-level registry,
  // since suspension is global zoom-only and never bounds the
  // many-visible-terminals case. Over the cap a terminal stays on the DOM renderer
  // — ALSO crisp at net scale 1 — and registers a retry that fires when a slot
  // frees. The PTY session is independent of the renderer, so this is purely a
  // perf lever.
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
          if (!suspendRef.current && t) attachWebglRef.current(t)
        })
        return
      }
      wantWebgl.delete(boardId)
      // A failed activation can throw AFTER the addon appended its canvas: the
      // WebglRenderer constructor passes its GL2 check, appends to .xterm-screen,
      // then can still die in shader/atlas setup (deterministic on the Linux e2e
      // leg's software GL) — and xterm does not unwind the append. Without a sweep
      // every retry leaks one dead canvas (e2e-caught: canvases grew per zoom
      // cycle). Snapshot the screen's canvases and remove only what THIS attempt
      // added, so a sibling renderer's canvas is never touched.
      const screenEl = term.element?.querySelector('.xterm-screen') ?? null
      const beforeCanvases = screenEl ? new Set(screenEl.querySelectorAll('canvas')) : null
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
            if (!suspendRef.current && t) attachWebglRef.current(t)
          }, 0)
        })
        term.loadAddon(webgl)
        webglRef.current = webgl
      } catch {
        /* GL unavailable — xterm falls back to the DOM renderer */
        releaseWebglSlot(boardId)
        if (screenEl && beforeCanvases) {
          for (const c of screenEl.querySelectorAll('canvas')) {
            if (!beforeCanvases.has(c)) c.remove()
          }
        }
      }
    },
    [boardId, suspendRef, termRef]
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

  // Release the GL context while suspended (LOD); re-acquire when the host
  // un-suspends. Guarded by a live terminal (the spawn effect owns mount/unmount
  // of `term` itself).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    if (suspend) detachWebgl()
    else attachWebgl(term)
  }, [suspend, attachWebgl, detachWebgl, termRef])

  return { attachWebgl, detachWebgl }
}

/**
 * Main → renderer Browser-preview lifecycle event subscription, extracted from
 * `usePreviewManager` (god-file maintainability, Tier-1). Behavior-preserving move of the
 * single `window.api.onPreviewEvent` effect: each event from main's `WebContentsView`
 * (per board) is folded into the ephemeral `previewStore` runtime state the BrowserBoard
 * reads. Handles these event types:
 *   • `escape`            — Esc inside a focused native view (the renderer never gets the
 *                           keydown); closes full view when the event's board is the
 *                           full-view one (`onCloseFullViewRef`).
 *   • `did-start-navigation` — a fresh main-frame nav started; clears a stale `load-failed`
 *                           latch (Bug #5) so the following finish-load can promote.
 *   • `did-finish-load`   — promote `connecting` → `connected` (latch- + existence-gated).
 *   • `did-navigate`      — update liveUrl + back/forward (present-only, Bug #32).
 *   • `did-fail-load`     — latch `load-failed` + error (present-only, Bug #32).
 *   • `render-process-gone` — the preview renderer died (D2-C); latch `crashed` +
 *                           reason (present-only) so the board offers a Reload CTA.
 * All Bug #5/#18/#32 gating + the `recs.exists` existence checks move verbatim; the only
 * change vs the host is dropping a now-stale `did-start-navigation` cast (the preload
 * `PreviewEvent` union declares it). The subscription re-binds only when the patch
 * selectors change; the full-view id + close callback are read through refs.
 */
import { useEffect, type MutableRefObject } from 'react'
import { usePreviewStore } from '../../store/previewStore'
import { useCanvasStore } from '../../store/canvasStore'
import type { BoardRec } from '../boards/usePreviewManager'

/** The store's `patch` / `patchIfPresent` action signatures, taken straight off the store so
 *  the host can pass `usePreviewStore((s) => s.patch)` / `(s) => s.patchIfPresent` with no cast. */
type PatchRuntime = ReturnType<typeof usePreviewStore.getState>['patch']
type PatchRuntimeIfPresent = ReturnType<typeof usePreviewStore.getState>['patchIfPresent']

export function usePreviewEvents(params: {
  /** Per-board native-view bookkeeping (the manager's `recs`); read for `.exists` gating. */
  recs: MutableRefObject<Map<string, BoardRec>>
  /** Latest full-view board id, kept fresh by the manager's focus effect. */
  fullViewIdRef: MutableRefObject<string | null>
  /** Live ref to the close-full-view callback (avoids re-binding on its identity change). */
  onCloseFullViewRef: MutableRefObject<() => void>
  patchRuntime: PatchRuntime
  patchRuntimeIfPresent: PatchRuntimeIfPresent
}): void {
  const { recs, fullViewIdRef, onCloseFullViewRef, patchRuntime, patchRuntimeIfPresent } = params
  useEffect(() => {
    const off = window.api.onPreviewEvent((ev) => {
      // Esc pressed while the native view's web content owns focus (main forwards it via
      // before-input-event). The renderer window never receives this keydown, so close
      // full view here when the event's board is the full-view one — parity with the
      // window Esc handler that already exits full view for terminals/notes.
      // D4-B (audit A3): outside full view the same Esc is the focus-return gesture —
      // main already handed OS focus back to this window's webContents; select the
      // board (existence-gated) so the keyboard context lands visibly where the user
      // was, and Tab/arrows/Enter/F2 continue from it. The next Esc (now reaching the
      // window keymap) clears the selection — one Esc, one layer out.
      if ((ev.type as string) === 'escape') {
        if (ev.id === fullViewIdRef.current) onCloseFullViewRef.current()
        else if (useCanvasStore.getState().boards.some((b) => b.id === ev.id))
          useCanvasStore.getState().selectBoard(ev.id)
        return
      }
      // A fresh main-frame navigation STARTED (reload / back / forward / in-page link).
      // Clear a stale `load-failed` latch so the following did-finish-load can promote
      // to `connected` after a successful recovery load (Bug #5). Only clears the
      // load-failed latch — the error page's OWN did-finish-load is still suppressed
      // (main reuses the failed navigation and emits no fresh did-start-navigation for it).
      if (ev.type === 'did-start-navigation') {
        // Recovery only matters for a board that still has a live native view; ignore
        // an in-flight nav-start for an evicted/deleted board (Bug #18/#32 — no rec, or
        // its renderer was freed → don't resurrect or mutate a stale entry).
        if (!recs.current.get(ev.id)?.exists) return
        const cur = usePreviewStore.getState().byId[ev.id]?.status
        // D2-C: `crashed` clears the same way — the Reload CTA's wc.reload() relaunches
        // the renderer and fires a fresh main-frame nav-start. Any OTHER status
        // (connecting/connected/idle) intentionally falls through to the return with
        // no patch: only the two terminal-failure latches need explicit clearing.
        if (cur === 'load-failed' || cur === 'crashed')
          patchRuntime(ev.id, { status: 'connecting', error: null })
        return
      }
      // D2-C: the preview's renderer process died. Surface it (status `crashed` +
      // reason) so the board shows the crashed state + Reload CTA instead of a silent
      // freeze. Present-only (Bug #32 pattern): never resurrect a deleted board.
      if (ev.type === 'render-process-gone') {
        patchRuntimeIfPresent(ev.id, { status: 'crashed', error: ev.reason })
        return
      }
      if (ev.type === 'did-finish-load') {
        // Bug #18: reconcile against the lifecycle before promoting. An over-cap-evicted
        // board (closeBoard cleared exists/attached + live, but left status 'connecting')
        // whose load completes just as its view is closed would otherwise flip to a green
        // 'connected' over a detached snapshot with no live view. Skip when there is no
        // live native view (rec gone or its renderer was freed). This also avoids
        // resurrecting a cleared runtime entry for a just-deleted board (Bug #32).
        if (!recs.current.get(ev.id)?.exists) return
        // Respect a prior load-failed: a dead/refused URL loads a Chromium error page
        // whose own did-finish-load must not flip the board back to "connected"
        // (Bug #5). Main already latches `failed` and suppresses the emit in that
        // case; this is the renderer-side belt-and-suspenders — only promote to
        // connected from the in-flight `connecting` state, never override load-failed.
        const cur = usePreviewStore.getState().byId[ev.id]?.status
        if (cur === 'load-failed') return
        patchRuntime(ev.id, { status: 'connected', liveUrl: ev.url, error: null })
      } else if (ev.type === 'did-navigate') {
        // BUG-004: an in-page (client-side route) nav that committed a non-error in-app
        // route AFTER a prior failure carries `recovered` (main reset its own `failed`
        // latch + re-showed the view). An in-page route fires no did-finish-load to promote
        // it, so without lifting the latch here the board stays stuck on `load-failed` over
        // live content until a full main-frame reload. The flag is read off the event (the
        // preload union may lag the optional field); a genuine 4xx main-frame failure (which
        // re-emits a plain did-navigate) never sets it.
        const recovered = (ev as { recovered?: boolean }).recovered === true
        // Gate the promotion on a live native view (Bug #18 discipline, as did-finish-load
        // does): never flip an evicted board to a green `connected` over a dead view.
        const cur =
          recovered && recs.current.get(ev.id)?.exists
            ? usePreviewStore.getState().byId[ev.id]?.status
            : undefined
        if (cur === 'load-failed' || cur === 'crashed') {
          patchRuntimeIfPresent(ev.id, {
            status: 'connected',
            liveUrl: ev.url,
            canGoBack: ev.canGoBack,
            canGoForward: ev.canGoForward,
            error: null
          })
          return
        }
        // Bug #32: patch ONLY if the entry still exists — an in-flight nav event that
        // arrives after the board was deleted must not resurrect a cleared orphan.
        patchRuntimeIfPresent(ev.id, {
          liveUrl: ev.url,
          canGoBack: ev.canGoBack,
          canGoForward: ev.canGoForward
        })
      } else if (ev.type === 'did-fail-load') {
        patchRuntimeIfPresent(ev.id, { status: 'load-failed', error: ev.errorDescription })
      }
    })
    return off
    // `recs` / `fullViewIdRef` / `onCloseFullViewRef` are stable refs read for their
    // `.current` (intentionally NOT deps); the subscription re-binds only on a patch-selector
    // identity change — the original effect's contract. Passed as params (vs refs declared in
    // this scope), so the rule can't see they're refs and flags them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchRuntime, patchRuntimeIfPresent])
}

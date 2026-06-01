# NEW-CAM-1: `attachBoard` post-`openPreview` guard doesn't check `r.exists`, allowing stale `live:true` patch after concurrent `closeBoard`

**Severity:** Low
**Category:** preview native-view lifecycle
**Status:** CONFIRMED
**Files touched:** `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`
**Assigned:** _

## Summary

`attachBoard`'s async path (new renderer, `!r.exists`) guards against a board being *deleted* while the `openPreview` IPC round-trip is in flight (`if (!recs.current.has(g.id)) return`), but does NOT guard against the renderer being *closed* by a concurrent `closeBoard` call. If `closeBoard` runs during the await (e.g., the user enters full-view on another board, which causes `applyLiveness` to close every non-full-view renderer), `r.exists` and `r.attached` are reset to `false`, but `recs.current.has(g.id)` still returns `true` because `recs.current.delete(id)` is only called by `reconcile` when the board is *removed from the store*. The code therefore falls through and calls `patchRuntime(g.id, { live: true })` on a board whose native renderer was already closed. The `DiagOverlay` live-view count is inflated by 1 and the previewStore entry shows `live: true` with no backing view until the next `applyLiveness`/reconcile call resets it.

## Where

`src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx` lines 423–431:

```ts
await window.api.openPreview({ id: g.id, url: g.url, bounds, zoomFactor })
// Bug #48/#30: the board may have been deleted during the open IPC round-trip
// (reconcile ran closeBoard + recs.delete + clearRuntime). Re-check existence
// before the trailing live:true patch …
if (!recs.current.has(g.id)) return    // ← only catches deletion, not closeBoard
```

`closeBoard` (lines 437–448) resets `r.exists = false` and `r.attached = false` but does **not** call `recs.current.delete(id)`:

```ts
const closeBoard = useCallback(
  (id: string): void => {
    const r = rec(id)
    r.attached = false
    r.exists = false
    r.lastSent = null
    r.lastUrl = null
    void window.api.closePreview(id)
    patchRuntime(id, { live: false })
  },
  [rec, patchRuntime]
)
```

## How it triggers

Realistic race:

1. A Browser board becomes eligible → `attachBoard` enters the `!r.exists` branch, sets `r.exists = true`, dispatches `openPreview`, awaits the IPC (~few ms).
2. Before the IPC resolves, the user triggers full-view on a *different* board.
3. The `focusMounted` effect fires synchronously, calling `applyLiveness`.
4. `applyLiveness` is in the full-view branch (`fvId !== null`), calls `closeBoard` on the board from step 1 (it is not the full-view board). `r.exists = false`, `r.attached = false`, `closePreview` IPC dispatched.
5. The `openPreview` promise resolves.
6. `recs.current.has(g.id)` → `true` (rec still in the map). Guard does not fire.
7. `patchRuntime(g.id, { live: true })` executes — inflating the live count and setting a `live: true` flag for a board with no native renderer.

Self-heals on the next `applyLiveness` or reconcile cycle (e.g. next store mutation or camera move), which calls `attachBoard` again (new-board path) or re-evaluates liveness.

## Verification evidence

Guard that does NOT catch this case (line 429):
```ts
if (!recs.current.has(g.id)) return
```

`closeBoard` does NOT remove from the map (lines 438–447):
```ts
const r = rec(id)
r.attached = false
r.exists = false
r.lastSent = null
r.lastUrl = null
void window.api.closePreview(id)
patchRuntime(id, { live: false })
```

Contrast `demoteToSnapshot` (lines 366–372), which uses a correct compound guard:
```ts
if (!recs.current.has(g.id)) return
if (!r.attached || r.attachSeq !== seq) return
```

`attachBoard` uses only the first half of that compound guard and has no `r.exists` check.

## Suggested fix direction

Add a `r.exists` check after the await to mirror the guards in `demoteToSnapshot` and `beginMotion`:

```ts
await window.api.openPreview({ id: g.id, url: g.url, bounds, zoomFactor })
if (!recs.current.has(g.id)) return         // deleted
if (!r.exists) return                        // closed by concurrent closeBoard/applyLiveness
```

Alternatively, use the `attachSeq` guard already available on the rec (increment before await, check after).

## Collision notes: TBD

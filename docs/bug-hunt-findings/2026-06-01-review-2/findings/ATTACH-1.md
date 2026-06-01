# ATTACH-1: attachBoard missing post-await recheck → transient live-count miscount

- **Severity:** Low
- **Category:** preview / state coherence
- **Status:** CONFIRMED (high confidence). **Overlaps a known issue** — already in scope of prior preview-race findings; kept for the precise recheck-gap analysis.
- **Files touched:** `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`
- **Assigned:** _(blank)_

## Summary
`attachBoard` sets the rec live, awaits `openPreview` (IPC round-trip), then patches `live:true` guarded **only**
by `if (!recs.current.has(g.id)) return` — which catches board **deletion** but not renderer **closure**. If
`closeBoard(g.id)` runs during the await, the rec still exists (closeBoard does not delete it) → guard passes →
`live:true` re-patched on a now-closed board. Inflates `previewStore` live-count / DiagOverlay by 1.

## Where
`BrowserPreviewLayer.tsx:415-431`:
```ts
r.exists = r.attached = true
await window.api.openPreview(...)      // line 423
if (!recs.current.has(g.id)) return    // line 429: only catches deletion
patch(g.id, { live: true })            // line 431
```
`closeBoard` (`437-448`) sets `attached=false, exists=false` but does **not** delete the rec (rec deletion only
in reconcile's removed-board path, `line 735`). `closeBoard` is also called without a recs-delete via
`applyLiveness` over-cap (`604`) and full-view eviction (`571/573`) — driven by independent rAF / focus / gesture
callbacks that can fire during the await.

`previewStore.patch` is create-if-absent (`previewStore.ts:100-103`); the resurrected `live:true` is counted by
`selectLiveCount` (`128-131`).

`demoteToSnapshot` is the in-code precedent: it re-checks both `!r.attached` and `r.attachSeq` after its await
(`367/370`). `attachBoard` lacks this post-await check.

## Impact (corrected down to Low)
Transient, self-healing DiagOverlay live-count miscount. **No native-view leak** (main IPC handlers run in order;
`preview:close` disposes the view correctly). **MAX_LIVE cap NOT broken** (cap counts `r.attached` rec flags, not
`selectLiveCount`). Self-heals on next reconcile/applyLiveness (fires on nearly any gesture/selection/mutation).

## Suggested fix direction
After the `openPreview` await, re-check `r.attached` / `r.exists` (and bump+compare an `attachSeq`) exactly as
`demoteToSnapshot` does; skip the `live:true` patch if the board was closed during the await.

## Collision notes
Lane B (same file as PREV-1).

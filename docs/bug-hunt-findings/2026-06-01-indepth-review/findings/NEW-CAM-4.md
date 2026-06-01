# NEW-CAM-4: `demoting` set not cleared when `endMotion` fires before capture completes, causing native views to skip pump position updates on subsequent camera gestures

**Severity:** Medium
**Category:** Camera sync / rAF loop
**Status:** CONFIRMED
**Files touched:** `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`
**Assigned:** _

## Summary

`beginMotion` adds live boards to `demoting.current` before starting the `capturePreview` async round-trip. The `demoting` set is only cleared at one point: inside the async IIFE at line 537, after `detachPreview` resolves. If `endMotion` fires while the capture is in flight (a camera flick that settles in ~16–33 ms, while `capturePage` IPC takes ~10–50 ms), the early-return guard at line 505 (`if (!gestureRef.current) return`) aborts the IIFE without clearing `demoting`. The boards remain in `demoting.current` indefinitely. On the next camera gesture, `flushBatch` unconditionally skips any board in `demoting` (`if (demoting.current.has(g.id)) continue`), so the rAF pump never pushes position updates for those boards. The native views are stuck at their last `attachBoard`-computed position and do not track the camera during motion.

## Where

`beginMotion` async IIFE, `BrowserPreviewLayer.tsx` lines 497–538:

```ts
live.forEach((g) => demoting.current.add(g.id))   // added here
void (async () => {
  const shots = await Promise.all(...)
  if (!gestureRef.current) return                  // ← early-return does NOT clear demoting
  ...
  await Promise.all(detached.map((g) => window.api.detachPreview(g.id)))
  ...
  live.forEach((g) => demoting.current.delete(g.id))  // only reached if gestureRef stayed true
})()
```

`flushBatch` unconditionally skips demoting boards, lines 455–456:

```ts
if (demoting.current.has(g.id)) continue // about to detach — don't trail it (#43961)
```

`endMotion` that sets `gestureRef.current = false`, lines 608–619:

```ts
const endMotion = useCallback((): void => {
  if (usePreviewStore.getState().nodeGesture) return
  gestureRef.current = false     // ← clears the flag mid-capture
  applyLiveness()
}, [applyLiveness])
```

## How it triggers

1. User makes a fast camera flick (finger or trackpad quick swipe). `useOnViewportChange.onStart` fires → `beginMotion()`.
2. Boards added to `demoting.current`. Capture IPCs dispatched (parallel `capturePreview` calls).
3. Camera settles quickly (~16–33 ms). `useOnViewportChange.onEnd` fires → `endMotion()`.
4. `endMotion`: `gestureRef.current = false`, `applyLiveness()` runs → reattaches boards at rest position.
5. `capturePreview` responses arrive (~10–50 ms on a busy GPU). The async IIFE resumes.
6. `if (!gestureRef.current) return` → `true` → IIFE aborts. `demoting.current.delete` never called.
7. Boards remain in `demoting.current`. They are now attached (from step 4) but stuck in the skip list.
8. Next camera gesture: `flushBatch` skips all demoting boards. Native views do not follow the camera. Boards appear frozen at their rest position while the canvas pans around them.

The race self-heals only when a subsequent `beginMotion` reaches a camera gesture where captures complete *before* `endMotion` fires (the IIFE runs to completion and clears `demoting`). Until then, the native views are visually mispositioned during every camera pan.

## Verification evidence

The only call sites for `demoting.current.delete`:

```
grep -n "demoting.current.delete" BrowserPreviewLayer.tsx
537:      live.forEach((g) => demoting.current.delete(g.id))
```

Line 537 is inside the async IIFE, guarded by the `if (!gestureRef.current) return` at line 505. No other code path clears `demoting`.

`flushBatch` skip gate (lines 455–456):
```ts
if (demoting.current.has(g.id)) continue // about to detach — don't trail it (#43961)
```

This applies to boards regardless of whether they are actually mid-detach; if they are stuck in `demoting` their position is never updated by the pump.

`reconcile`'s bounds-push (lines 745–750) is gated on `!gestureRef.current`, not on `demoting`, so a store mutation does eventually push correct bounds — but only when a mutation occurs, not continuously during camera motion.

## Suggested fix direction

Clear `demoting` in the early-return path as well, since when `gestureRef.current` is false the gesture has ended and no detach will happen:

```ts
if (!gestureRef.current) {
  // Gesture ended before captures completed — no detach needed; clear demoting.
  live.forEach((g) => demoting.current.delete(g.id))
  return
}
```

Alternatively, clear `demoting` at the start of `applyLiveness` or `endMotion` (after setting `gestureRef.current = false`) to ensure that any stale `demoting` entries are always cleaned up when a gesture ends, regardless of async timing:

```ts
const endMotion = useCallback((): void => {
  if (usePreviewStore.getState().nodeGesture) return
  gestureRef.current = false
  demoting.current.clear()     // ← gesture over, nothing is mid-detach any more
  applyLiveness()
}, [applyLiveness, demoting])
```

The `demoting.current.clear()` approach is safe because by the time `endMotion` fires, `applyLiveness` will re-evaluate liveness and call `attachBoard` for eligible boards, superseding any pending detach.

## Collision notes: TBD

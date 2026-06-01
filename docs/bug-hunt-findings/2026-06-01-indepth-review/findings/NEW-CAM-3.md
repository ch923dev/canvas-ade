# NEW-CAM-3: Full-view dedicated rAF loop runs every frame indefinitely with no idle-stop mechanism

**Severity:** Info
**Category:** Camera sync / rAF loop
**Status:** CONFIRMED
**Files touched:** `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`
**Assigned:** _

## Summary

The full-view dedicated rAF loop (required so the full-view board's native bounds track window resizes and the portal relocation when the camera never moves) unconditionally re-queues itself every frame for the entire duration that `fullViewId` is set. Unlike the camera-driven pump (which self-stops after 4 idle `flushBatch` frames), this loop has no idle-stopping mechanism. Once the modal frame is stable and the native view is attached at the correct rect, the loop continues firing `requestAnimationFrame` at 60 Hz, calling `flushBatch()` each time. `flushBatch`'s diff-skip prevents redundant IPC, but the rAF callback itself — and the `recs.current.get()`, `fullViewBoundsFor` DOM query, and `rectsEqual` calls — runs on every display frame until the modal is closed.

## Where

`BrowserPreviewLayer.tsx` lines 667–687:

```ts
useEffect(() => {
  if (!fullViewId) return
  let raf = 0
  const tick = (): void => {
    if (!fullViewMotionRef.current) {
      const g = geomRef.current.get(fullViewId)
      if (g && !recs.current.get(fullViewId)?.attached) void attachBoard(g)
      flushBatch()
    }
    raf = requestAnimationFrame(tick)   // ← unconditional re-queue, never stops
  }
  raf = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(raf)
}, [fullViewId, flushBatch, attachBoard])
```

Compare with the camera-driven pump (lines 475–484), which has an explicit 4-frame idle stop:

```ts
const step = (): void => {
  idleRef.current = flushBatch() ? 0 : idleRef.current + 1
  rafRef.current = idleRef.current < 4 ? requestAnimationFrame(step) : 0
}
```

## How it triggers

Any time a Browser board enters full view, the dedicated rAF loop starts and runs at display refresh rate (typically 60 Hz) until the modal closes. The loop's work per frame:
- `fullViewMotionRef.current` read (ref, ~0 ns)
- `geomRef.current.get(fullViewId)` map lookup
- `recs.current.get(fullViewId)` map lookup
- If not attached: `attachBoard` async call (rare)
- `flushBatch()`:
  - Iterates `geomRef.current` (1 entry in full view — all others are closed)
  - `fullViewBoundsFor(id)` → `document.querySelector('[data-bb-frame="..."]')` DOM query + `getBoundingClientRect()` + `host.contains(el)` check
  - `rectsEqual` comparison
  - Usually returns `false` (nothing changed) → 0 IPC

At 60 Hz this is ~60 DOM queries per second for the entire time the modal is open, even when the window isn't resizing and the view is perfectly stable.

## Verification evidence

`tick` unconditionally re-queues at the bottom (line 683):
```ts
raf = requestAnimationFrame(tick)
```

No idle counter. No early return when `flushBatch` returned `false` repeatedly.

`flushBatch` is called on line 681:
```ts
flushBatch()
```

And `fullViewBoundsFor` inside `flushBatch` does a live DOM query every call (lines 238–257):
```ts
const el = document.querySelector<HTMLElement>(`[data-bb-frame="${id}"]`)
if (!el || !host.contains(el)) return null
const r = el.getBoundingClientRect()
```

## Suggested fix direction

Add a short idle-stop (matching the camera pump's 4-frame threshold) so the loop quiesces once bounds are stable, with a restart triggered by window-resize or `flushBatch` returning `true` (bounds changed):

```ts
let idle = 0
const tick = (): void => {
  if (!fullViewMotionRef.current) {
    const g = geomRef.current.get(fullViewId)
    if (g && !recs.current.get(fullViewId)?.attached) { void attachBoard(g); idle = 0 }
    idle = flushBatch() ? 0 : idle + 1
  }
  if (idle < 4) raf = requestAnimationFrame(tick)
  else raf = 0
}
```

A window-resize listener (or a separate `ResizeObserver` on the modal frame) would restart the loop when the frame dimensions change, covering the primary use-case the loop was designed for.

## Collision notes: TBD

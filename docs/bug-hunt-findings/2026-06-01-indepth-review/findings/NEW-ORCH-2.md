# NEW-ORCH-2: Opening full view during the exit animation sets fullViewEntering=true with no settle timer — Browser native view stays detached forever

- **Severity:** Medium
- **Category:** full-view portal/LOD
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/Canvas.tsx`, `src/renderer/src/canvas/FullViewModal.tsx`, `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`
- **Assigned:** _(blank)_

## Summary
`openFullView` resets `fullViewEntering=true` to signal that the enter animation is in progress. The `FullViewModal` component schedules a `setTimeout(onEntered, CAMERA_MS+16)` in its enter effect to clear the flag at animation settle. However, that effect has `[onEntered]` as its only dependency; `onEntered` (`handleFullViewEntered`) is a stable `useCallback(..., [])` identity, so the enter effect fires **only once — on the initial mount** of `FullViewModal`.

If the user opens full view (timer T1 scheduled), lets the animation complete (T1 fires, `fullViewEntering=false`), starts closing (exit animation in progress, `fullViewClosing=true`), and then immediately reopens full view (within the 216ms exit window), `openFullView` sets `fullViewClosing=false` (cancelling the exit timer via cleanup) and `fullViewEntering=true`. Because `FullViewModal` never unmounted (the component stays rendered for the whole open/close/reopen cycle), the enter effect does NOT re-fire and no new settle timer is scheduled. `fullViewEntering` stays `true` indefinitely.

`fullViewMotion = fullViewEntering || fullViewClosing` then stays `true` forever. `BrowserPreviewLayer`'s dedicated full-view rAF tick (line 673) is gated on `!fullViewMotionRef.current`, so it skips the native-view attach loop. The Browser board in full view shows only its last snapshot and never displays the live native page.

## Where
`src/renderer/src/canvas/Canvas.tsx`:140–144 — `openFullView` sets `fullViewEntering=true` but cannot schedule a new settle timer:
```ts
const openFullView = useCallback((id: string) => {
  setFullViewClosing(false)
  setFullViewEntering(true)
  setFullViewId(id)
}, [])
```

`src/renderer/src/canvas/FullViewModal.tsx`:46–54 — enter effect fires only on mount (stable `onEntered` dep):
```ts
useEffect(() => {
  const dur = prefersReducedMotion() ? 0 : CAMERA_MS
  const raf = requestAnimationFrame(() => setOpen(true))
  const t = setTimeout(onEntered, dur + 16)
  return () => {
    cancelAnimationFrame(raf)
    clearTimeout(t)
  }
}, [onEntered])   // onEntered is useCallback(...,[]) — stable — effect fires once on mount
```

`src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`:667–683 — full-view rAF tick is gated on `!fullViewMotionRef.current`:
```ts
const tick = (): void => {
  if (!fullViewMotionRef.current) {   // stuck true when fullViewEntering never clears
    const g = geomRef.current.get(fullViewId)
    if (g && !recs.current.get(fullViewId)?.attached) void attachBoard(g)
    flushBatch()
  }
  raf = requestAnimationFrame(tick)
}
```

## How it triggers
1. Open any board in full view. Enter animation plays (T=0..216ms). At T=216, `onEntered` fires, `fullViewEntering=false`.
2. Press Esc (or click the modal close button): `closeFullView()` → `fullViewClosing=true`. Exit animation starts.
3. Within the next 216ms, press Maximize on any board: `openFullView(id)` → `setFullViewClosing(false); setFullViewEntering(true)`.
4. The exit settle timer is cancelled by cleanup. `FullViewModal` stays mounted (never unmounts). The enter effect does NOT re-fire.
5. `fullViewEntering` stays `true`. `fullViewMotion=true`. `fullViewMotionRef.current=true` (synced next render in BrowserPreviewLayer's effect).
6. For a Browser board: the native view is never attached. The board shows a stale snapshot in full view forever (until `hardCloseFullView` is called, e.g., by deleting the board).

For Terminal and Planning boards the stale `fullViewEntering` is only cosmetic (no native-view gate), but the `fullViewMotion` flag is still permanently wrong.

## Verification evidence
`handleFullViewEntered = useCallback(() => setFullViewEntering(false), [])` (Canvas.tsx:157) — stable identity, no deps.

Enter effect dep array `[onEntered]` (FullViewModal.tsx:54) — fires once on mount only.

`fullViewMotion = fullViewEntering || fullViewClosing` (Canvas.tsx:131) — passed to `BrowserPreviewLayer` as prop `fullViewMotion`.

`BrowserPreviewLayer` syncs it to a ref in the focus-change effect: `fullViewMotionRef.current = fullViewMotion` (BrowserPreviewLayer.tsx:650), read inside `tick()` at line 673: `if (!fullViewMotionRef.current)`.

`applyLiveness` (BrowserPreviewLayer.tsx:546–605) similarly respects `fullViewMotionRef.current` at line 562: `if (fullViewMotionRef.current) { if (rec(g.id).exists) closeBoard(g.id) }` — so the stuck `true` also causes the full-view board's view to be closed rather than attached on every `applyLiveness` call.

## Suggested fix direction
Lift the settle timer into `Canvas.tsx`'s `openFullView`. Cancel any pending enter timer and start a fresh one each time `openFullView` is called:

```ts
const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

const openFullView = useCallback((id: string) => {
  if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
  setFullViewClosing(false)
  setFullViewEntering(true)
  setFullViewId(id)
  const dur = prefersReducedMotion() ? 0 : CAMERA_MS
  enterTimerRef.current = setTimeout(() => setFullViewEntering(false), dur + 16)
}, [])

const hardCloseFullView = useCallback(() => {
  if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
  enterTimerRef.current = null
  setFullViewId(null)
  setFullViewClosing(false)
  setFullViewEntering(false)
}, [])
```

Remove the `setTimeout(onEntered, ...)` from `FullViewModal`'s enter effect (keep only `requestAnimationFrame(() => setOpen(true))` for the CSS transition trigger). The `onEntered` prop can then be dropped from `FullViewModal`. This is the same fix that resolves NEW-ORCH-4.

## Collision notes: TBD

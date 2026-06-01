# NEW-ORCH-4: Rapid board-switch in full view shares the original enter-settle timer — new board's fullViewEntering cleared after old board's animation duration, not its own

- **Severity:** Low
- **Category:** full-view portal/LOD
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/Canvas.tsx`, `src/renderer/src/canvas/FullViewModal.tsx`
- **Assigned:** _(blank)_

## Summary
`FullViewModal`'s enter-settle timer (`setTimeout(onEntered, CAMERA_MS + 16)`) is scheduled in an effect that fires only once, on the initial mount of `FullViewModal`. When `openFullView(id)` is called for a second board (without closing first), `FullViewModal` stays mounted (not remounted), the enter effect does not re-fire, and no new timer is scheduled. The `fullViewEntering=true` flag set by the second `openFullView` call will be cleared by the first board's timer at `CAMERA_MS+16` ms from when the FIRST board was opened — which may be substantially less than `CAMERA_MS+16` after the second board was opened.

For a Browser board in full view, `fullViewMotion = fullViewEntering || fullViewClosing` gates the native-view attach in `BrowserPreviewLayer`. A premature `fullViewEntering=false` snap (from the old timer) causes the native view to attach before the enter CSS transition on the modal frame has fully settled — potentially binding to a scale-polluted rect if the OS reports a mid-transform frame. This is the narrower sibling of NEW-ORCH-2 (which covers the close→reopen case; this covers the direct open→open switch).

## Where
`src/renderer/src/canvas/FullViewModal.tsx`:46–54 — enter effect fires once (stable dep):
```ts
useEffect(() => {
  const dur = prefersReducedMotion() ? 0 : CAMERA_MS
  const raf = requestAnimationFrame(() => setOpen(true))
  const t = setTimeout(onEntered, dur + 16)
  return () => {
    cancelAnimationFrame(raf)
    clearTimeout(t)
  }
}, [onEntered])   // onEntered stable → fires only on mount
```

`src/renderer/src/canvas/Canvas.tsx`:140–144 — `openFullView` sets `fullViewEntering=true` with no new timer:
```ts
const openFullView = useCallback((id: string) => {
  setFullViewClosing(false)
  setFullViewEntering(true)   // ← flag set, but no new timer scheduled
  setFullViewId(id)
}, [])
```

## How it triggers
1. T=0: `openFullView('A')`. `FullViewModal` mounts. Enter effect fires, `setTimeout(onEntered, 216)` at T+216ms.
2. T=100ms: Without closing, the user double-clicks a different board B. `openFullView('B')` fires. `fullViewEntering=true`, `fullViewId='B'`.
3. T=216ms: The original timer fires `onEntered()` = `setFullViewEntering(false)`. Board B's enter animation has been running for only 116ms — the CSS transition has not finished.
4. `fullViewMotion` becomes `false` at T+216ms. For Browser boards, `BrowserPreviewLayer`'s `fullViewMotionRef` updates and the rAF tick begins attaching the native view to board B's frame rect — which may still be mid-scale.

Note: direct board-to-board switch without going through close is not easily reachable from normal UI (the modal has no "switch board" affordance), but it IS reachable from the E2E harness (`__canvasE2E.setFullView(id)`) and from the `boardActions.requestFullView` toggle if the user clicks maximize on board B while board A is in full view (since `fullViewIdRef.current !== 'B'` → calls `openFullView('B')` directly).

## Verification evidence
`handleFullViewEntered = useCallback(() => setFullViewEntering(false), [])` (Canvas.tsx:157) — stable identity confirmed.

`requestFullView: (id) => fullViewIdRef.current === id ? closeFullView() : openFullView(id)` (Canvas.tsx:383–384) — calls `openFullView(id)` when a DIFFERENT board's maximize is clicked while another is in full view.

`FullViewModal.tsx:46–54` enter effect — `[onEntered]` dep array, stable closure → single fire on mount.

## Suggested fix direction
The same fix as NEW-ORCH-2 (lifting the enter timer into `Canvas.tsx`'s `openFullView`) resolves both issues simultaneously. When `openFullView` is called, cancel any pending enter timer and start a fresh one:

```ts
const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
const openFullView = useCallback((id: string) => {
  if (enterTimerRef.current) clearTimeout(enterTimerRef.current)
  setFullViewClosing(false)
  setFullViewEntering(true)
  setFullViewId(id)
  enterTimerRef.current = setTimeout(
    () => setFullViewEntering(false),
    prefersReducedMotion() ? 16 : CAMERA_MS + 16
  )
}, [])
```

Remove the `setTimeout(onEntered, ...)` from `FullViewModal`'s enter effect (keep only the `requestAnimationFrame` for the CSS transition trigger). The `entering` prop can be removed from `FullViewModal` if the timer is fully owned by the parent.

## Collision notes: TBD

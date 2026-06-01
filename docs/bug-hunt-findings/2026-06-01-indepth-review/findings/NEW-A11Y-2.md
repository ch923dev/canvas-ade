# NEW-A11Y-2: FullViewModal does not restore focus to the triggering element on close

- **Severity:** Low
- **Category:** accessibility / keyboard
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/Canvas.tsx`, `src/renderer/src/canvas/FullViewModal.tsx`
- **Assigned:** _(blank)_

## Summary

When the full-view modal closes (via Esc, scrim click, or the maximize toggle), focus is not returned to the element that opened it. The ARIA authoring practices for modal dialogs require that focus be restored to the triggering element on close so keyboard users can continue navigating from where they were. After close, focus is dropped into the `window`/`body`, leaving keyboard users stranded at the start of the document's tab order.

## Where

`src/renderer/src/canvas/Canvas.tsx:140-156` — `openFullView` and `closeFullView`/`hardCloseFullView` callbacks contain no code to save or restore `document.activeElement`.

`src/renderer/src/canvas/FullViewModal.tsx:56-66` — the exit-animation `useEffect` calls `onExited` (which unmounts the modal) but never focuses a saved element.

## How it triggers

1. User focuses the maximize button on a board title bar using Tab.
2. User activates it with Enter/Space — full view opens.
3. User presses Esc to exit full view.
4. `closeFullView` → `hardCloseFullView` clears `fullViewId`, unmounting the modal.
5. Focus is not returned to the maximize button. It is lost entirely (lands on `body` or the last focused canvas element).
6. A screen-reader user must re-navigate from the top of the document.

## Verification evidence

```tsx
// Canvas.tsx:140-156 — no activeElement save/restore
const openFullView = useCallback((id: string) => {
  setFullViewClosing(false)
  setFullViewEntering(true)
  setFullViewId(id)
}, [])
const closeFullView = useCallback(() => {
  if (fullViewIdRef.current) setFullViewClosing(true)
}, [])
const hardCloseFullView = useCallback(() => {
  setFullViewId(null)
  setFullViewClosing(false)
  setFullViewEntering(false)
}, [])
```

No `const triggerRef = useRef(document.activeElement)` at open time and no `triggerRef.current?.focus()` at close time anywhere in the component or `FullViewModal`.

## Suggested fix direction

In `openFullView`, capture `document.activeElement as HTMLElement` into a ref before opening the modal. In `handleFullViewExited` (called after the exit animation completes), call `savedTrigger.current?.focus()` to return focus. Since `FullViewModal` already has an `onExited` prop, the restore belongs in `handleFullViewExited` in `Canvas.tsx` to avoid adding extra logic to the modal.

## Collision notes

TBD (computed in INDEX)

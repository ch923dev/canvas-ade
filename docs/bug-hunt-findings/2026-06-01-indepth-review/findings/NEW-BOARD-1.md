# NEW-BOARD-1: Checklist drag permanently over-grows the planning board to the maximum mid-drag extent

- **Severity:** Low
- **Category:** PlanningBoard / element math
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/boards/planning/ChecklistCard.tsx`, `src/renderer/src/canvas/boards/PlanningBoard.tsx`, `src/renderer/src/store/canvasStore.ts`
- **Assigned:** _(blank)_

## Summary

When a checklist card is dragged downward and then moved back upward before release, the planning board's height is permanently grown to the maximum downward extent reached during the gesture — not the final committed position. Because `growBoardHeight` is intentionally only-grows and never shrinks, every partial down-then-up drag leaves the board taller than the content requires.

## Where

`src/renderer/src/canvas/boards/planning/ChecklistCard.tsx:108-116` — the `onMeasureBottom` `useEffect` has `element.y` as a dependency, so it fires on every render frame during a drag:

```tsx
useEffect(() => {
  const el = cardRef.current
  if (!el || !onMeasureBottom) return
  const report = (): void => onMeasureBottom(element.id, element.y + el.offsetHeight)
  report()
  const ro = new ResizeObserver(report)
  ro.observe(el)
  return () => ro.disconnect()
}, [element.id, element.y, onMeasureBottom])
```

`src/renderer/src/canvas/boards/PlanningBoard.tsx:373-375` — during a drag, `viewElements` holds a translated copy with shifted `y`:

```tsx
const viewElements = dragPos
  ? translateElement(elements, dragPos.id, dragPos.dx, dragPos.dy)
  : elements
```

`src/renderer/src/store/canvasStore.ts:267-278` — `growBoardHeight` only-grows:

```typescript
growBoardHeight: (id, h) =>
  set((s) => {
    let changed = false
    const boards = s.boards.map((b) => {
      if (b.id !== id || b.h >= h) return b
      changed = true
      return { ...b, h }
    })
    return changed ? { boards } : s
  }),
```

## How it triggers

1. Open a planning board in select mode.
2. Start dragging a checklist card downward by, say, 120px.
3. Move the pointer back up to 40px below the start, then release.
4. The committed element lands at +40px from its original position.
5. However, during the drag the translated `element.y` peaked at `original.y + 120`, which triggered `onMeasureBottom` with that larger bottom value and caused `growBoardHeight` to grow the board to accommodate `original.y + 120 + cardHeight + 48`.
6. After the drag the board height stays at that over-grown value even though the element now sits at `original.y + 40`.

The bug requires dragging DOWN then BACK UP within a single gesture. A drag that only goes down is fine (the board grows correctly to the final position).

## Verification evidence

The `viewElements` passed to `ChecklistCard` during drag:

```tsx
// PlanningBoard.tsx:373-375
const viewElements = dragPos
  ? translateElement(elements, dragPos.id, dragPos.dx, dragPos.dy)
  : elements
```

`translateElement` shifts `element.y` by `dragPos.dy` on every pointer-move frame. Each new `element.y` value changes the dep of the `ChecklistCard` effect, which immediately calls `report()` with `element.y + el.offsetHeight`. If `dragPos.dy` exceeds its final committed value at any point, `growBoardHeight` is called with a larger `needed` than the committed position requires. Since `growBoardHeight` only-grows, the excess cannot be undone.

## Suggested fix direction

Skip `onMeasureBottom` calls while a drag is in progress by not passing `onMeasureBottom` (or passing `undefined`) to the `ChecklistCard` when `dragPos` is set for that element's id:

```tsx
onMeasureBottom={dragPos?.id === el.id ? undefined : growForChecklist}
```

Alternatively, record the maximum `dy` reached and only call `growForChecklist` at pointer-up with the final committed position, using a separate `onCommitMeasure` prop. The simpler approach is to suppress the in-drag reporting.

## Collision notes

TBD (computed in INDEX)

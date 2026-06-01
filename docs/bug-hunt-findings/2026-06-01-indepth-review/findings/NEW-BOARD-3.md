# NEW-BOARD-3: ChecklistCard item `onKeyDown` has no `interactive` guard — Enter/Backspace mutate list when a non-select tool is active

- **Severity:** Low
- **Category:** PlanningBoard / ChecklistCard
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/boards/planning/ChecklistCard.tsx`
- **Assigned:** _(blank)_

## Summary

The `onKeyDown` handler on each checklist item input calls `onAddItem` (on Enter) and `onRemoveItem` (on Backspace when empty) without checking the `interactive` prop. The input is `readOnly={!interactive}` which prevents typing, but `readOnly` does NOT suppress `keyDown` events. If a checklist item input retains focus while the user switches to a non-select tool (arrow, pen, note, or check), subsequent Enter or Backspace presses still append or remove items, mutating the checklist in a mode where element interaction is supposed to be disabled.

## Where

`src/renderer/src/canvas/boards/planning/ChecklistCard.tsx:268-282`:

```tsx
onKeyDown={(e) => {
  e.stopPropagation()
  if (e.key === 'Enter') {
    e.preventDefault()
    onAddItem(element.id)
  } else if (e.key === 'Backspace' && item.label.length === 0 && total > 1) {
    e.preventDefault()
    onRemoveItem(element.id, item.id)
  } else if (e.key === 'Backspace' && item.label.length === 0) {
    e.preventDefault()
    e.currentTarget.blur()
  }
}}
```

There is no `if (!interactive) return` guard at the top of this handler.

## How it triggers

1. Open a planning board in select mode.
2. Click into a checklist item input so it has focus.
3. Click the `arrow` (or `pen`, `note`, `check`) tool button in the toolbar. The tool changes, `interactive` becomes `false`, and the item input becomes `readOnly`.
4. The item input still has DOM focus (switching tools does not blur it).
5. Press Enter — `onAddItem(element.id)` is called, appending a new empty item to the checklist. The `appendItem` callback goes through `beginChange()` + `commit()`, writing a new item to the store and persisting it.
6. Press Backspace on the empty newly added item — `onRemoveItem` fires and removes it again.

The `onChangeTitle` handler on the title input in the header has the same pattern (`readOnly={!interactive}` but no `interactive` guard in any key handler), though title editing does not call mutating callbacks on keys — only on change events, which `readOnly` suppresses. The item `onKeyDown` path is unique in calling store-mutating callbacks on keys alone.

## Verification evidence

`interactive` is used as the `readOnly` prop on the item input:

```tsx
// ChecklistCard.tsx:258-259
readOnly={!interactive}
```

And as the guard on `onPointerDown`:

```tsx
// ChecklistCard.tsx:265-267
onPointerDown={(e) => {
  if (interactive) e.stopPropagation()
}}
```

But `onKeyDown` (lines 268-282 above) has no equivalent `if (!interactive) return` guard. Compare with the analogous fix applied in `NoteCard.tsx` which calls `onDelete` on Backspace — that handler also lacks an `interactive` guard (line 176-178 in `NoteCard.tsx`), but note deletion is intentional on Backspace (empty note prune). The checklist case is different because `onAddItem` creates content when the user is in a draw mode.

## Suggested fix direction

Add an early-return guard at the top of the item `onKeyDown`:

```tsx
onKeyDown={(e) => {
  e.stopPropagation()
  if (!interactive) return   // add this line
  if (e.key === 'Enter') { … }
  …
}}
```

## Collision notes

TBD (computed in INDEX)

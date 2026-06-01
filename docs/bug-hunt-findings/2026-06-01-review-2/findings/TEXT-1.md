# TEXT-1: Empty free-text Backspace delete missing `!interactive` guard

- **Severity:** Nit
- **Category:** whiteboard / code-consistency
- **Status:** CONFIRMED (code), impact negligible
- **Files touched:** `src/renderer/src/canvas/boards/planning/FreeText.tsx`
- **Assigned:** _(blank)_

## Summary
`FreeText` textarea `onKeyDown` (`166-169`) calls `onDelete(element.id)` on Backspace when
`element.text.length === 0`, with **no `if (!interactive) return` guard** — identical pattern to NOTE-1. Every
other interaction in the file guards on `interactive` (pointerDown `164`, grip `107`). `readOnly={!interactive}`
(`150`) blocks typing but not keyDown.

## Where
```ts
onKeyDown={(e) => {
  e.stopPropagation()
  if (e.key === 'Backspace' && element.text.length === 0) onDelete(element.id)   // no interactive guard
}}
```

## Why impact is negligible
The empty textarea only receives focus in select mode (`line 64`). Leaving select mode goes through a toolbar
`onClick`; the toolbar `IconBtn onMouseDown` (`BoardFrame.tsx:124-127`) calls `stopPropagation()` but not
`preventDefault()`, so it blurs the focused textarea → `onBlur` prunes the empty element (`159-161`) **before**
`interactive` flips false. So an empty text element cannot survive into non-interactive mode with retained
focus. Latent defense-in-depth gap, not a live defect. No test covers it.

## Suggested fix direction
Add `if (!interactive) return` at the top of `onKeyDown`. Batch with NOTE-1.

## Collision notes
Lane D (with NOTE-1).

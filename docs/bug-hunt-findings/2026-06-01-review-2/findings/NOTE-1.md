# NOTE-1: Empty-note Backspace delete missing `!interactive` guard

- **Severity:** Nit
- **Category:** whiteboard / code-consistency
- **Status:** CONFIRMED (code), impact negligible
- **Files touched:** `src/renderer/src/canvas/boards/planning/NoteCard.tsx`
- **Assigned:** _(blank)_

## Summary
`NoteCard` textarea `onKeyDown` (`175-178`) calls `onDelete(note.id)` on Backspace when `note.text.length === 0`,
with **no `if (!interactive) return` guard**. `readOnly={!interactive}` (`line 160`) blocks typing but not
keyDown events, so in a non-select tool (pen/arrow) a retained-focus empty note can be deleted by Backspace.

## Where
```ts
onKeyDown={(e) => {
  e.stopPropagation()
  if (e.key === 'Backspace' && note.text.length === 0) onDelete(note.id)   // no interactive guard
}}
```
Mirrors the guard-less pattern in `ChecklistCard.tsx:268-278` (known BOARD-3).

## Why impact is negligible
- Only deletes an **empty** note (no data loss).
- Pruning empty notes is **designed** behavior — onBlur (`168-170`) and pointer-up prune (`147-149`) already
  delete empty notes. Switching tools blurs the textarea → onBlur prunes it anyway, so an empty note rarely
  survives into non-interactive mode with retained focus.

## Suggested fix direction
Add `if (!interactive) return` at the top of the `onKeyDown` handler (consistency with other guarded
interactions in the file). Batch with TEXT-1.

## Collision notes
Lane D (with TEXT-1).

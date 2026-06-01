# NEW-A11Y-6: Checklist toggle button exposes no machine-readable checked state (aria-checked missing)

- **Severity:** Low
- **Category:** accessibility / ARIA
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/boards/planning/ChecklistCard.tsx`
- **Assigned:** _(blank)_

## Summary

Each checklist item renders a `<button>` that toggles the item's done/undone state. The button's accessible name changes between `"Mark done"` and `"Mark not done"` (via the `title` attribute), which communicates the *action* to be taken, but there is no `aria-checked` (or `aria-pressed`) attribute that communicates the *current state*. Screen readers following the button-role contract cannot announce "checked" or "unchecked"; they announce only the label (the action about to be taken). The actual checked state is conveyed purely through color (blue filled `--accent` background vs transparent) and a visual check icon — both color-only signals. WCAG 1.4.1 (Use of Color) requires that color not be the sole means of conveying information.

## Where

`src/renderer/src/canvas/boards/planning/ChecklistCard.tsx:233-255` — the toggle `<button>` element.

`src/renderer/src/canvas/boards/planning/ChecklistCard.tsx:58-77` — the `Checkbox` component, which is a `<span>` child of the button with no semantic state attributes.

## How it triggers

A screen-reader user navigating the checklist presses the toggle button. The AT announces "Mark done, button" (or similar). After activation, the AT must re-visit the button to discover that the title has changed to "Mark not done" — but the AT does not announce the state change because no live region or aria state flipped. When the user re-visits, they hear "Mark not done, button" and must infer the state from the label wording alone, with no "checked" / "unchecked" semantics in the accessibility tree.

## Verification evidence

```tsx
// ChecklistCard.tsx:233-255 — button with title but no aria-checked
<button
  type="button"
  title={item.done ? 'Mark not done' : 'Mark done'}
  onPointerDown={(e) => {
    if (interactive) e.stopPropagation()
  }}
  onClick={(e) => {
    e.stopPropagation()
    onToggle(element.id, item.id)
  }}
  style={{
    border: 'none',
    background: 'none',
    padding: 0,
    cursor: 'pointer',
    display: 'flex',
    flex: 'none'
  }}
>
  <Checkbox done={item.done} />
</button>
```

```tsx
// ChecklistCard.tsx:58-77 — visual state in <span>, no aria attribute
function Checkbox({ done }: { done: boolean }): ReactElement {
  return (
    <span
      style={{
        ...
        border: `1.5px solid ${done ? 'var(--accent)' : 'var(--border-strong)'}`,
        background: done ? 'var(--accent)' : 'transparent',
        ...
      }}
    >
      {done && <Icon name="check" size={11} sw={2.4} />}
    </span>
  )
}
```

No `aria-checked`, `aria-pressed`, or `role="checkbox"` anywhere in this render path.

## Suggested fix direction

Add `aria-checked={item.done}` to the toggle `<button>` (or use `role="checkbox"` + `aria-checked` on a wrapper that handles keyboard activation). Keep the existing `title` for sighted tooltip but make the state machine-readable. Alternatively, add `aria-label` that includes both the item label and state: `aria-label={`${item.label}: ${item.done ? 'done' : 'not done'}`}`.

## Collision notes

TBD (computed in INDEX)

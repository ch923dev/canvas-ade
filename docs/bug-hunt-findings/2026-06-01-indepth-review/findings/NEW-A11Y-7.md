# NEW-A11Y-7: Inline CSS transitions in planning board elements not gated on prefersReducedMotion()

- **Severity:** Low
- **Category:** accessibility / reduced-motion
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/boards/planning/ChecklistCard.tsx`
- **Assigned:** _(blank)_

## Summary

The checklist progress bar fill uses an inline-style `transition: 'width .18s'` that animates the progress bar width whenever items are toggled. This transition is not gated by `prefersReducedMotion()` in JS nor covered by the CSS `@media (prefers-reduced-motion: reduce)` block in `index.css`. By contrast, `BoardFrame.tsx:394-396` explicitly strips the `box-shadow` segment from its inline transition under reduced motion. The inconsistency means that for users who have requested reduced motion, the checklist progress bar still plays a width-expansion animation — violating the spirit (and potentially the letter) of WCAG 2.3.3 (Animation from Interactions).

## Where

`src/renderer/src/canvas/boards/planning/ChecklistCard.tsx:220-223` — inline style `transition: 'width .18s'` on the progress bar fill `<div>`.

`src/renderer/src/index.css:218-231` — the `@media (prefers-reduced-motion: reduce)` block; does NOT include a rule suppressing the checklist progress bar transition.

`src/renderer/src/canvas/BoardFrame.tsx:394-396` — the pattern that IS correctly implemented:
```tsx
transition: prefersReducedMotion()
  ? 'opacity .15s, border-color .1s'
  : 'opacity .15s, border-color .1s, box-shadow .12s ease-out'
```

## How it triggers

1. User has `prefers-reduced-motion: reduce` set in their OS.
2. User toggles checklist items in a planning board.
3. The progress bar fill animates its width with a 180ms ease transition on every toggle.
4. The same user sees the `.ca-progress-bar` indeterminate animation suppressed (correctly) and `BoardFrame` box-shadow suppressed (correctly), but the checklist progress bar still plays its width animation.

## Verification evidence

```tsx
// ChecklistCard.tsx:220-223 — unconditional transition
<div
  style={{
    width: `${pct}%`,
    height: '100%',
    background: 'var(--accent)',
    transition: 'width .18s'    // not gated
  }}
/>
```

```tsx
// BoardFrame.tsx:394-396 — correctly gated transition for comparison
transition: prefersReducedMotion()
  ? 'opacity .15s, border-color .1s'
  : 'opacity .15s, border-color .1s, box-shadow .12s ease-out'
```

```css
/* index.css:218-231 — reduced-motion block does not mention the checklist */
@media (prefers-reduced-motion: reduce) {
  .ca-progress-bar,
  .ca-blink,
  .ca-caret-run,
  .ca-pulse,
  .react-flow__resize-control.handle {
    animation: none !important;
  }
  .fullview-scrim,
  .fullview-frame {
    transition: none !important;
  }
}
```

No entry for the checklist progress bar fill's `width` transition.

## Suggested fix direction

Import `prefersReducedMotion` from `../../lib/motion` in `ChecklistCard.tsx` and gate the transition:
```tsx
transition: prefersReducedMotion() ? undefined : 'width .18s'
```
Alternatively, move the progress bar styles to a CSS class and add a suppression rule to the existing `@media (prefers-reduced-motion: reduce)` block in `index.css`.

## Collision notes

TBD (computed in INDEX)

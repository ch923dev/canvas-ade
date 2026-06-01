# NEW-A11Y-1: FullViewModal has no focus trap — Tab exits the modal into background canvas

- **Severity:** Medium
- **Category:** accessibility / keyboard
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/FullViewModal.tsx`
- **Assigned:** _(blank)_

## Summary

`FullViewModal` renders a full-screen overlay (`fullview-scrim`) but implements no focus trap. A keyboard user pressing Tab while inside the full-view modal will cycle through focusable elements behind the scrim (React Flow nodes, title bar buttons, dock buttons, camera cluster) without any barrier. The ARIA modal pattern requires that focus be confined to the dialog while it is open.

## Where

`src/renderer/src/canvas/FullViewModal.tsx:68-82` — the entire component is a `<div className="fullview-scrim">` with a frame and host child. No Tab-key listener, no sentinel elements, no `inert` attribute on background content.

## How it triggers

1. User opens full view via the maximize button or the ⋯ menu Full view item.
2. User presses Tab to navigate inside the modal (e.g. through the board's title-bar controls).
3. After exhausting focusable elements inside the portaled board, Tab cycles past the scrim boundary and lands on canvas-level controls (dock buttons, camera cluster, etc.) that are visually hidden behind the 66%-black scrim.
4. The user has no way to tell they have left the modal.

## Verification evidence

```tsx
// FullViewModal.tsx:68-82 — no Tab guard, no inert, no sentinel
return (
  <div
    className="fullview-scrim"
    data-open={open ? '' : undefined}
    onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose()
    }}
  >
    <div className="fullview-frame" onMouseDown={(e) => e.stopPropagation()}>
      <div className="fullview-host" ref={setHostEl} />
    </div>
  </div>
)
```

The scrim does not prevent keyboard navigation from reaching elements outside the frame. There is no `role="dialog"`, no `aria-modal`, and no focus management code in the file.

## Suggested fix direction

Add `role="dialog"` and `aria-modal="true"` to the `.fullview-frame` element (see also NEW-A11Y-8). Implement a focus trap via a `keydown` Tab listener that cycles between the first and last focusable children of `.fullview-frame`, or use two invisible sentinel elements with `tabIndex={0}` at the start and end of the frame that redirect focus. Also move focus to the first focusable element inside the frame after the enter animation settles (`onEntered`). The existing lifecycle callbacks in `FullViewModal` are the natural place for this.

## Collision notes

TBD (computed in INDEX)

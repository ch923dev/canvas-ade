# NEW-A11Y-8: FullViewModal missing role="dialog" and aria-modal — not announced as a dialog by AT

- **Severity:** Low
- **Category:** accessibility / ARIA
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/FullViewModal.tsx`
- **Assigned:** _(blank)_

## Summary

The full-view modal overlay renders a full-screen scrim with a framed board inside, but neither the scrim `<div>` nor the frame `<div>` carries `role="dialog"` or `aria-modal="true"`. Without these attributes, assistive technologies do not recognize the overlay as a modal dialog, do not announce "dialog" to the user when it opens, and do not restrict their virtual-cursor navigation to the dialog's content. This means a screen-reader user's virtual cursor (e.g. NVDA browse mode, VoiceOver spatial navigation) can roam freely through the full DOM — including the board canvas behind the scrim — rather than being confined to the modal.

## Where

`src/renderer/src/canvas/FullViewModal.tsx:68-82` — the `fullview-scrim` div and `fullview-frame` div have no ARIA dialog attributes.

## How it triggers

1. A screen-reader user activates the full-view maximize button.
2. The `FullViewModal` mounts and animates in.
3. The AT does not announce "dialog" (because no `role="dialog"` is present).
4. The user's virtual cursor navigates into the board content but can also exit past the frame boundary into the canvas because `aria-modal="true"` is absent.
5. In browsers that respect `aria-modal`, the absence means background content remains accessible, defeating the modal pattern.

## Verification evidence

```tsx
// FullViewModal.tsx:68-82 — no role="dialog", no aria-modal
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

Neither `role="dialog"` nor `aria-modal` appears in the component. There is no `aria-label` or `aria-labelledby` that would be required alongside `role="dialog"`.

## Suggested fix direction

Add `role="dialog"` and `aria-modal="true"` to `.fullview-frame`. Add `aria-label` (e.g., the board title passed via a new prop, or a static `"Board — full view"`). This pairs naturally with the focus-trap fix (NEW-A11Y-1) and focus-restoration fix (NEW-A11Y-2), all three of which address the same modal accessibility gap.

## Collision notes

TBD (computed in INDEX)

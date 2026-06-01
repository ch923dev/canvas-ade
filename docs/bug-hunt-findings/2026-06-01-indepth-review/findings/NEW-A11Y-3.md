# NEW-A11Y-3: role="menu" containers have no role="menuitem" on children — invalid ARIA

- **Severity:** Low
- **Category:** accessibility / ARIA
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/BoardFrame.tsx`, `src/renderer/src/canvas/AppChrome.tsx`
- **Assigned:** _(blank)_

## Summary

Both the board ⋯ overflow menu (`BoardMenu`) and the project-switcher dropdown use `role="menu"` on their container `<div>`, but the interactive `<button>` children inside them have no `role="menuitem"`. The WAI-ARIA spec for the `menu` role requires that owned interactive descendants use one of the menu-item roles (`menuitem`, `menuitemcheckbox`, or `menuitemradio`). Without this, assistive technologies treat the container as a menu but cannot identify the individual items as menu items, breaking predictable keyboard navigation patterns (AT arrow-key navigation between menu items expects `role="menuitem"` children).

## Where

`src/renderer/src/canvas/BoardFrame.tsx:217-231` — the `item()` helper renders a plain `<button className="board-menu-item">` with no `role` attribute.

`src/renderer/src/canvas/BoardFrame.tsx:251` — the container `<div role="menu">` wraps these bare buttons.

`src/renderer/src/canvas/AppChrome.tsx:109-118` — `<div className="project-switcher-menu" role="menu">` wraps plain `<button>` elements (recent items + "Open folder…" + "Create project…") with no `role="menuitem"`.

## How it triggers

Any screen reader (NVDA, VoiceOver, JAWS) that announces menu items will not correctly identify the children. When the user opens the ⋯ menu by keyboard and presses Down Arrow, the AT cannot scan forward through `menuitem` owned children. The AT may announce the menu but fall silent on item traversal.

## Verification evidence

```tsx
// BoardFrame.tsx:217-231 — plain <button>, no role="menuitem"
const item = (label: string, danger: boolean, fn?: (e: MouseEvent) => void): ReactElement => (
  <button
    className="board-menu-item"
    data-danger={danger || undefined}
    ...
  >
    {label}
  </button>
)

// BoardFrame.tsx:251 — role="menu" with no menuitem children
<div
  ref={menuRef}
  className="board-menu"
  role="menu"
  ...
>
  {onFull && item('Full view', false, onFull)}
  {onDuplicate && item('Duplicate', false, () => onDuplicate())}
  {onDelete && item('Delete', true, () => onDelete())}
</div>
```

```tsx
// AppChrome.tsx:109 — same pattern
<div className="project-switcher-menu" role="menu">
  {recents.map((r) => (
    <button key={r.path} onClick={() => void openRecent(r.path)} title={r.path}>
      {r.name}
    </button>
  ))}
  ...
</div>
```

Neither set of `<button>` children has `role="menuitem"`.

## Suggested fix direction

Add `role="menuitem"` to every `<button>` inside a `role="menu"` container. In `BoardFrame.tsx` change the `item()` helper to include `role="menuitem"`. In `AppChrome.tsx` add `role="menuitem"` to the recent-project, open-folder, and create-project buttons. Alternatively, replace `role="menu"` with `role="listbox"` / `role="list"` and corresponding child roles if full menu-keyboard semantics (arrow navigation) are not intended.

## Collision notes

TBD (computed in INDEX)

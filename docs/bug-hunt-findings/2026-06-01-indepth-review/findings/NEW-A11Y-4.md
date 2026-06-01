# NEW-A11Y-4: BoardMenu and ProjectSwitcher triggers missing aria-expanded / aria-haspopup

- **Severity:** Low
- **Category:** accessibility / ARIA
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/BoardFrame.tsx`, `src/renderer/src/canvas/AppChrome.tsx`
- **Assigned:** _(blank)_

## Summary

The ⋯ overflow button (`IconBtn name="more"`) that opens the board action menu, and the project-switcher trigger button, do not announce their popup state to assistive technologies. Both expose a visible popover when clicked but have no `aria-expanded` (to signal open/closed state) and no `aria-haspopup` (to signal that a popup menu is attached). Screen-reader users have no way to know that activating these controls opens a menu, or whether the menu is currently open or closed.

## Where

`src/renderer/src/canvas/BoardFrame.tsx:237-245` — the `IconBtn` rendered as the ⋯ trigger has no `aria-expanded` and no `aria-haspopup`. The `active` prop controls visual styling but not ARIA state.

`src/renderer/src/canvas/AppChrome.tsx:89-104` — the project-switcher trigger `<button>` has only a `title="Switch project"` attribute; no `aria-expanded` or `aria-haspopup`.

## How it triggers

A screen-reader user navigating the title bar with Tab arrives at the "More" button. Without `aria-haspopup="menu"` or `aria-expanded`, the AT announces it as a plain button with no indication that activation will open a menu. After activation, the AT does not announce the newly appeared menu because no focus is moved into it (see NEW-A11Y-5).

## Verification evidence

```tsx
// BoardFrame.tsx:237-245 — active prop is visual only, no aria-expanded
<IconBtn
  name="more"
  title="More"
  active={open}          // visual: tints the icon while open
  size={16}
  sw={2.6}
  restColor="var(--text-2)"
  onClick={openMenu}
/>
```

`IconBtn` renders (BoardFrame.tsx:100-145):
```tsx
<button
  title={title}
  onClick={handleClick}
  ...
>
  <Icon name={name} size={size} sw={sw} />
</button>
```

No `aria-expanded` or `aria-haspopup` is applied to the `<button>` element regardless of the `active` prop.

```tsx
// AppChrome.tsx:89-94 — trigger has title but no aria-expanded
<button
  className="project-switcher-trigger"
  style={styles.proj}
  onClick={() => void toggle()}
  title="Switch project"
>
```

The `open` state is held in local state but never reflected as `aria-expanded={open}` on the button.

## Suggested fix direction

For `BoardMenu`: pass `aria-expanded={open}` and `aria-haspopup="menu"` down to the `IconBtn` that acts as the trigger, or wrap it in a containing element that carries these props. For `ProjectSwitcher`: add `aria-expanded={open}` and `aria-haspopup="menu"` to the trigger `<button>`. When the menu opens, move focus to the first menu item (see NEW-A11Y-3 for the related `role="menuitem"` fix).

## Collision notes

TBD (computed in INDEX)

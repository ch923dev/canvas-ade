# NEW-A11Y-5: TerminalConfig popover opens without moving keyboard focus into it

- **Severity:** Low
- **Category:** accessibility / keyboard
- **Status:** CONFIRMED
- **Files touched:** `src/renderer/src/canvas/boards/TerminalConfig.tsx`, `src/renderer/src/canvas/boards/TerminalBoard.tsx`
- **Assigned:** _(blank)_

## Summary

The Terminal Config popover (`TerminalConfig`) opens when the user clicks the settings gear (`IconBtn name="settings"`), but focus is never programmatically moved into the popover. The container `<div>` has `tabIndex={-1}` (making it programmably focusable) but `.focus()` is never called when it mounts. Keyboard users — especially those operating inside the terminal area, where xterm catches all keystrokes — cannot reach the config form without clicking it with a mouse. Additionally, there is no `role="dialog"` or `aria-label` on the container, so AT does not announce it as a dialog.

## Where

`src/renderer/src/canvas/boards/TerminalConfig.tsx:73-84` — the container `<div tabIndex={-1}>` is rendered but no `useEffect(() => { containerRef.current?.focus() }, [])` is called on mount.

`src/renderer/src/canvas/boards/TerminalBoard.tsx:599` — `{configOpen && <TerminalConfig ... />}` — the render gate; no imperative focus call accompanies opening.

## How it triggers

1. User navigates to the settings `IconBtn` using Tab and presses Enter.
2. `setConfigOpen(true)` mounts `TerminalConfig`.
3. Focus remains on the settings button (inside the terminal area where xterm's keydown handler eats all subsequent keystrokes).
4. The user cannot Tab into the popover because xterm's `stopPropagation` on keydown intercepts Tab before it reaches any Tab listener.
5. The popover fields are unreachable by keyboard; Esc (handled in the popover's `onKeyDown`) is also unreachable because xterm has captured focus.

## Verification evidence

```tsx
// TerminalConfig.tsx:73-84 — tabIndex={-1} but no focus() call
return (
  <div
    style={pop}
    className="nowheel"
    tabIndex={-1}               // programmatically focusable...
    onWheel={(e) => e.stopPropagation()}
    onPointerDown={(e) => e.stopPropagation()}
    onKeyDown={(e) => {
      e.stopPropagation()
      if (e.key === 'Escape') onClose()  // ...but never reached by keyboard
    }}
  >
```

There is no `useRef`, no `useEffect`, and no `autoFocus` anywhere in `TerminalConfig.tsx`.

```tsx
// TerminalBoard.tsx:599 — mount-only, no focus side-effect
{configOpen && <TerminalConfig board={board} onClose={() => setConfigOpen(false)} />}
```

## Suggested fix direction

Add a `ref` to the container `<div>` and a `useEffect(() => { ref.current?.focus() }, [])` (empty deps — run once on mount) so focus moves into the popover when it opens. Add `role="dialog"` and `aria-label="Terminal configuration"` to the container for AT context. On close (`onClose`), return focus to the settings button (hold a ref to `document.activeElement` before opening).

## Collision notes

TBD (computed in INDEX)

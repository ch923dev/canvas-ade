# Manual checks - run before pushing

Companion to `TESTING.md`. The e2e matrix + unit/integration suites cover the paths they cover; **this
file is the human checklist for what they don't** - visual correctness, native-view behavior, real-agent
terminal I/O, gesture feel. Running the relevant section before a push is how a refactor or fix avoids
spawning its own follow-up bug task.

## How to use

1. **Before pushing runtime/UI changes:** run the **Core smoke** + every **area** your diff touched.
2. **After shipping something new:** add or update that feature's checks here in the same PR. A feature
   with no manual-check entry is incomplete.
3. Pre-push prints a reminder (`.githooks/pre-push`). Docs-only pushes skip both e2e and this.
4. Keep checks **observable** (a thing you look at), not "it should work" - name the expected pixels/bytes.

Launch: `pnpm dev` (HMR) or `pnpm build && pnpm start`. Watch the devtools console - **zero red errors**
is part of every check.

## Core smoke (every runtime push)

- [ ] App launches to the welcome screen; open a project folder -> canvas renders, no console errors.
- [ ] Create one of each board (Terminal, Browser, Planning) via drag-to-create from the top dock.
- [ ] Pan + zoom: boards track the camera; no jump/flicker; the native Browser view stays glued (no freeze on pan).
- [ ] Save (autosave ~1s or on blur) -> reload the project -> all boards, positions, and content restored.
- [ ] Quit (Ctrl/Cmd+Q) -> no orphaned processes (no stray pty or `WebContentsView` renderer left running).

## Terminal board

- [ ] Spawn -> a real shell prompt appears; the `launchCommand` agent (e.g. `claude`) starts and is interactive.
- [ ] Type + run a command; output renders; resize the board -> grid reflows, no clipped last row/column.
- [ ] Copy a mouse-drag selection and paste it back; **Shift+Enter inserts a newline (LF)**, does not submit.
- [ ] Paste an image / drag a file in -> the path or image reaches the agent.
- [ ] Font resize (if touched): persists per board + sticky default; **no PTY respawn** (scrollback survives).
- [ ] Kill the board -> the child process tree dies (no zombie agent), no console error.

## Browser preview board

- [ ] Set a localhost URL -> the live page renders in the device frame at the right breakpoint.
- [ ] Pan/zoom -> the native view scales as a unit and re-glues on move-end; below ~40% zoom it swaps to
      a snapshot (no live view left stuck on screen).
- [ ] Open >4 browser boards -> only ~4 stay live, far ones become snapshots, no renderer leak.
- [ ] Full-view a browser board -> navigate inside it -> exit full view -> the navigated page survives
      (NOT reset to the board URL).
- [ ] Digest / settings panels are NOT painted over by the native view (occlusion zones honored).

## Planning / whiteboard board

- [ ] Add a note, text, arrow, freehand stroke, and a checklist; toggle a checklist item -> progress bar updates.
- [ ] Text toolbar: font + size changes apply and persist across reload.
- [ ] Eraser, marquee-select, group/ungroup behave; full-view fits the board (camera fit, not a 2nd transform).
- [ ] Export PNG/SVG produces a correct image.

## Board groups

- [ ] Multi-select boards -> Ctrl+G makes a named group box + tab; the tab is clickable (rename / focus / manage).
- [ ] Grouped focus frames the group; add-to-group reflows + animates; remove works.

## Board chrome - inline title edit (D2-A)

- [ ] Double-click a board title (each of the 3 types) -> input swaps in, text preselected; type +
      Enter commits; the new title persists across reload; Ctrl+Z restores the old one.
- [ ] Esc while editing discards the draft (title unchanged); click-away commits like Enter.
- [ ] F2 with one board selected opens the editor; F2 while typing in the terminal (or any
      input/URL bar) does NOT - the key reaches the agent/field instead.
- [ ] Double-click on the title neither drags the board nor double-click-zooms the canvas;
      empty/whitespace text cancels instead of committing.

## Menus / popovers (shared `<Menu>` shell - D1-C)

All six menus run through `canvas/Menu.tsx` (board ⋯ · Tidy picker · project switcher ·
group tab right-click · planning element right-click · terminal well right-click), so one
sweep covers the shell; spot-check at least two different menus per item.

- [ ] Open near the right/bottom screen edge -> the popover flips/clamps fully on-screen (never clipped).
- [ ] ArrowDown/ArrowUp walk the items with a visible focus ring, wrapping at the ends and
      skipping disabled rows; Home/End jump; Enter activates the focused item.
- [ ] Escape closes; clicking outside closes; re-clicking the trigger (⋯ / Tidy / switcher pill)
      closes instead of flickering closed-then-open.
- [ ] Open any menu OVER a live Browser board -> the native view detaches to its snapshot while
      the menu is open and reattaches live on close (the menu is never painted under the preview).
- [ ] Close a menu opened from the terminal well -> focus returns to the terminal (typing resumes
      without a click).

## App feedback (toast island, D1-A)

- [ ] Trigger a transient note (terminal globe with no dev server running) -> a toast appears in the
      bottom-right island, auto-dismisses after ~5s; the X dismisses it immediately.
- [ ] Force a save failure (make the project dir read-only) -> STICKY error toast with Retry; Retry
      after restoring write access clears it; a later successful autosave also clears it.
- [ ] Park a live browser preview under the island, then raise a toast -> the preview demotes to its
      snapshot (the native view must NOT paint over the toasts); dismissing restores it live.
- [ ] Raise >3 toasts -> only 3 visible; a queued one surfaces (with its own full read time) as a
      slot frees.

## Persistence / migration

- [ ] Open a project saved at an older `schemaVersion` -> migration runs, no data loss, re-saves at current version.
- [ ] Corrupt `canvas.json` -> the `.bak` fallback loads.

## Context / MCP (if touched)

- [ ] Reopen a board -> instant Tier-1 digest, then cached Tier-2 LLM prose (with a key set).
- [ ] An MCP client can read `canvas://memory` and `canvas://board/{id}/summary`.

---

### This-push checklist (copy into the PR / commit body)

```
Manual checks run before push:
- [ ] Core smoke
- [ ] <area touched 1> - <what you looked at, result>
- [ ] <area touched 2> - ...
New checks added to MANUAL-CHECKS.md: <yes/no - which>
```

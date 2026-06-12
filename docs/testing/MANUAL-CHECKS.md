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
- [ ] Crisp zoom (native re-raster, FREEZE): wheel-zoom to ~0.97 and release -> the zoom snaps to
      exactly 100% (status % shows 100) and terminal text is pixel-crisp. Settle at 1.3 / 0.8 / 0.6 ->
      text re-rasters NATIVE-sharp at the proportional size once the camera rests (transient blur
      DURING the gesture is expected); a running TUI (e.g. claude) does NOT redraw/reflow on zoom
      (cols/rows frozen). At some zooms a same-background right/bottom gutter appears (integer-cell
      quantization) — fine; the grid must NEVER clip its right/bottom edge. Drag-select at a settled
      0.8: the selection lands on the exact cells under the cursor. Scrollback + the live session
      survive every zoom change (no respawn).
- [ ] Kill the board -> the child process tree dies (no zombie agent), no console error.
- [ ] Config popover (D2-B guard): edit the launch command, press Esc or click away -> "Unsaved
      changes" row arms (no silent discard); Discard closes without persisting; an edit or second
      Esc returns to editing; a clean popover closes straight through.
- [ ] Bare-shell terminal (no launchCommand) -> the first-run hint pill shows bottom-left; clicking
      it opens config; X dismisses it on EVERY board, forever (sticky across restarts).
- [ ] While `starting`, the top sliver runs in its slow/dim variant, then switches to the normal
      run sliver on `running` (static under reduced motion).
- [ ] Restart (with a resumable session) -> menu auto-closes on Esc / outside click / re-click;
      arrow keys walk Resume/New.
- [ ] Flip to recap -> keys/focus land on the recap face (typing does NOT reach the hidden
      terminal); flip back -> typing resumes in xterm without a click.

## Browser preview board

- [ ] Set a localhost URL -> the live page renders in the device frame at the right breakpoint.
- [ ] Pan/zoom -> the native view scales as a unit and re-glues on move-end; below ~40% zoom it swaps to
      a snapshot (no live view left stuck on screen).
- [ ] Open >4 browser boards -> only ~4 stay live, far ones become snapshots, no renderer leak.
- [ ] Full-view a browser board -> navigate inside it -> exit full view -> the navigated page survives
      (NOT reset to the board URL).
- [ ] Digest / settings panels are NOT painted over by the native view (occlusion zones honored).
- [ ] (D2-C) Kill the preview's renderer (or load a page that crashes it) -> "Preview crashed" +
      Reload CTA, status word `crashed`; Reload reconnects without resetting the board URL/session.
- [ ] (D2-C) Open >4 browser boards -> the evicted (renderer-freed) ones show the "paused" badge +
      `paused` status word; freeing a slot (delete/zoom away another) clears the badge on reattach.
- [ ] (D2-C) Type a junk URL (no scheme/host) + Enter -> red field + inline "Needs an http(s)://host
      URL" in the bar (never over the stage); fixing it commits and clears.
- [ ] (D2-C) Link a terminal whose dev server prints a URL -> when auto-push rewrites the URL bar it
      flashes accent for ~600ms (a user's own committed edit must NOT flash).
- [ ] (D2-C) Evicted board reattach (zoom back in / slot frees) -> the snapshot stays painted until
      the page is ready — NO blank white frame while the fresh renderer loads.
- [ ] (D2-C) Connection dot always has its status word beside it (connected / connecting / failed to
      load / crashed / paused / not connected).

## Planning / whiteboard board

- [ ] Add a note, text, arrow, freehand stroke, and a checklist; toggle a checklist item -> progress bar updates.
- [ ] Text toolbar: font + size changes apply and persist across reload.
- [ ] Eraser, marquee-select, group/ungroup behave; full-view fits the board (camera fit, not a 2nd transform).
- [ ] Export PNG/SVG produces a correct image.

### Arrow endpoint editing (D3-B)

- [ ] Select exactly one arrow (select tool) -> two hollow accent-ring handles appear on its
      endpoints; crosshair cursor over them. Multi-select, a locked arrow, or any non-select
      tool -> no handles.
- [ ] Drag the head handle -> the bezier + arrowhead re-bow live under the cursor; release ->
      the new shape persists; ONE Ctrl+Z restores the old shape (and a tap on a handle without
      dragging adds no undo step).
- [ ] Works zoomed in/out (handles scale with the camera; the drop lands under the cursor) and
      after dragging the whole arrow first.

## Planning keyboard (D3-C)

- [ ] Click a note's grip ring -> arrows nudge it 1px, Shift+arrow 10px; press-and-hold then ONE
      Ctrl+Z restores the pre-burst position (a burst = one undo step).
- [ ] Nudge a grouped element -> the whole group moves; a locked member stays put.
- [ ] Marquee two elements -> Ctrl+G groups, Ctrl+Shift+G ungroups; with the well focused the
      canvas-level BOARD-group Ctrl+G must NOT fire; with canvas focus (click empty canvas,
      multi-select boards) board-grouping still works.
- [ ] With an element selected, Shift+F10 (or the Menu key) opens the element context menu near
      the selection; arrows walk the items; Escape closes and the well keeps focus.
- [ ] Arrows while typing in a note/checklist/text field move the CARET, never the element.
- [ ] A screen reader (or DOM inspect) announces checklist toggles as checkboxes with checked
      state (`role="checkbox"` + `aria-checked`), labelled by the item text.

## Command palette (D4-A)

- [ ] Ctrl+K opens the palette focused; typing filters; Enter runs the active row (e.g. "New
      terminal board" creates + selects a board); Esc closes; Ctrl+K again toggles closed.
- [ ] Ctrl+K still opens while typing in a note/URL/title input — but a FOCUSED terminal keeps
      Ctrl+K for the agent (click the xterm well first to verify it does NOT open).
- [ ] `?` (canvas focus) opens the shortcuts sheet; filter narrows; ← / Backspace-on-empty
      returns to commands; chips match the real keys (spot-check 2-3 listed chords).
- [ ] Selected-board rows appear only with a single selection (rename/duplicate/delete/full
      view; restart rows on a terminal; export rows on a planning board); "Restart: resume"
      only when the board has a known agent session.
- [ ] With full view open: Ctrl+K -> palette; first Esc closes the PALETTE (full view stays),
      second Esc exits full view.
- [ ] With a live preview on screen: palette open -> native view drops to its snapshot;
      close -> live again (ADR 0002).
- [ ] "Rename board" verb: palette closes, the title editor opens FOCUSED; Enter commits.

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

## Motion (LOD crossfade + reduced-motion, D2-D)

- [ ] Zoom slowly across the 40% LOD threshold over a browser/planning board -> the card/detail
      swap is a ~100ms fade in BOTH directions, not a snap; rapid wheel back-and-forth across the
      threshold never strands a half-faded layer or a blank board.
- [ ] Zoom out over a live terminal -> the LOD card fades in over the chrome; zoom back in -> the
      session is alive (typing works). Terminal zoom-in is an instant reveal (accepted asymmetry).
- [ ] Focus a board (full view / grouped focus) -> other boards dim with a soft ~120ms ease, and
      un-dim the same way; works at LOD zoom too.
- [ ] With OS reduced-motion ON (Settings > Accessibility): the LOD swap is instant (no fade, no
      lingering overlay), focus-dim is instant, button/dock hovers don't ease, the checklist
      progress bar jumps (no width animation), and the checkbox fill doesn't ease.
- [ ] Reduced-motion must NOT break correctness: previews still detach to snapshots during motion
      and reattach on settle; resize handles still drop the instant LOD is entered.

## Keyboard-first canvas (D4-B)

- [ ] Click empty canvas, press Tab repeatedly -> selection ring walks the boards in reading order
      (top-to-bottom, left-to-right) and wraps; Shift+Tab reverses. An off-screen target scrolls
      into view (camera centers, zoom kept).
- [ ] With a board selected: arrows move it 1px, Shift+arrows 10px; HOLD an arrow (key-repeat),
      release, then Ctrl+Z once -> the WHOLE burst undoes in one step.
- [ ] Alt+arrows resize (right/down grow, left/up shrink; Shift = 10px); shrinking stops at the
      240x160 minimum; Ctrl+Z restores in one step per burst.
- [ ] Enter on a selected board -> the double-click focus fit (camera fits, others dim; terminal/
      browser cap at 100% zoom); Esc exits focus + clears selection; F2 renames (single selection).
- [ ] The `?` sheet lists the Boards rows: cycle / move / resize / focus / preview focus-return.
- [ ] Negative gates: Tab or arrows pressed while typing in an input, in a focused xterm, in a
      focused planning well (element nudge fires instead), or with a Modal/Menu open -> board
      selection and geometry never change; native Tab order inside chrome/menus keeps working.
- [ ] A3 focus-return: click INTO a live browser preview page (keyboard now goes to the page),
      press Esc -> focus returns to the app, the board shows the selection ring, and Tab/arrows
      work immediately; in full view the same Esc exits full view. A page that listens for Esc
      (e.g. closes its own dialog) still receives the key.

## Wayfinding minimap (D4-C)

- [ ] Press `M` on the canvas -> the minimap island fades in bottom-right (raised surface, board
      rects, accent viewport ring); `M` again hides it. Quit + relaunch -> the choice persisted.
- [ ] Ctrl+K -> "Toggle minimap" does the same; the `?` sheet lists the `M` row.
- [ ] Click a board's rect in the minimap -> the camera fits that board (same focus as
      double-click/Enter: others dim, terminal/browser cap at 100%); click empty map space ->
      the camera teleports there at the current zoom; drag the viewport ring -> live pan.
- [ ] With reduced motion ON: the fade-in is instant and minimap jumps/teleports don't animate.
- [ ] Park a LIVE browser preview over the bottom-right corner, press `M` -> the preview demotes
      to its snapshot under the island (no native paint-over); hide the minimap -> live again.
- [ ] Trigger a toast (e.g. export a planning board) with the minimap visible -> the toast stack
      sits ABOVE the island, neither covers the other.
- [ ] Negative gates: `M` typed in a board title edit, a note, a focused xterm, or the palette
      search does NOT toggle the island.
- [ ] Esc layering unchanged: with the minimap up, Esc still clears selection / exits full view
      on the first press; the island never closes on Esc (persistent chrome).

## Persistence / migration

- [ ] Open a project saved at an older `schemaVersion` -> migration runs, no data loss, re-saves at current version.
- [ ] Corrupt `canvas.json` -> the `.bak` fallback loads.

## Welcome screen — recents removal

- [ ] Hover a recent row -> the ✕ appears (only on the hovered row); click it -> the entry leaves
      the list, the project folder on disk is UNTOUCHED, and no open pipeline starts.
- [ ] Tab to a row's ✕ (keyboard only) -> it becomes visible on focus and Enter removes the row.
- [ ] `Clear all` -> the whole recents section disappears; relaunch -> still empty; opening any
      project re-adds it to the list.
- [ ] Remove the MOST-RECENT entry, quit, relaunch -> the app no longer auto-reopens that project
      (auto-reopen follows the new list head, or shows the welcome screen if empty).

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

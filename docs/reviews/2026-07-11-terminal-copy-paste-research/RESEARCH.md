# Why copy fails while the agent is streaming

**Scope:** Expanse desktop terminal boards — `@xterm/xterm` (resolved **5.5.0 exactly**, verified in `expanse-desktop/node_modules/@xterm/xterm/package.json`), DOM renderer, node-pty in MAIN, React Flow canvas host, custom copy/paste layer. All claims below are tied either to fetched upstream sources or to recon `file:line` in our code. Low-confidence, unsourced speculation from the research (e.g. "MAIN event-loop contention delays OpenClipboard retries") has been dropped; it survives only as an open question.

## TL;DR

- **Primary cause: the agent itself turns off selection.** Claude Code (≥2.1.150) enables xterm mouse-tracking (DECSET 1000/1002/1003/1006) while running — during permission prompts, pickers, and always in its now-default fullscreen/alt-screen renderer. In our exact xterm 5.5.0, every such toggle synchronously calls `SelectionService.disable()` → `clearSelection()` and blocks new plain-click selections until tracking turns off. This is stock xterm behavior, maintainer-confirmed on both sides (xterm.js source at the 5.5.0 tag; anthropics/claude-code #61936, #23581).
- **Our own code makes a failed copy worse:** when the selection has been wiped between mouseup and Ctrl+C, our keymap deliberately falls through to xterm's default handling — which sends `\x03` **SIGINT to the running agent** and (via xterm's `onUserInput` listener) destroys any remaining selection (`terminalKeymap.ts:117-122`, `useTerminalSpawn.ts:791-810`).
- **"Copy grabs nothing / wrong text" has a second, silent mechanism:** xterm stores a selection as buffer coordinates, never text. Ink redraws rewrite the cells under an intact-looking highlight; `getSelection()` at copy time reads whatever is there *now*. Plus our clipboard write is fire-and-forget (`void window.api.clipboard.writeText(sel)` then unconditional `clearSelection()`, `useTerminalSpawn.ts:800-801`) with a main-process handler that always returns `true`.
- **A canvas-level trap undermines the standard workaround:** React Flow 12.11.0's Pane swallows any Shift-held pointerdown inside a node (capture-phase `stopPropagation`+`preventDefault`) because `selectionKeyCode` defaults to `'Shift'` and we never override it — the *same Shift* that xterm and Claude Code's own docs tell users to hold to force selection. A known upstream bug (#4021) can leave that flag stuck `true`.
- **Fix order:** (1) snapshot selection text on `onSelectionChange` and copy from the snapshot; (2) never fall through to SIGINT on a failed copy; (3) verify clipboard writes before clearing selection; (4) `selectionKeyCode={null}` on `<ReactFlow>`; (5) spawn Claude Code with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`; (6) surface a Shift-to-select hint when `term.modes.mouseTrackingMode !== 'none'`.

---

## Root causes, ranked by likelihood for our code

### 1. Child TUI mouse-tracking toggles wipe and disable selection (HIGH confidence — verified at our exact version)

**Mechanism.** In xterm 5.5.0's `Terminal.ts:721-733` (verified at the 5.5.0 git tag, the version we resolve), `coreMouseService.onProtocolChange` fires on **every** DECSET/DECRST mouse-mode change the child sends, and calls `this._selectionService.disable()` when any protocol activates. `SelectionService.disable()` (5.5.0 `SelectionService.ts:165-168`) is `clearSelection(); this._enabled = false;` — an active, synchronous wipe of whatever the user has selected, plus a block on starting new plain-click selections (`handleMouseDown` refuses unless `shouldForceSelection(event)`, i.e. Shift held).

**Who toggles it.** Claude Code's Ink TUI enables SGR mouse tracking during interactive prompts (anthropics/claude-code #27995), and continuously in its fullscreen/alt-screen renderer, which became the *default* at v2.1.150 (maintainer thomasballinger on #61936: "this was from defaulting to `/tui fullscreen`"). Issues #23581, #59720, #64214 confirm the exact sequences (`?1000h`, `?1003h`, `?1006h`). Anthropic's own docs (code.claude.com/docs/en/fullscreen) acknowledge: "When Claude Code captures mouse events, your terminal's native copy-on-select stops working."

**Compounding sub-mechanism: mouse reports are "user input."** `CoreMouseService.triggerMouseEvent` calls `triggerDataEvent(report, true)` (5.5.0 `CoreMouseService.ts:284`), and `SelectionService`'s constructor listens: `onUserInput(() => { if (this.hasSelection) this.clearSelection(); })` (`SelectionService.ts:139-143`). Under any-event mode (1003), **merely moving the mouse** after finishing a drag generates a report that wipes the selection before Ctrl+C ever lands. Alt-screen entry/exit is a third independent wipe: `_handleBufferActivate` unconditionally calls `clearSelection()` (`SelectionService.ts:751-758`).

**Our recon fit.** We already read the exact signal — `term.modes.mouseTrackingMode !== 'none'` at `TerminalBoard.tsx:503-513` — but only to gate the right-click menu. Nothing protects left-drag selection, warns the user, or caches the selection text. The `installSelectionShim` (`terminalSelection.ts`) doesn't check tracking mode at all and is a no-op at zoom 1.

**Why the intermittency matches.** Tracking toggles with the agent's *interactive state*: on during prompts/fullscreen redraw windows, off between them. A selection made in a gap survives; one straddling a toggle (or made while `_enabled === false`, where the drag draws nothing real) fails. Idle agent = no toggles = copy always works. This is the only mechanism that explains "usually fails while running, always works idle" without any resize, scroll, or clipboard involvement — and it's independently corroborated cross-vendor (Warp #2758 hit the identical class with a non-xterm engine).

### 2. Our SIGINT fallthrough converts a failed copy into a destroyed selection + interrupted agent (HIGH — deterministic from verified pieces)

**Mechanism.** `terminalKeymap.ts:70-74` resolves Ctrl/Cmd+C to copy only `if (ctx.hasSelection)`; and per `terminalKeymap.ts:117-122`, when the copy effect's `getSelection()` comes back empty, we do **not** `preventDefault()` — the keystroke reaches xterm's default handling, which sends `\x03` through `CoreService.triggerDataEvent('\x03', true)`. That fires `onUserInput` → `clearSelection()` (root cause 1's listener) **and** delivers a real SIGINT to the running agent's process.

**Evidence.** Both halves independently verified: our keymap behavior from recon (`useTerminalSpawn.ts:791-810`, `terminalKeymap.ts:84-86,106-107,117-119`), xterm's `onUserInput` clear from 5.5.0 source. Note the recon's caveat stands: today `hasSelection()` and `getSelection()` are read synchronously in the same stack, so the two reads rarely *disagree with each other* — the danger is when root cause 1 wiped the selection **before keydown**, making `hasSelection` false and routing the keystroke straight to SIGINT.

**Why the intermittency matches.** Every occurrence of root cause 1 in the moment before Ctrl+C produces this outcome. From the user's view: "I selected text, pressed Ctrl+C, the highlight vanished, nothing copied" — and, invisibly, their agent turn may have been cancelled. This elevates severity beyond a copy annoyance.

### 3. Stale-content copy: selection is coordinates, Ink rewrites the cells underneath (HIGH — source-verified mechanism; explains "wrong/empty text" without visual glitch)

**Mechanism.** xterm's `SelectionModel` stores only absolute buffer (row,col); `selectionText` (`SelectionService.ts:203-262`) live-reads `translateBufferLineToString` at call time. This was a deliberate 2017 rewrite (issue #468 → PR #670) so redraws *don't* clear selection — the flip side is there is zero "content changed under selection" invalidation. The DOM renderer's highlight is an independent overlay (`DomRenderer.ts` `_selectionContainer`, repainted only via `SelectionService.onRequestRedraw`), so the highlight can sit visually undisturbed over rows whose characters an Ink repaint (CUU + erase-line + rewrite, delivered in one coalesced `term.write`) has silently replaced. Ctrl+C then copies the *new* content — a different spinner frame, a blank-padded shortened line — not what the user highlighted.

**Our recon fit.** Our coalescer flushes once per rAF (`terminalWriteCoalescer.ts:74-84`, `useTerminalSpawn.ts:829-848`) — high-frequency in-place rewrites of the exact rows a user tends to select (the agent's most recent output) are our normal streaming regime.

**Why the intermittency matches.** Race between drag-end and Ctrl+C vs. the next Ink frame touching those rows. Selecting stable scrolled-back text works; selecting the actively-repainting region usually returns garbage or blanks. Explains the "copy grabs nothing" half of the symptom even when the highlight *doesn't* vanish.

**Resolved contradiction:** one researcher framed "redraw clears selection" as the cause; exhaustive reading of the 5.5.0/master `SelectionService` constructor shows exactly four proactive clears (user input, buffer-activate, scrollback trim, and — on master only — rowsChanged resize). Plain `term.write()` is *not* one of them. So streaming causes **wrong-content copies** (this cause) but not **vanishing highlights** — vanishing is causes 1/2/5/6.

### 4. Fire-and-forget clipboard write + unconditional clearSelection (HIGH mechanism confidence; frequency on Windows unquantified)

**Mechanism.** `useTerminalSpawn.ts:797-803`: `void window.api.clipboard.writeText(sel)` (promise discarded) then `term.clearSelection()` on the next line, unconditionally. The main-process handler (`clipboardIpc.ts:41-45`) calls Electron's `clipboard.writeText` and returns `true` no matter what. Electron's binding surfaces no success/failure; on Windows, Chromium's `ClipboardWin` guards the write with only a 5-attempt/5ms-sleep `OpenClipboard` retry (~25ms budget, comment in `ui/base/clipboard/clipboard_win.cc` naming `rdpclip.exe`), then **silently drops the write**. Windows Clipboard History (Win+V), RDP, and clipboard managers all reopen the clipboard immediately after every write, creating exactly this contention.

**Why the intermittency matches.** When it fires, the user sees the canonical symptom — highlight cleared by our own line 801, clipboard empty — with zero signal anywhere in the stack. The same "reports success, clipboard empty" class is documented in openai/codex #15663 (X11 ownership drop) and VS Code #42381 (same Electron+xterm stack, still open). Ranked below 1–3 because the streaming correlation is weaker: the researcher's proposed link (MAIN busy pumping PTY delays the write past the contention window) was flagged low-confidence with no fetched source, so we treat this as a real, independent failure mode of *any* copy, streaming or not — cheap to harden regardless.

**Ruled out on this axis:** focus/gesture failures. We never touch `navigator.clipboard` or `execCommand`; the Electron-IPC path is structurally immune to `NotAllowedError: Document is not focused` (electronjs.org clipboard docs; w3c/clipboard-apis#182). Don't chase that.

### 5. Scrollback trim silently destroys selections once the buffer is at cap (MEDIUM — verified code path, conditional trigger)

**Mechanism.** `SelectionModel.handleTrim(amount)` decrements both endpoints' row indices on every scrollback eviction; when `selectionEnd[1] < 0` it calls `clearSelection()` — wired from `buffer.lines.onTrim` in the `SelectionService` constructor. Once a long-running session's buffer is full (our default 2000 lines, `useTerminalSpawn.ts:677`), essentially *every* streamed line trims, marching every active selection toward destruction.

**Why the intermittency matches.** Only fires when scrollback is saturated and the selection sits near the old edge — so it's a contributor for long sessions/small scrollback, not the everyday case. Testable: failures should correlate with session length and scrollback setting (see experiments).

### 6. React Flow's Pane swallows Shift-held mousedowns inside the terminal — sabotaging the standard escape hatch (HIGH for the mechanism, MEDIUM for how often it fires today)

**Mechanism.** Verified by reading our installed `@xyflow/react` 12.11.0 dist: `Pane`'s capture-phase `onPointerDownCapture` (~line 1464) calls `stopPropagation()` + `preventDefault()` on any pointerdown inside a node when `selectionKeyPressed` is true; `preventDefault()` on a primary pointerdown suppresses the synthesized mousedown entirely, so xterm's `SelectionService.handleMouseDown` never runs. `selectionKeyCode` defaults to `'Shift'` (reactflow.dev API reference), tracked globally on `window`, and a grep of `expanse-desktop/src` found zero overrides of `selectionKeyCode`/`selectionOnDrag`/`elementsSelectable` — the path is live at defaults.

**Why this matters doubly:** Shift+drag is *the* documented workaround for root cause 1 (xterm 5.5.0's `shouldForceSelection` returns `event.shiftKey` unconditionally; Claude Code's fullscreen docs and Warp #2758 recommend the same). In our app, that exact gesture is eaten by React Flow before xterm sees it. Worse, xyflow #4021 documents `selectionKeyPressed` getting **stuck true** when a Shift keyup is missed near a menu open — and our terminal UX explicitly binds Shift+right-click to force the context menu (`TerminalBoard.tsx:508-514`). Caveat retained from the gap-fill researcher: our menu is an in-DOM React dropdown, not the native popup #4021 was filed against, so the stuck-flag scenario needs the repro in the experiments section before we blame it for plain (no-Shift) drag failures.

**Ruled out on the React Flow side:** the `nodrag` boundary is correctly placed and provably inert (d3-drag's filter bails with zero side effects before attaching anything — d3-drag `src/drag.js`, xyflow `XYDrag.ts`); and the "CSS transform breaks native text selection" hazard (xyflow discussion #2942) doesn't apply because xterm's selection is a custom model, not native Range.

### 7. Resize-adjacent selection loss (LOW for us today — version-gated and narrow)

**Resolved contradiction:** researcher 1 cited master's `onResize(e => { if (e.rowsChanged) clearSelection(); })` (PR #5423, merged **2025-10-19**, fixing #5300). Our resolved version is **exactly 5.5.0** (confirmed above), which predates it — that handler is **not in our build**. However, our own resize backstop (`useTerminalSpawn.ts:519-559`) calls `term.reset()` mid-stream on column-count drag-resize, which destroys selection regardless of version; and DOM-renderer selection-overlay desync on resize is a still-open upstream bug (#2818, fix PR #2889 closed unmerged). This fires only on an explicit user board-resize, so it can't be the everyday streaming failure — but a user resizing a board "to make the URL fit" mid-stream loses their selection deterministically. Also note: any future bump past 5.5.0 imports the #5423 blunt clear app-wide.

**Fully ruled out:**
- **WebGL renderer mechanisms.** `@xterm/addon-webgl ^0.18` in package.json is inert — addons do nothing unless `loadAddon()` is called (addon-webgl README), the recon greps found no instantiation, and `useTerminalSpawn.ts:742-744` documents the deliberate removal. DOM renderer is definitively active; all glyph-atlas/GPU-selection theories are dead ends.
- **Zoom-shim staleness mid-drag.** `terminalSelection.ts:70-72` re-reads `getZoom()` and `getBoundingClientRect()` fresh on every mousedown/move/up; xterm anchors are zoom-invariant buffer coords. The only acknowledged gap is the ~320ms full-view open/close transition (`useTerminalSpawn.ts:476-478` comment) — real but narrow.
- **Bonus defect found by recon (fix it while we're here):** a double-click to word-select in the terminal bubbles to the stage's `onDoubleClick` at `TerminalBoard.tsx:601-614` and flips the board to the recap face — xterm's helper elements match none of the exclusion selectors and carry no `data-no-flip`.

---

## Fix plan (ordered)

**P0 — ship together; these neutralize the symptom regardless of which cause fired:**

1. **Snapshot the selection eagerly; copy from the snapshot.** Register `term.onSelectionChange(() => { const s = term.getSelection(); if (s) lastSelectionRef.current = { text: s, at: performance.now() }; })` in the spawn effect (`useTerminalSpawn.ts`, near line 791). In the Ctrl+C path and `terminalMenu.ts:40`'s Copy `onSelect`, prefer the live `getSelection()`, but fall back to the snapshot when live is empty and the snapshot is recent (~300ms grace, longer for the context-menu path since the menu was opened *because* a selection existed at `TerminalBoard.tsx:520`). This defeats causes 1, 2, 3, and 5 at the point of copy. This is xterm's sanctioned extension point (maintainers closed #1092 in favor of #1093 = `onSelectionChange` + `getSelection`).
2. **Never fall through to SIGINT on a failed copy.** In `terminalKeymap.ts:117-122`: if `ctx.hasSelection` was true (or a recent snapshot exists) but the copy read came up empty, `preventDefault()` and no-op (or copy the snapshot). Reserve the SIGINT fallthrough strictly for "no selection and no recent snapshot." Kills cause 2 outright.
3. **Verify the clipboard write; clear selection only on success.** In `clipboardIpc.ts:41-45`: after `clipboard.writeText(text)`, `clipboard.readText()` and compare; retry 2–3× with 20–40ms backoff; resolve the actual boolean. In `useTerminalSpawn.ts:797-803`: `await` the result and call `term.clearSelection()` only on `true`; on failure leave the highlight and flash a brief "copy failed" indicator. Do **not** migrate to `navigator.clipboard`/`execCommand` — that would add the focus-gated failure mode we currently don't have.

**P1 — remove the triggers:**

4. **`selectionKeyCode={null}` on `<ReactFlow>`** (or rebind off Shift). One prop; deletes the Pane capture-swallow path (cause 6) and makes the stuck-flag bug moot, and un-breaks the Shift-to-force-select escape hatch that everything else in this plan relies on. If box-select must stay, pick a non-Shift key and add a defensive flag reset on window blur and on terminal-menu close.
5. **Spawn Claude Code with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`** in the PTY env (or expose as a per-board setting). Per user testing on #61936 this is the only env var that restores selection/right-click *and* keeps scrollback; `CLAUDE_CODE_DISABLE_MOUSE=1` kills in-app scrollback and `CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1` has its own open selection-breaking regression (#72173). This removes cause 1 at the source for Claude Code specifically; it's per-agent, not generic.
6. **Surface a hint when `term.modes.mouseTrackingMode !== 'none'`** (we already read this at `TerminalBoard.tsx:503-513`): a small badge/tooltip — "agent is capturing the mouse; hold Shift to select." Also set `macOptionClickForcesSelection: true` in the Terminal constructor (`useTerminalSpawn.ts:660-684`) so Mac users get Option+click parity with VS Code. Note the residual: a Shift-forced selection can still be wiped by a mid-drag protocol re-toggle — which is why P0-1 is the backstop.

**P2 — robustness and polish:**

7. **Opt-in copy-on-select** (VS Code's `terminal.integrated.copyOnSelection` pattern): on `onSelectionChange`, if enabled and `hasSelection()`, copy immediately. Collapses the entire select-then-copy timing window.
8. **Hold the write coalescer during an active drag.** Extend the existing `isLive` gate (`useTerminalSpawn.ts:840`, `terminalWriteCoalescer.ts:111-113`) to also hold flushes from mousedown-in-terminal until mouseup + a short grace. Bytes accumulate (bounded by the existing `holdCap`), nothing is dropped, and Ink can't rewrite the cells under an in-progress selection (cause 3) or trim it away (cause 5) mid-drag. Same pattern the resize backstop already uses.
9. **Fix the double-click flip:** stop `dblclick` propagation on the screenWrap (`TerminalBoard.tsx:686-689`) or add `data-no-flip` so word-select doesn't flip the board (`TerminalBoard.tsx:601-614`).
10. **Resize backstop + selection:** in `fitWhole`/`runBackstopFit` (`useTerminalSpawn.ts:519-559`), snapshot `getSelection()` before `term.resize()`/`term.reset()` and feed it into the same snapshot ref, so a mid-stream board resize doesn't strand a copy.
11. **Track `mouseEventsRequireAlt`** (xterm PR #5953, built for Cursor's identical embedded-agent case; present in 6.1.0-beta.288, absent from 6.0.0 stable and our 5.5.0). When it reaches stable, set it in the constructor so the child's mouse-tracking can never disable selection — after validating the 5.x→6.x bump across all pinned addons. Also re-verify on any bump: PR #5423's rowsChanged clear arrives with it, and the shim's dependence on the getComputedStyle-based cell metrics (#2488 fix) must hold.

## What mature terminals do (and what we should steal)

- **VS Code:** copies at selection-finalize time — `xterm.raw.onSelectionChange(async () => { ... await this.copySelection(); })` gated by `copyOnSelection` (verified in `terminal.clipboard.contribution.ts`). Steal: P0-1's snapshot + P2-7's opt-in mode are exactly this. Also ships `terminal.integrated.macOptionClickForcesSelection` — steal as P1-6. Sobering note: VS Code still has an open issue with our exact symptom (#42381), so there's no complete upstream recipe to copy — the snapshot+verify layers are our own necessary additions.
- **Warp** (non-xterm engine, same bug class, #2758): converged on the same answer — Shift+drag forces host-side selection when the TUI has mouse reporting, matching Alacritty/GNOME Terminal/Konsole convention. Steal: the discoverability hint (P1-6), since the convention already works in xterm 5.5.0 and is undiscoverable in our UI.
- **Claude Code's own fullscreen mode** copies its internal selection "automatically on mouse release" (fullscreen docs) — Anthropic reached copy-on-mouseup too, for the same reason.
- **Cursor** got `mouseEventsRequireAlt` added to xterm upstream (#5952/#5953) for the identical embedded-agent scenario — steal by upgrading when stable (P2-11).

## Link copying specifically (the "agent prints a URL" case)

Three compounding facts, all sourced:

1. **On Windows, the agent almost certainly never emits real OSC 8 hyperlinks.** The `supports-hyperlinks` detection used by Claude Code and by Ink's `terminal-link`/`ink-link` returns false on `win32` unless `WT_SESSION` (Windows Terminal) or `FORCE_HYPERLINK` is set — verified in chalk/supports-hyperlinks `index.js`; Claude Code issues #26356/#42519/#48652 confirm the OSC 8 emission + `FORCE_HYPERLINK` override. Our PTY is ConPTY, not Windows Terminal, so every URL is plain text — leaving only the fragile drag-select path this whole report is about. **Fix: set `FORCE_HYPERLINK=1` in the spawned env.** xterm's OSC 8 support (`OscLinkProvider`) is core and always active — links light up with zero renderer changes.
2. **Default link activation is a footgun.** We set no `linkHandler` and pass no handler to `WebLinksAddon` (recon `useTerminalSpawn.ts:660-684`, addon load at 685-737): a bare click-release inside a detected link fires `window.open()` (web-links) or a modal `confirm()` + `window.open()` (OSC 8) — verified in `WebLinksAddon.ts` / `OscLinkProvider.ts`; xterm's link-handling guide says embedders must add modifier gating themselves. A user drag-selecting a URL whose mouseup lands in the link range can trigger navigation/a focus-stealing dialog instead of a copy. **Fix: custom handlers requiring Ctrl/Cmd+click, routed through `shell.openExternal` via IPC** (matches our CLAUDE.md security rule), never bare `window.open()`.
3. **Link clicks race streaming the same way selection does.** xterm's `Linkifier` clears/re-queries the hovered link on any repaint touching its row and re-derives the mouseup position from live `buffer.ydisp`; a click straddling an Ink redraw silently no-ops (verified in `Linkifier.ts`). And no API exists to copy a link's URL without drag-selecting it (`ILinkProviderOptions` exposes only hover/leave/activate). **Fix: stash the last-hovered link `{text, uri}` in a ref via the hover callback and add a "Copy link" entry to `terminalMenu.ts`** — one right-click, zero dependence on a selection surviving anything. P2-8's coalescer-hold-during-drag stabilizes link clicks for free.

## Open questions / how to confirm each root cause with a quick experiment

1. **Cause 1 (mouse tracking):** add a dev-only log on `term.modes.mouseTrackingMode` transitions (poll or wrap via `onData` of DECSET parsing is overkill — a 250ms poll suffices) during a live Claude Code session; reproduce a failed copy and check whether it lands inside a `!== 'none'` window. Also compare failure rate with `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` set — if failures drop to ~zero, cause 1 dominates.
2. **Cause 2 (SIGINT fallthrough):** log every keymap fallthrough of Ctrl+C while `hasSelection` was recently true; check agent-side for spurious interrupts correlating with user copy attempts.
3. **Cause 3 (stale content):** select a line in the actively-repainting region mid-stream, wait 2s, Ctrl+C — compare copied text to what was highlighted. If it's a later frame's content with an intact highlight, confirmed.
4. **Cause 4 (clipboard):** land the readback-verify in `clipboardIpc.ts` behind a log first — count real-world write/readback mismatches on this machine (Win+V clipboard history on vs. off).
5. **Cause 5 (trim):** set scrollback to 200, fill the buffer, select the top visible line while streaming — the highlight should visibly vanish within seconds. If failures in the field correlate with long sessions, weight fix P2-8 higher.
6. **Cause 6 (React Flow):** (a) Shift+drag to select in a terminal — does xterm receive the mousedown at all? Check whether `.react-flow__pane` gains the `selection` class. (b) Shift+right-click to open the terminal menu, release Shift, dismiss, then try a *plain* drag-select — if it fails until Shift is tapped again, the stuck-flag bug (#4021) reproduces with our in-DOM menu.
7. **Version watch:** on any `@xterm/xterm` bump past 5.5.0, re-test board drag-resize with an active selection (PR #5423's rowsChanged clear arrives) and re-verify the zoom shim against the cell-metrics contract (#2488).
8. **Unconfirmed, deliberately dropped from the ranking:** the "MAIN event-loop PTY contention delays the clipboard write past the OS contention window" link between streaming and clipboard failures — plausible, unsourced. Experiment 4's logging settles whether clipboard failures even correlate with streaming.

## Sources

**xterm.js source & issues**
- https://github.com/xtermjs/xterm.js/blob/5.5.0/src/browser/Terminal.ts
- https://github.com/xtermjs/xterm.js/blob/5.5.0/src/browser/services/SelectionService.ts
- https://raw.githubusercontent.com/xtermjs/xterm.js/master/src/browser/services/SelectionService.ts
- https://raw.githubusercontent.com/xtermjs/xterm.js/master/src/browser/selection/SelectionModel.ts
- https://raw.githubusercontent.com/xtermjs/xterm.js/master/src/common/services/CoreService.ts
- https://raw.githubusercontent.com/xtermjs/xterm.js/master/src/browser/services/MouseService.ts
- https://raw.githubusercontent.com/xtermjs/xterm.js/master/src/common/CoreTerminal.ts
- https://raw.githubusercontent.com/xtermjs/xterm.js/master/src/browser/renderer/dom/DomRenderer.ts
- https://raw.githubusercontent.com/xtermjs/xterm.js/master/src/browser/CoreBrowserTerminal.ts
- https://github.com/xtermjs/xterm.js/blob/master/src/browser/Linkifier.ts
- https://github.com/xtermjs/xterm.js/blob/master/src/browser/OscLinkProvider.ts
- https://github.com/xtermjs/xterm.js/blob/master/src/common/services/OscLinkService.ts
- https://github.com/xtermjs/xterm.js/blob/master/addons/addon-web-links/src/WebLinksAddon.ts
- https://github.com/xtermjs/xterm.js/blob/master/addons/addon-web-links/src/WebLinkProvider.ts
- https://github.com/xtermjs/xterm.js/blob/master/addons/addon-webgl/README.md
- https://github.com/xtermjs/xterm.js/blob/master/src/common/services/OptionsService.ts
- https://github.com/xtermjs/xterm.js/blob/master/typings/xterm.d.ts
- https://xtermjs.org/docs/guides/link-handling/
- Issues/PRs: https://github.com/xtermjs/xterm.js/issues/468 · /issues/318 · /pull/670 · /issues/1092 · /issues/1093 · /issues/2488 · /issues/2584 · /issues/2818 · /pull/2889 · /issues/3242 · /pull/4170 · /issues/5300 · /pull/5423 · /issues/5952 · /pull/5953

**Claude Code / Anthropic**
- https://code.claude.com/docs/en/fullscreen
- https://code.claude.com/docs/en/terminal-config
- https://github.com/anthropics/claude-code/issues/23581 · /27995 · /43942 · /59720 · /61021 · /61936 · /64214 · /70857 · /72173 · /74320
- Hyperlinks: https://github.com/anthropics/claude-code/issues/13008 · /26356 · /42519 · /48652
- https://slyapustin.com/blog/claude-code-no-flicker.html (community; env-var names corroborated by official fullscreen doc)

**Clipboard / Electron / platform**
- https://www.electronjs.org/docs/latest/api/clipboard
- https://chromium.googlesource.com/chromium/src/+/main/ui/base/clipboard/clipboard_win.cc?format=TEXT
- https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openclipboard
- https://github.com/w3c/clipboard-apis/issues/182
- https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand
- https://github.com/openai/codex/issues/15663
- https://github.com/microsoft/vscode/issues/42381

**VS Code / Warp / React Flow / misc**
- https://raw.githubusercontent.com/microsoft/vscode/main/src/vs/workbench/contrib/terminalContrib/clipboard/browser/terminal.clipboard.contribution.ts
- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/terminalConfiguration.ts
- https://github.com/warpdotdev/Warp/issues/2758
- https://reactflow.dev/api-reference/react-flow
- https://github.com/xyflow/xyflow/issues/4021 · /pull/5551 · /discussions/2942
- https://github.com/d3/d3-drag/blob/main/src/drag.js
- https://github.com/xyflow/xyflow/blob/main/packages/system/src/xydrag/XYDrag.ts
- https://deepwiki.com/xyflow/xyflow/3-interaction-systems
- https://github.com/chalk/supports-hyperlinks/blob/main/index.js
- https://github.com/sindresorhus/ink-link · https://github.com/sindresorhus/terminal-link/blob/main/package.json

**Local recon (this repo)**
- `expanse-desktop/node_modules/@xterm/xterm/package.json` (resolved version 5.5.0 — verified this session)
- `TerminalBoard.tsx` · `terminal/useTerminalSpawn.ts` · `terminal/terminalSelection.ts` · `terminal/terminalKeymap.ts` · `terminal/terminalMenu.ts` · `terminal/pasteIntoTerminal.ts` · `terminal/terminalWriteCoalescer.ts` · `terminal/useTerminalReraster.ts` · `src/main/clipboardIpc.ts` · installed `@xyflow/react` 12.11.0 dist (file:line refs inline above)
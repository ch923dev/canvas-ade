# Terminal I/O completeness — design spec

**Date:** 2026-06-06
**Branch:** `fix/terminal-io` (off `main`)
**Status:** implemented (2026-06-06) — all 4 slices landed on `fix/terminal-io`; gate green (1283 unit + 7 terminalIO e2e); per-slice + holistic review passed. Selection slice's spike resolved GREEN (no full-view fallback needed). Awaiting rebase onto current `main` + PR.
**Owner zone:** `src/renderer/src/canvas/boards/TerminalBoard.tsx` + new terminal hooks · `src/main/{index.ts, clipboardIpc.ts}` · `src/preload/index.ts`

## 1. Problem

The Terminal board embeds `@xterm/xterm` 5.5 bridged to `node-pty` in MAIN. Several standard
terminal capabilities were never implemented, so the terminal is not usefully interactive for the
agentic-CLI workflow it exists for. A read of the full key + selection data-flow
(`TerminalBoard.tsx`, `BoardNode.tsx`, `preload/index.ts`, `csp.ts`, `index.ts`) confirmed the
following root causes — all **missing-feature**, not regressions:

| ID | Symptom | Root cause |
|----|---------|-----------|
| **F1** | Shift+Enter submits instead of inserting a newline | No `attachCustomKeyEventHandler`. xterm sends `\r` for both Enter and Shift+Enter → the agent submits both. |
| **F2a** | Drag-selection does not track the cursor | The terminal renders inside React Flow's `transform: scale(z)` viewport (boards scale with the camera — locked decision). xterm's `getCoords` computes `(clientX − rect.left) / cellWidth`; the offset is in scaled px but `cellWidth` is unscaled → off by factor `z` at any zoom ≠ 1.0. |
| **F2b** | Copy never reaches the system clipboard | No clipboard wiring anywhere (grep: zero `clipboard`/`writeText`/`navigator.clipboard`). xterm does not copy-on-select and has no default clipboard keybind. |
| **F3** | Cannot paste text into the terminal | No paste path. Ctrl+V un-handled; `paste` events fire at `document`, not the non-editable well (memory `paste-fires-at-document`). |
| **F4** | Cannot paste an image to the agent | A PTY carries bytes, not images. Two mechanisms missing (see §5.4). Also blocked by F10. |
| **F5** | Drag-dropping a file does nothing | The well has no `onDrop`; worse, `App.tsx:30-38` installs a window-level `dragover`/`drop` **cancel** that swallows all drops. |
| **F6** | Right-click does nothing | No `onContextMenu` on the well; no Electron default menu surfaces on the canvas. |
| **F10** | Alt+V (CC image paste) is swallowed | `index.ts:75` sets `autoHideMenuBar: true` with **no** `setApplicationMenu`, so the Electron default menu runs. On Windows Alt+V triggers the "View" mnemonic instead of reaching xterm, so Claude Code never sees `\x1bv`. |

Out of scope for this spec (deferred to a follow-up): **F7** clickable links (web-links addon) and
**F8** scrollback search (search addon).

## 2. Locked decisions

| Topic | Decision | Rationale |
|-------|----------|-----------|
| Selection under zoom (F2a) | **Scale-correct on-canvas** via a coordinate-correction shim | Best UX; select+copy works directly on the canvas at any zoom. Feasibility-spiked (see §5.5). |
| Clipboard mechanism | **MAIN IPC bridge** (Electron `clipboard` module) | Robust under `sandbox: true`; no renderer focus/secure-context pitfalls; matches "native ops live in MAIN". |
| Ctrl+C | **Selection-aware**: copy iff a selection exists (then clear), else pass through as SIGINT | Familiar copy without breaking the reflexive single-press interrupt; keeps Claude Code's own single/double Ctrl+C intact. "Double Ctrl+C = SIGINT" falls out naturally when a selection is present. |
| Paste binding | **Ctrl+V** (smart: image → staged path, text → `term.paste`) | Most familiar (matches Windows Terminal). Clean on Windows (the terminal owns Ctrl+V). Trade-off accepted: overrides CC's plain-Ctrl+V image paste on Linux/native — acceptable since Windows-primary and Alt+V still works. |
| Shift+Enter sequence | Write **`\x1b\r`** (ESC + CR) to the PTY | Authoritative for Claude Code 2.1.82+; survives tmux; works with readline/ink CLIs. NOT raw `\n` (CC re-encodes it). |
| Image staging (F4 fallback) | **`<project>/.canvas/tmp/paste-N.png`** | Agent cwd is the project → clean visible paths; lives beside the existing `.canvas/` memory dir; prune on board close + age-prune on open. |
| Menu fix (F10) | **`Menu.setApplicationMenu(null)`** + re-add dev accelerators | The app has its own `AppChrome`; the default menu is dead weight and the only thing eating Alt+V. |
| Context menu (F6) | Right-click on the **well** (not the board ⋯ menu), reusing the planning `ElementContextMenu` component, mouse-mode aware | Matches every terminal; ⋯ menu stays board-level (duplicate/delete/full). |

## 3. Architecture

Three process layers, all additive. No security invariant is weakened: `contextIsolation`,
`sandbox`, `nodeIntegration: false`, the thin `contextBridge` preload, and "node/native only in MAIN"
all stand. All native clipboard reads/writes and temp-file writes happen in MAIN behind frame-guarded
IPC (`ipcGuard`); the renderer stays sandboxed.

### MAIN
- **`index.ts`** — `Menu.setApplicationMenu(null)` once the app is ready. Re-add only the dev
  accelerators that the default menu provided (DevTools toggle, reload) via `globalShortcut`,
  registered in dev only. *(F10)*
- **`clipboardIpc.ts`** (new) — frame-guarded handlers:
  - `clipboard:writeText(text)` → `clipboard.writeText`.
  - `clipboard:readText()` → `clipboard.readText`.
  - `clipboard:hasImage()` → `!clipboard.readImage().isEmpty()`.
  - `terminal:stageClipboardImage(boardId)` → if the clipboard holds an image, write it to
    `<project>/.canvas/tmp/paste-<n>.png` and return the absolute path; else return `null`.
  - `terminal:cleanupStaged(boardId)` → remove that board's staged images.
- **temp-staging util** — sequence counter per project, age-based prune on project open, board-scoped
  prune on PTY kill.

### PRELOAD (`index.ts`)
Expose, on the existing `api` object:
- `clipboard: { writeText(text), readText() }`
- `terminal: { stageClipboardImage(boardId), clipboardHasImage() }` (added alongside existing terminal
  control-plane methods)
- `pathForFile(file: File): string` — wraps `webUtils.getPathForFile(file)` (Electron 32+ replacement
  for the removed `File.path`; used by the drop handler). The `File` is passed to the preload-exposed
  function, which is in the same renderer process.

### RENDERER
`TerminalBoard.tsx` is already ~815 lines; to keep it focused, the new behavior lands in two hooks
under `canvas/boards/terminal/` (new dir), invoked from `TerminalBoard`:
- **`useTerminalKeys`** — registers `attachCustomKeyEventHandler` (F1 Shift+Enter, selection-aware
  Ctrl+C, Ctrl+V smart paste). Pure resolver for the chord→action mapping is unit-tested.
- **`useTerminalSelection`** — the capture-phase pointer coordinate-correction shim (F2a) + exposes
  the live camera `z` ref.
- Inline in `TerminalBoard`: `onContextMenu` + `onDrop`/`onDragOver` on the existing `screenWrap`
  div, reusing an `ElementContextMenu`-style menu (F5, F6).

## 4. Keybindings (final)

| Key | Action | Mechanism |
|-----|--------|-----------|
| Enter | submit | `\r` (xterm default, unchanged) |
| **Shift+Enter** | insert newline | `attachCustomKeyEventHandler`: post `{t:'input', d:'\x1b\r'}` to the port; `return false` |
| **Ctrl+C** | copy if selection (then clear); else SIGINT | `if (term.hasSelection()) { copy(term.getSelection()); term.clearSelection(); return false } else return true` (xterm sends `\x03`) |
| **Ctrl+V** | smart paste | ask MAIN (prefer image): image → `term.paste('"' + path + '" ')`; text → `term.paste(text)`; `return false` |
| **Alt+V** | CC-native image paste | `\x1bv` passes through to the PTY (unlocked by F10); Claude Code reads the OS clipboard image itself |
| **right-click** | context menu | mouse-mode aware (§5.6) |

`term.paste()` (never a raw port post) is used for all paste so multiline content receives
**bracketed-paste** markers (`ESC[200~ … ESC[201~`) when the agent enabled DECSET 2004 — both a
correctness fix (no per-line auto-submit) and a safety guard (no paste auto-run). `term.paste` routes
through the existing `term.onData → port.postMessage` path, so no new data-plane wiring is needed.

Ctrl+Shift+C / Ctrl+Shift+V are intentionally **not** bound (Ctrl+C / Ctrl+V cover them).

## 5. Data flows & mechanisms

### 5.1 Shift+Enter (F1)
`attachCustomKeyEventHandler`, guarded on `e.type === 'keydown' && e.key === 'Enter' && e.shiftKey`:
post `{t:'input', d:'\x1b\r'}` to `portRef.current`, `return false` to suppress xterm's default `\r`.
Verify no double newline.

### 5.2 Copy (F2b, Ctrl+C selection-aware)
On Ctrl+C keydown: if `term.hasSelection()`, `await window.api.clipboard.writeText(term.getSelection())`,
`term.clearSelection()`, `return false`. Otherwise `return true` so xterm emits `\x03` (SIGINT) over the
normal `onData` path. Context-menu "Copy" uses the same `getSelection → writeText` primitive.

### 5.3 Paste text (F3, Ctrl+V)
On Ctrl+V keydown: one round-trip to MAIN preferring image (§5.4); for the text case,
`term.paste(text)`. `return false` to suppress xterm's `0x16`.

### 5.4 Image paste (F4)
Two coexisting mechanisms:
- **F4a — CC-native (free after F10):** Alt+V → `\x1bv` reaches the PTY → Claude Code reads the OS
  clipboard image directly (Windows `GetClipboardData`). No app code beyond the F10 menu fix. CC-specific.
- **F4b — agent-agnostic:** Ctrl+V or context-menu "Paste image" → `terminal:stageClipboardImage`
  writes the clipboard image to `.canvas/tmp/paste-<n>.png` and returns the path →
  `term.paste('"' + path + '" ')`. Claude Code (and most agents) accept an image file-path reference.
  Cleanup: prune the board's staged files on PTY kill; age-prune on project open.

### 5.5 Scale-correct selection (F2a)
**Mechanism.** A capture-phase pointer listener on `screenWrap` rewrites each pointer event's
coordinate before xterm sees it:

```
correctedX = rect.left + (clientX − rect.left) / z
correctedY = rect.top  + (clientY − rect.top)  / z
```

where `rect = screenElement.getBoundingClientRect()` and `z` is the live React Flow zoom
(`transform[2]`, read from a ref kept current by `useOnViewportChange`). The corrected coordinate is
delivered to xterm's `.xterm-screen` as a synthetic pointer event tagged with a sentinel property to
avoid re-capture; the original event is `stopImmediatePropagation`'d. This **reuses xterm's native
selection** (anchor/focus, multiline, auto-scroll) — only the coordinate is corrected. Because xterm's
mouse-report path uses the same `getCoords`, the shim also corrects **mouse reporting to TUIs** under
zoom as a bonus.

**Derivation.** A point at true CSS offset `u` from the element's left renders on screen at `z·u` from
the visual left; `rect.left` is the visual left, so `clientX − rect.left = z·u`. xterm computes
`col = (clientX − rect.left)/cellWidth = z·u/cellWidth = z·trueCol`. Feeding it
`clientX' = rect.left + (clientX − rect.left)/z` makes `col = u/cellWidth = trueCol`.

**Feasibility spike (gates the slice).** Synthetic-event re-dispatch couples to xterm's internal
listener targets. Before committing the full slice, prove on a zoomed board that corrected synthetic
events drive a correct selection without loops or swallowed drags. **Fallback if the spike fails:**
ship "select in full view" — the board is portaled to the untransformed modal host (`BoardNode.tsx:177`)
where `z = 1` and native xterm selection is already correct — plus a one-click affordance. The earlier
slices (copy/paste/menu) are unaffected either way.

### 5.6 Context menu + drag-drop (F5, F6)
- **Context menu (F6):** `onContextMenu` on the well → reuse an `ElementContextMenu`-style component
  with: Copy (disabled when `!term.hasSelection()`), Paste, Paste image, Select all (`term.selectAll`),
  Clear (`term.clear`). `stopPropagation` so it never clears board selection or reaches React Flow.
  **Mouse-mode passthrough:** when `term.modes.mouseTrackingMode !== 'none'`, plain right-click passes
  through to the TUI and **Shift+right-click** forces our menu (VS Code/iTerm2 pattern).
- **Drag-drop (F5):** `onDrop`/`onDragOver` on the well; `onDrop` calls `stopPropagation` to beat the
  `App.tsx` window-level drop-cancel, then for each `File` → `window.api.pathForFile(file)` →
  `term.paste('"' + path + '" ')`. v1 = local file drops (image or any file → its path). The global
  anti-navigation drop guard must remain intact for all non-terminal drops.

## 6. Security & invariants

- All paste/drop content is user-initiated → permitted to reach the PTY (CLAUDE.md: terminal input is
  trusted-user-only). Bracketed paste (§4) is the guard against paste-auto-run.
- Image staging + path injection happen in MAIN behind frame-guarded IPC; the renderer never writes
  files. Browser-board content must never reach this path (CLAUDE.md invariant).
- `Menu.setApplicationMenu(null)` must not remove any capability the app relies on beyond the default
  menu; dev accelerators are re-registered explicitly.
- `contextIsolation` / `sandbox` / `nodeIntegration` unchanged; `pathForFile` is a thin `webUtils`
  wrapper, the only new preload surface besides the clipboard/terminal methods.

## 7. Testing

- **Unit**
  - coordinate-correction math: `corrected = left + (x − left)/z` across representative `z`.
  - terminal chord resolver (pure): Shift+Enter → `\x1b\r`; Ctrl+C with/without selection; Ctrl+V.
  - `clipboardIpc` handlers with a mocked Electron `clipboard` (text + image + empty).
  - staged-image path builder + sequence/cleanup logic.
- **Integration**
  - `term.paste` applies bracketed markers when bracketed-paste mode is on.
  - `attachCustomKeyEventHandler` dispatch (suppresses default; posts the right bytes).
- **e2e (Playwright `_electron`, real `sendInputEvent`)**
  - Shift+Enter → the port received `\x1b\r`.
  - Ctrl+C with a selection → MAIN `clipboard.writeText` received the selection; selection cleared.
  - Ctrl+C with no selection → `\x03` reached the PTY.
  - **drag-select at zoom ≠ 1 → selection lands on the expected cells** (the proof of §5.5; real OS
    input through the transform, per memory `e2e-sendinputevent-vs-dispatchevent`).
  - Ctrl+V text → bracketed text reached the port.
  - image paste fallback → a `.canvas/tmp` file is created and its quoted path is injected.
  - file drop → the quoted path is injected.
  - F10: the application menu is absent (`Menu.getApplicationMenu()` is null).

## 8. Slicing

Each slice ends runnable + committed + e2e green on `fix/terminal-io`.

1. **F1 + F10** — Shift+Enter newline + `setApplicationMenu(null)` (+ dev accelerators). Tiny; unblocks Alt+V.
2. **Clipboard IPC + F2b copy + F3 paste + F6 context menu** — copy/paste usable (full-view-correct
   until slice 4). Selection-aware Ctrl+C, Ctrl+V smart paste, mouse-mode-aware menu.
3. **F4 image paste + F5 drag-drop** — shares the staging IPC.
4. **F2a scale-correct selection** — feasibility spike → implementation → zoom e2e. Highest risk, last,
   so the safe value ships first; fallback to full-view-select if the spike fails.

## 9. Risks

| Risk | Mitigation |
|------|-----------|
| Selection shim couples to xterm internals / re-dispatch loops | Feasibility spike gates slice 4; sentinel-tagged synthetic events; full-view-select fallback. |
| `sendInputEvent` modifier nuances in e2e | Memory `e2e-modifier-keys-synthetic` / `e2e-sendinputevent-vs-dispatchevent`: use real key input for chords, synthetic PointerEvent flags only where documented. |
| `Menu.setApplicationMenu(null)` drops needed accelerators | Re-add DevTools/reload via `globalShortcut` (dev only); the app's chrome is in `AppChrome`, not the menu. |
| `term.paste` / bracketed mode varies by agent | Always use `term.paste`; verify against the launched agent in e2e. |
| Ctrl+V overrides CC Linux/native image paste | Accepted (Windows-primary); Alt+V still works on all platforms. |

## 10. Out of scope

- **F7** clickable links (`@xterm/addon-web-links` → `shell.openExternal`).
- **F8** scrollback search (`@xterm/addon-search` + a Ctrl+F mini-bar).

Both are clean follow-ups and do not block the core I/O set.

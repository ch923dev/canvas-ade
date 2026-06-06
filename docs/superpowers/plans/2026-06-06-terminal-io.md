# Terminal I/O completeness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Terminal board a fully usable terminal — Shift+Enter newline, selection-aware Ctrl+C copy, Ctrl+V smart paste (text + image), Alt+V CC-native image paste, drag-drop file paths, a right-click context menu, and scale-correct text selection on the zoomed canvas.

**Architecture:** Additive across the three existing process layers. Native clipboard + temp-file work lives in MAIN behind frame-guarded IPC (`isForeignSender`); the renderer wires xterm via `attachCustomKeyEventHandler`, a context menu, a drop handler, and a capture-phase pointer shim that corrects selection coordinates for the React Flow camera scale. No security invariant changes.

**Tech Stack:** Electron + TypeScript + React 18 · `@xterm/xterm` 5.5 · React Flow v12 · Vitest (unit/integration) · Playwright `_electron` (e2e). Worktree: `fix/terminal-io`.

**Spec:** `docs/superpowers/specs/2026-06-06-terminal-io-design.md`

---

## File structure

**New files**
- `src/renderer/src/canvas/boards/terminal/terminalKeymap.ts` — pure key-chord → action resolver.
- `src/renderer/src/canvas/boards/terminal/terminalKeymap.test.ts`
- `src/renderer/src/canvas/boards/terminal/terminalSelection.ts` — pure coordinate-correction math + the capture-phase shim installer.
- `src/renderer/src/canvas/boards/terminal/terminalSelection.test.ts`
- `src/main/terminalImageStaging.ts` — write a clipboard PNG into `<project>/.canvas/tmp/`, prune, cleanup.
- `src/main/terminalImageStaging.test.ts`
- `src/main/clipboardIpc.ts` — `clipboard:*` + `terminal:stageClipboardImage` + `terminal:cleanupStagedImages` handlers.
- `src/main/clipboardIpc.test.ts`
- `e2e/terminalIO.e2e.ts` — Shift+Enter, copy, paste-text, paste-image, selection-under-zoom.

**Modified files**
- `src/main/index.ts` — `Menu.setApplicationMenu(null)`; register clipboard handlers.
- `src/preload/index.ts` — expose `clipboard.*`, `terminal.stageClipboardImage`, `terminal.clipboardHasImage`, `terminal.cleanupStagedImages`, `pathForFile`.
- `src/renderer/src/canvas/boards/TerminalBoard.tsx` — keymap handler, context menu, drop handler, selection shim, e2e input log.
- `src/renderer/src/smoke/e2eRegistry.ts` — `e2eTerminalInput` map + `appendTerminalInput`.
- `src/renderer/src/smoke/e2eHooks.ts` — `readTerminalInput`, `clearTerminalInput`, `focusTerminal`, `selectTerminal`, `terminalSelection`, `resetTerminalWrite`, `terminalCellPoint`.
- `src/main/e2eMain.ts` — `putTextOnClipboard`, `readClipboardText`.

**Conventions:** TypeScript strict, no unused locals/params. Run `pnpm vitest run <file>` for a single unit file. The full local gate is `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`; e2e is `pnpm test:e2e` (builds first via `pretest:e2e`). Commit per task. The pre-commit hook runs the full e2e matrix (~2-3 min) and its **Linux Docker leg needs `NODE_AUTH_TOKEN`** for the private MCP pkg — if that token is absent in your shell, commit code-complete slices with the hook (Windows leg is the real gate) and only fall back to `--no-verify` for docs.

---

# Slice 1 — F1 Shift+Enter + F10 menu-null

### Task 1.1: Pure terminal key resolver

**Files:**
- Create: `src/renderer/src/canvas/boards/terminal/terminalKeymap.ts`
- Test: `src/renderer/src/canvas/boards/terminal/terminalKeymap.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/src/canvas/boards/terminal/terminalKeymap.test.ts
import { describe, it, expect } from 'vitest'
import { resolveTerminalKey, type TermKeyChord } from './terminalKeymap'

const chord = (key: string, mods: Partial<TermKeyChord> = {}): TermKeyChord => ({
  type: 'keydown',
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

const WIN = { hasSelection: false, isMac: false }

describe('resolveTerminalKey', () => {
  it('Shift+Enter → newline', () => {
    expect(resolveTerminalKey(chord('Enter', { shiftKey: true }), WIN)).toEqual({ kind: 'newline' })
  })

  it('plain Enter → null (xterm submits with \\r)', () => {
    expect(resolveTerminalKey(chord('Enter'), WIN)).toBeNull()
  })

  it('Ctrl+C copies ONLY with a selection; otherwise null (xterm sends SIGINT)', () => {
    expect(
      resolveTerminalKey(chord('c', { ctrlKey: true }), { hasSelection: true, isMac: false })
    ).toEqual({ kind: 'copy' })
    expect(
      resolveTerminalKey(chord('c', { ctrlKey: true }), { hasSelection: false, isMac: false })
    ).toBeNull()
  })

  it('Ctrl+V → paste (Windows/Linux)', () => {
    expect(resolveTerminalKey(chord('v', { ctrlKey: true }), WIN)).toEqual({ kind: 'paste' })
  })

  it('mac: Cmd is the primary modifier; Ctrl+C stays SIGINT even with a selection', () => {
    expect(
      resolveTerminalKey(chord('c', { metaKey: true }), { hasSelection: true, isMac: true })
    ).toEqual({ kind: 'copy' })
    expect(
      resolveTerminalKey(chord('c', { ctrlKey: true }), { hasSelection: true, isMac: true })
    ).toBeNull()
    expect(resolveTerminalKey(chord('v', { metaKey: true }), { hasSelection: false, isMac: true })).toEqual({
      kind: 'paste'
    })
  })

  it('ignores non-keydown events (handler also fires on keyup)', () => {
    expect(resolveTerminalKey(chord('Enter', { shiftKey: true, type: 'keyup' }), WIN)).toBeNull()
  })

  it('Alt+V is NOT our paste (reserved for Claude Code native image paste)', () => {
    expect(resolveTerminalKey(chord('v', { altKey: true }), WIN)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/boards/terminal/terminalKeymap.test.ts`
Expected: FAIL — `Cannot find module './terminalKeymap'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/renderer/src/canvas/boards/terminal/terminalKeymap.ts
/**
 * Pure terminal key-chord → action resolver, mirroring the canvas keymap pattern
 * (resolveCanvasKeyAction). The TerminalBoard registers this via xterm's
 * attachCustomKeyEventHandler; an action means "we own this key" (suppress xterm's
 * default and run it), null means "let xterm handle it" (Enter→\r, Ctrl+C→\x03, …).
 *
 * Ctrl+C is selection-aware: copy ONLY when text is selected, else null so xterm
 * sends SIGINT — keeps the reflexive single-press interrupt and Claude Code's own
 * single/double Ctrl+C intact. The primary modifier is Cmd on macOS, Ctrl elsewhere,
 * so Ctrl+C remains SIGINT on a Mac.
 */
export interface TermKeyChord {
  /** 'keydown' | 'keyup' | 'keypress' — the handler fires for all; act only on keydown. */
  type: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type TerminalKeyAction = { kind: 'newline' } | { kind: 'copy' } | { kind: 'paste' }

export function resolveTerminalKey(
  e: TermKeyChord,
  ctx: { hasSelection: boolean; isMac: boolean }
): TerminalKeyAction | null {
  if (e.type !== 'keydown') return null

  // Shift+Enter inserts a newline (no other modifier).
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    return { kind: 'newline' }
  }

  // Copy/paste use the platform primary modifier; never with Alt (Alt+V is reserved
  // for Claude Code's native image paste, which must pass straight through).
  const primary = ctx.isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!primary || e.altKey) return null
  const k = e.key.toLowerCase()
  if (k === 'c' && !e.shiftKey && ctx.hasSelection) return { kind: 'copy' }
  if (k === 'v' && !e.shiftKey) return { kind: 'paste' }
  return null
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm vitest run src/renderer/src/canvas/boards/terminal/terminalKeymap.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/renderer/src/canvas/boards/terminal/terminalKeymap.ts src/renderer/src/canvas/boards/terminal/terminalKeymap.test.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "feat(terminal): pure key resolver (shift+enter, selection-aware copy, paste)"
```

---

### Task 1.2: e2e input-log seam

Adds a renderer-side capture of every byte the terminal posts to its PTY, so the e2e harness can assert what Shift+Enter / paste produced.

**Files:**
- Modify: `src/renderer/src/smoke/e2eRegistry.ts`
- Modify: `src/renderer/src/smoke/e2eHooks.ts`

- [ ] **Step 1: Add the input registry**

Append to `src/renderer/src/smoke/e2eRegistry.ts`:

```ts
/**
 * Per-board log of bytes the terminal posted to its PTY (input direction), populated
 * by TerminalBoard ONLY in e2e mode so the harness can assert Shift+Enter / paste
 * produced the right sequence without depending on agent-specific echo behavior.
 */
export const e2eTerminalInput = new Map<string, string[]>()

/** Append one posted input chunk for `id` (no-op outside e2e). */
export function appendTerminalInput(id: string, d: string): void {
  if (!isE2E()) return
  const arr = e2eTerminalInput.get(id) ?? []
  arr.push(d)
  e2eTerminalInput.set(id, arr)
}
```

- [ ] **Step 2: Add the harness hooks**

In `src/renderer/src/smoke/e2eHooks.ts`:

Add to the import of `./e2eRegistry`:

```ts
import { e2eTerminals, e2eTerminalInput } from './e2eRegistry'
```

Add to the `CanvasE2E` interface (after `readTerminal`):

```ts
  /** Concatenated bytes the terminal posted to its PTY since the last clear (e2e). */
  readTerminalInput: (id: string) => string
  /** Drop a terminal's recorded input log (call before driving a key probe). */
  clearTerminalInput: (id: string) => void
  /** Focus a terminal's xterm so real key input lands on it. */
  focusTerminal: (id: string) => void
  /**
   * Dispatch a synthetic keydown on a terminal's xterm helper-textarea, with explicit
   * modifier flags. xterm's customKeyEventHandler does not check isTrusted, so this
   * reliably drives chord probes (Shift+Enter / Ctrl+C / Ctrl+V) — unlike sendInputEvent
   * keyboard modifiers, which are flaky for chords (memory e2e-modifier-keys-synthetic).
   */
  dispatchTerminalKey: (
    id: string,
    init: { key: string; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; metaKey?: boolean }
  ) => boolean
```

Add to the `api` object (after the `readTerminal` method):

```ts
    readTerminalInput(id) {
      return (e2eTerminalInput.get(id) ?? []).join('')
    },
    clearTerminalInput(id) {
      e2eTerminalInput.delete(id)
    },
    focusTerminal(id) {
      e2eTerminals.get(id)?.focus()
    },
    dispatchTerminalKey(id, init) {
      const ta = document.querySelector(
        `.react-flow__node[data-id="${id}"] .xterm-helper-textarea`
      )
      if (!ta) return false
      ta.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))
      return true
    },
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck:web`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/renderer/src/smoke/e2eRegistry.ts src/renderer/src/smoke/e2eHooks.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "test(terminal): e2e input-log + focus harness hooks"
```

---

### Task 1.3: Wire the keymap into TerminalBoard (Shift+Enter)

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

- [ ] **Step 1: Add imports**

After the existing `import { isE2E, e2eTerminals } from '../../smoke/e2eRegistry'` line, change it to also import the input log, and add the keymap import below the other local imports:

```ts
import { isE2E, e2eTerminals, appendTerminalInput } from '../../smoke/e2eRegistry'
import { resolveTerminalKey } from './terminal/terminalKeymap'
```

- [ ] **Step 2: Add the `sendInput` seam + key handler in the spawn effect**

In `TerminalBoard.tsx`, find this block (currently around line 299-306):

```ts
    const dataDisp = term.onData((d) => portRef.current?.postMessage({ t: 'input', d }))
    const resizeDisp = term.onResize(({ cols, rows }) =>
      portRef.current?.postMessage({ t: 'resize', cols, rows })
    )
```

Replace it with:

```ts
    // All PTY-bound input flows through one seam so the e2e harness can observe it and
    // so the key handler (newline) and term.paste both share the same path.
    const sendInput = (d: string): void => {
      if (isE2E()) appendTerminalInput(board.id, d)
      portRef.current?.postMessage({ t: 'input', d })
    }
    const dataDisp = term.onData((d) => sendInput(d))
    const resizeDisp = term.onResize(({ cols, rows }) =>
      portRef.current?.postMessage({ t: 'resize', cols, rows })
    )

    // Custom key handling (returns false to suppress xterm's default for keys we own):
    //  - Shift+Enter inserts a newline (\x1b\r — CC-recognized, tmux-safe; NOT raw \n).
    //  - Ctrl/Cmd+C copies when a selection exists (then clears); else falls through to
    //    xterm's SIGINT (\x03). Cmd is primary on macOS so Ctrl+C stays SIGINT there.
    //  - Ctrl/Cmd+V smart-pastes (image → staged path, else text), via term.paste so
    //    multiline content gets bracketed-paste markers.
    const isMac = navigator.platform.toLowerCase().includes('mac')
    term.attachCustomKeyEventHandler((e) => {
      const action = resolveTerminalKey(e, { hasSelection: term.hasSelection(), isMac })
      if (!action) return true
      if (action.kind === 'newline') {
        sendInput('\x1b\r')
      } else if (action.kind === 'copy') {
        const sel = term.getSelection()
        if (sel) {
          void window.api.clipboard.writeText(sel)
          term.clearSelection()
        }
      } else if (action.kind === 'paste') {
        void pasteIntoTerminal(term, board.id)
      }
      return false
    })
```

> NOTE: `window.api.clipboard` and `pasteIntoTerminal` do not exist yet — they land in Slice 2 (Tasks 2.2 and 2.4). This task compiles only after those. To keep this task self-contained and green, temporarily stub the copy/paste branches as no-ops and replace them in Slice 2:
>
> ```ts
>      } else if (action.kind === 'copy') {
>        /* wired in Slice 2 (Task 2.4) */
>      } else if (action.kind === 'paste') {
>        /* wired in Slice 2 (Task 2.4) */
>      }
> ```
>
> Implement Slice 1 with the stubs (Shift+Enter is fully functional), then Task 2.4 replaces the stubs with the real copy/paste calls.

- [ ] **Step 3: Typecheck + build**

Run: `pnpm typecheck:web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/renderer/src/canvas/boards/TerminalBoard.tsx
git -C "Z:\canvas-ade-terminal-io" commit -m "feat(terminal): shift+enter inserts newline via custom key handler"
```

---

### Task 1.4: F10 — remove the default application menu

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Import `Menu`**

Change the first import line of `src/main/index.ts`:

```ts
import { app, shell, BrowserWindow, ipcMain, safeStorage } from 'electron'
```

to:

```ts
import { app, shell, BrowserWindow, ipcMain, safeStorage, Menu } from 'electron'
```

- [ ] **Step 2: Null the menu on ready**

In `app.whenReady().then(async () => {`, immediately after the `electronApp.setAppUserModelId('com.canvasade.app')` line, add:

```ts
    // F10: drop Electron's default menu (File/Edit/View/…). On Windows its Alt
    // mnemonics (Alt+V = View) swallow Alt+V before xterm sees it, breaking Claude
    // Code's clipboard-image paste. The app's chrome lives in AppChrome, not a menu;
    // optimizer.watchWindowShortcuts (below) still provides DevTools/reload in dev.
    Menu.setApplicationMenu(null)
```

- [ ] **Step 3: Build to verify the main bundle compiles**

Run: `pnpm typecheck:node`
Expected: PASS.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Run: `pnpm dev`, open a terminal board with `claude` as the launch command, copy an image to the clipboard (e.g. a screenshot), focus the terminal, press **Alt+V**.
Expected: Claude Code attaches the image (no "View" menu flashes). Close the app.

- [ ] **Step 5: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/main/index.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "fix(menu): setApplicationMenu(null) so Alt+V reaches xterm (unblocks CC image paste)"
```

---

### Task 1.5: e2e — Shift+Enter inserts a newline

**Files:**
- Create: `e2e/terminalIO.e2e.ts`

- [ ] **Step 1: Write the test**

```ts
// e2e/terminalIO.e2e.ts
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const readInput = (id: string) => `window.__canvasE2E.readTerminalInput(${JSON.stringify(id)})`

test.describe('terminal I/O', () => {
  test('Shift+Enter posts \\x1b\\r (newline insert), not a bare \\r', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    await evalIn(page, `window.__canvasE2E.clearTerminalInput(${JSON.stringify(id)})`)
    // Synthetic keydown with explicit shiftKey (reliable for chord probes).
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: 'Enter', shiftKey: true })`
    )
    const sawNewline = await pollEval(page, `${readInput(id)}.includes('\\u001b\\r')`, 3000)
    expect(sawNewline, 'shift+enter posted ESC+CR').toBe(true)
  })
})
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `pnpm test:e2e e2e/terminalIO.e2e.ts`
Expected: the `Shift+Enter` test PASSES. (`pretest:e2e` rebuilds first.)

- [ ] **Step 3: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add e2e/terminalIO.e2e.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "test(e2e): shift+enter posts ESC+CR"
```

---

# Slice 2 — Clipboard IPC + copy + paste + context menu

### Task 2.1: Image staging module

**Files:**
- Create: `src/main/terminalImageStaging.ts`
- Test: `src/main/terminalImageStaging.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/terminalImageStaging.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { stagedDir, stageClipboardImage, cleanupStaged } from './terminalImageStaging'

let proj: string
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'canvas-stage-'))
})
afterEach(() => {
  rmSync(proj, { recursive: true, force: true })
})

describe('terminalImageStaging', () => {
  it('writes the PNG under <project>/.canvas/tmp and returns the absolute path', () => {
    const png = Buffer.from([1, 2, 3, 4])
    const p = stageClipboardImage(proj, 'board1', png)
    expect(p.startsWith(stagedDir(proj))).toBe(true)
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p)).toEqual(png)
  })

  it('uses a unique name per call (sequence)', () => {
    const a = stageClipboardImage(proj, 'b', Buffer.from([0]))
    const b = stageClipboardImage(proj, 'b', Buffer.from([0]))
    expect(a).not.toEqual(b)
  })

  it('sanitizes the board id in the filename', () => {
    const p = stageClipboardImage(proj, '../../evil id', Buffer.from([0]))
    expect(p.includes('..')).toBe(false)
    expect(p.startsWith(stagedDir(proj))).toBe(true)
  })

  it('cleanupStaged removes only the given board files', () => {
    const a = stageClipboardImage(proj, 'keep', Buffer.from([0]))
    const b = stageClipboardImage(proj, 'drop', Buffer.from([0]))
    cleanupStaged(proj, 'drop')
    expect(existsSync(a)).toBe(true)
    expect(existsSync(b)).toBe(false)
  })

  it('cleanupStaged is a no-op when the dir does not exist', () => {
    expect(() => cleanupStaged(join(proj, 'nope'), 'x')).not.toThrow()
  })

  it('prunes staged files older than the given age on stage', () => {
    const old = stageClipboardImage(proj, 'old', Buffer.from([0]))
    // Force the file's mtime into the past.
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000)
    require('fs').utimesSync(old, past, past)
    stageClipboardImage(proj, 'new', Buffer.from([0]), 60 * 60 * 1000) // 1h max age
    expect(existsSync(old)).toBe(false)
    expect(readdirSync(stagedDir(proj)).some((n) => n.includes('new'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run src/main/terminalImageStaging.test.ts`
Expected: FAIL — `Cannot find module './terminalImageStaging'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/main/terminalImageStaging.ts
/**
 * Stage clipboard/dropped images for the agent. A PTY carries only text, so an image
 * is written to <project>/.canvas/tmp/ and its file path is injected into the terminal
 * (Claude Code and most agents accept an image file-path reference). Self-contained
 * cleanup: prune-on-stage by age + per-board cleanup when the terminal is torn down.
 * MAIN-only; the renderer never writes files.
 */
import { mkdirSync, writeFileSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'

let seq = 0
const PREFIX = 'paste-'
/** Default prune age: files older than this are removed when a new one is staged. */
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000 // 1h

/** Sanitize a board id into a filename-safe token (no separators / dots). */
function safeId(boardId: string): string {
  return boardId.replace(/[^a-zA-Z0-9_-]/g, '') || 'board'
}

/** The per-project staging directory (created lazily on first stage). */
export function stagedDir(projectDir: string): string {
  return join(projectDir, '.canvas', 'tmp')
}

/**
 * Write `png` to the staging dir and return its absolute path. Also prunes any staged
 * file older than `maxAgeMs` (best-effort) so the dir can't grow unbounded.
 */
export function stageClipboardImage(
  projectDir: string,
  boardId: string,
  png: Buffer,
  maxAgeMs = DEFAULT_MAX_AGE_MS
): string {
  const dir = stagedDir(projectDir)
  mkdirSync(dir, { recursive: true })
  pruneOld(dir, maxAgeMs)
  seq += 1
  const file = join(dir, `${PREFIX}${safeId(boardId)}-${seq}.png`)
  writeFileSync(file, png)
  return file
}

/** Remove staged files older than `maxAgeMs`. Best-effort; never throws. */
function pruneOld(dir: string, maxAgeMs: number): void {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - maxAgeMs
  for (const n of names) {
    if (!n.startsWith(PREFIX)) continue
    const full = join(dir, n)
    try {
      if (statSync(full).mtimeMs < cutoff) rmSync(full)
    } catch {
      /* best-effort */
    }
  }
}

/** Remove every staged file for `boardId` (called when its terminal is torn down). */
export function cleanupStaged(projectDir: string, boardId: string): void {
  const dir = stagedDir(projectDir)
  const token = `${PREFIX}${safeId(boardId)}-`
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const n of names) {
    if (!n.startsWith(token)) continue
    try {
      rmSync(join(dir, n))
    } catch {
      /* best-effort */
    }
  }
}
```

(The test ages a file via `fs.utimesSync` imported directly in the test — the module itself does not need it.)

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm vitest run src/main/terminalImageStaging.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/main/terminalImageStaging.ts src/main/terminalImageStaging.test.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "feat(terminal): MAIN image staging into .canvas/tmp (prune + cleanup)"
```

---

### Task 2.2: Clipboard IPC handlers

**Files:**
- Create: `src/main/clipboardIpc.ts`
- Test: `src/main/clipboardIpc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/main/clipboardIpc.test.ts
import { describe, it, expect, vi } from 'vitest'
import { registerClipboardHandlers, type ClipboardDeps } from './clipboardIpc'

type Handler = (e: { senderFrame?: unknown }, ...args: unknown[]) => unknown
function fakeIpc(): { handlers: Record<string, Handler>; handle: (c: string, h: Handler) => void } {
  const handlers: Record<string, Handler> = {}
  return { handlers, handle: (c, h) => (handlers[c] = h) }
}
// No senderFrame → isForeignSender returns false (internal/allowed), like the e2e harness.
const internal = {}

function deps(over: Partial<ClipboardDeps> = {}): ClipboardDeps {
  return {
    writeText: vi.fn(),
    readText: vi.fn(() => 'hello'),
    hasImage: vi.fn(() => false),
    readImagePng: vi.fn(() => null),
    currentDir: vi.fn(() => '/proj'),
    stage: vi.fn(() => '/proj/.canvas/tmp/paste-b-1.png'),
    ...over
  }
}

describe('clipboardIpc', () => {
  it('clipboard:writeText writes through to deps', async () => {
    const ipc = fakeIpc()
    const d = deps()
    registerClipboardHandlers(ipc as never, () => null, d)
    const ok = await ipc.handlers['clipboard:writeText'](internal, 'copied')
    expect(d.writeText).toHaveBeenCalledWith('copied')
    expect(ok).toBe(true)
  })

  it('clipboard:readText returns the clipboard text', async () => {
    const ipc = fakeIpc()
    registerClipboardHandlers(ipc as never, () => null, deps())
    expect(await ipc.handlers['clipboard:readText'](internal)).toBe('hello')
  })

  it('stageClipboardImage returns null when no image', async () => {
    const ipc = fakeIpc()
    registerClipboardHandlers(ipc as never, () => null, deps({ readImagePng: () => null }))
    expect(await ipc.handlers['terminal:stageClipboardImage'](internal, 'b')).toBeNull()
  })

  it('stageClipboardImage returns null when no project is open', async () => {
    const ipc = fakeIpc()
    registerClipboardHandlers(
      ipc as never,
      () => null,
      deps({ readImagePng: () => Buffer.from([1]), currentDir: () => null })
    )
    expect(await ipc.handlers['terminal:stageClipboardImage'](internal, 'b')).toBeNull()
  })

  it('stageClipboardImage stages the PNG and returns its path', async () => {
    const ipc = fakeIpc()
    const stage = vi.fn(() => '/proj/.canvas/tmp/paste-b-1.png')
    registerClipboardHandlers(
      ipc as never,
      () => null,
      deps({ readImagePng: () => Buffer.from([1, 2]), stage })
    )
    const p = await ipc.handlers['terminal:stageClipboardImage'](internal, 'b')
    expect(stage).toHaveBeenCalledWith('/proj', 'b', Buffer.from([1, 2]))
    expect(p).toBe('/proj/.canvas/tmp/paste-b-1.png')
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run src/main/clipboardIpc.test.ts`
Expected: FAIL — `Cannot find module './clipboardIpc'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/main/clipboardIpc.ts
/**
 * Frame-guarded clipboard + terminal-image-staging IPC. The renderer is sandboxed, so
 * all native clipboard reads/writes and temp-file writes happen here behind
 * isForeignSender (the single trust-boundary guard). Deps are injected so the handlers
 * are unit-testable without mocking Electron.
 */
import { clipboard, type IpcMain, type BrowserWindow } from 'electron'
import { isForeignSender } from './ipcGuard'
import { stageClipboardImage, cleanupStaged } from './terminalImageStaging'
import { getCurrentDir } from './projectStore'

export interface ClipboardDeps {
  writeText(text: string): void
  readText(): string
  hasImage(): boolean
  /** The clipboard image as PNG bytes, or null when the clipboard holds no image. */
  readImagePng(): Buffer | null
  /** The current project dir, or null when no project is open. */
  currentDir(): string | null
  stage(projectDir: string, boardId: string, png: Buffer): string
}

function realDeps(): ClipboardDeps {
  return {
    writeText: (t) => clipboard.writeText(t),
    readText: () => clipboard.readText(),
    hasImage: () => !clipboard.readImage().isEmpty(),
    readImagePng: () => {
      const img = clipboard.readImage()
      return img.isEmpty() ? null : img.toPNG()
    },
    currentDir: () => getCurrentDir(),
    stage: (dir, id, png) => stageClipboardImage(dir, id, png)
  }
}

export function registerClipboardHandlers(
  ipc: IpcMain,
  getWin: () => BrowserWindow | null,
  deps: ClipboardDeps = realDeps()
): void {
  ipc.handle('clipboard:writeText', (e, text: string) => {
    if (isForeignSender(e, getWin)) return false
    deps.writeText(typeof text === 'string' ? text : '')
    return true
  })

  ipc.handle('clipboard:readText', (e) => {
    if (isForeignSender(e, getWin)) return ''
    return deps.readText()
  })

  ipc.handle('clipboard:hasImage', (e) => {
    if (isForeignSender(e, getWin)) return false
    return deps.hasImage()
  })

  ipc.handle('terminal:stageClipboardImage', (e, boardId: string) => {
    if (isForeignSender(e, getWin)) return null
    const dir = deps.currentDir()
    if (!dir) return null
    const png = deps.readImagePng()
    if (!png) return null
    return deps.stage(dir, String(boardId), png)
  })

  ipc.handle('terminal:cleanupStagedImages', (e, boardId: string) => {
    if (isForeignSender(e, getWin)) return false
    const dir = deps.currentDir()
    if (dir) cleanupStaged(dir, String(boardId))
    return true
  })
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm vitest run src/main/clipboardIpc.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Register the handlers in main**

In `src/main/index.ts`, add the import near the other handler imports (after the `registerPtyHandlers` import block):

```ts
import { registerClipboardHandlers } from './clipboardIpc'
```

In `app.whenReady`, right after the existing `registerPtyHandlers(ipcMain, () => mainWindow)` line, add:

```ts
  registerClipboardHandlers(ipcMain, () => mainWindow)
```

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck:node`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/main/clipboardIpc.ts src/main/clipboardIpc.test.ts src/main/index.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "feat(terminal): frame-guarded clipboard + image-staging IPC"
```

---

### Task 2.3: Expose the preload surface

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add the clipboard + terminal-image + pathForFile API**

In `src/preload/index.ts`, change the top import to add `webUtils`:

```ts
import { contextBridge, ipcRenderer, webUtils } from 'electron'
```

In the `api` object, under the `// ── Terminal (control plane …) ──` section (after `detectPorts`), add:

```ts
  // ── Clipboard (MAIN-owned; sandbox-clean) ──
  clipboard: {
    writeText: (text: string): Promise<boolean> => ipcRenderer.invoke('clipboard:writeText', text),
    readText: (): Promise<string> => ipcRenderer.invoke('clipboard:readText')
  },
```

Then extend the terminal control-plane block — add these three methods alongside `spawnTerminal`/`killTerminal` (place them right after `detectPorts`):

```ts
  // Stage the clipboard image to <project>/.canvas/tmp and return its absolute path
  // (null = no image / no project). The renderer injects the path into the PTY.
  stageClipboardImage: (boardId: string): Promise<string | null> =>
    ipcRenderer.invoke('terminal:stageClipboardImage', boardId),
  clipboardHasImage: (): Promise<boolean> => ipcRenderer.invoke('clipboard:hasImage'),
  cleanupStagedImages: (boardId: string): Promise<boolean> =>
    ipcRenderer.invoke('terminal:cleanupStagedImages', boardId),
  // webUtils.getPathForFile replaces the removed File.path (Electron 32+). Called from
  // the terminal drop handler to get a dropped file's real OS path for injection.
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
```

- [ ] **Step 2: Typecheck preload + web (the renderer consumes `CanvasApi`)**

Run: `pnpm typecheck:preload && pnpm typecheck:web`
Expected: PASS. (`CanvasApi = typeof api` flows the new methods to `window.api` automatically via `index.d.ts`.)

- [ ] **Step 3: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/preload/index.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "feat(preload): clipboard + terminal image-staging + pathForFile surface"
```

---

### Task 2.4: Wire copy + smart paste into TerminalBoard

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

- [ ] **Step 1: Add the paste helper**

In `TerminalBoard.tsx`, add this module-level helper just above the `export function TerminalBoard(` declaration:

```ts
/**
 * Smart paste: if the clipboard holds an image, stage it to a temp file and inject the
 * quoted path; otherwise inject the clipboard text. Uses `term.paste` so multiline
 * content gets bracketed-paste markers when the agent enabled them (no per-line submit).
 */
async function pasteIntoTerminal(term: Terminal, boardId: string): Promise<void> {
  const path = await window.api.stageClipboardImage(boardId)
  if (path) {
    term.paste(`"${path}" `)
    return
  }
  const text = await window.api.clipboard.readText()
  if (text) term.paste(text)
}
```

- [ ] **Step 2: Replace the Slice-1 copy/paste stubs**

In the `attachCustomKeyEventHandler` body (added in Task 1.3), replace the stubbed branches:

```ts
      } else if (action.kind === 'copy') {
        /* wired in Slice 2 (Task 2.4) */
      } else if (action.kind === 'paste') {
        /* wired in Slice 2 (Task 2.4) */
      }
```

with the real implementation:

```ts
      } else if (action.kind === 'copy') {
        const sel = term.getSelection()
        if (sel) {
          void window.api.clipboard.writeText(sel)
          term.clearSelection()
        }
      } else if (action.kind === 'paste') {
        void pasteIntoTerminal(term, board.id)
      }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck:web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/renderer/src/canvas/boards/TerminalBoard.tsx
git -C "Z:\canvas-ade-terminal-io" commit -m "feat(terminal): selection-aware Ctrl+C copy + Ctrl+V smart paste"
```

---

### Task 2.5: Right-click context menu (mouse-mode aware)

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

- [ ] **Step 1: Add imports + menu state**

Add the import (near the other `./planning/...` paths are not imported here yet — add it with the local imports):

```ts
import { ElementContextMenu, type MenuEntry } from './planning/ElementContextMenu'
```

Inside `TerminalBoard`, add menu state near the other `useState` hooks (e.g. after `const [configOpen, setConfigOpen] = useState(false)`):

```ts
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
```

- [ ] **Step 2: Build the entries + the contextmenu handler**

Add this just before the `return (` of the component (after `interrupt`/other callbacks):

```ts
  // Right-click context menu over the well. Reuses the planning menu component. When the
  // running TUI has mouse reporting on (term.modes.mouseTrackingMode !== 'none'), plain
  // right-click passes through to the app; Shift+right-click forces our menu.
  const openMenu = useCallback((e: React.MouseEvent) => {
    const term = termRef.current
    if (!term) return
    const mouseMode = term.modes.mouseTrackingMode !== 'none'
    if (mouseMode && !e.shiftKey) return // let the TUI have the right-click
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY })
  }, [])

  const menuEntries: MenuEntry[] = (() => {
    const term = termRef.current
    const hasSel = !!term?.hasSelection()
    return [
      {
        kind: 'action',
        id: 'copy',
        label: 'Copy',
        disabled: !hasSel,
        onSelect: () => {
          const t = termRef.current
          const sel = t?.getSelection()
          if (t && sel) {
            void window.api.clipboard.writeText(sel)
            t.clearSelection()
          }
        }
      },
      {
        kind: 'action',
        id: 'paste',
        label: 'Paste',
        onSelect: () => {
          const t = termRef.current
          if (t) void pasteIntoTerminal(t, board.id)
        }
      },
      {
        kind: 'action',
        id: 'selectall',
        label: 'Select all',
        onSelect: () => termRef.current?.selectAll()
      },
      {
        kind: 'action',
        id: 'clear',
        label: 'Clear',
        onSelect: () => termRef.current?.clear()
      }
    ]
  })()
```

- [ ] **Step 3: Attach the handler + render the menu**

Find the well wrapper (currently around line 738-747):

```tsx
          <div
            className="nodrag nowheel"
            style={screenWrap}
            onMouseDown={(e) => {
              e.stopPropagation()
              termRef.current?.focus()
            }}
          >
            <div ref={screenRef} style={screen} />
          </div>
```

Replace with:

```tsx
          <div
            className="nodrag nowheel"
            style={screenWrap}
            onMouseDown={(e) => {
              e.stopPropagation()
              termRef.current?.focus()
            }}
            onContextMenu={openMenu}
          >
            <div ref={screenRef} style={screen} />
          </div>
          {menu && (
            <ElementContextMenu
              x={menu.x}
              y={menu.y}
              entries={menuEntries}
              onClose={() => setMenu(null)}
            />
          )}
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm typecheck:web && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/renderer/src/canvas/boards/TerminalBoard.tsx
git -C "Z:\canvas-ade-terminal-io" commit -m "feat(terminal): right-click context menu (copy/paste/select-all/clear, mouse-mode aware)"
```

---

### Task 2.6: e2e harness — clipboard read + programmatic selection

**Files:**
- Modify: `src/main/e2eMain.ts`
- Modify: `src/renderer/src/smoke/e2eHooks.ts`

- [ ] **Step 1: Add MAIN clipboard helpers**

In `src/main/e2eMain.ts`, add to the `E2EMain` interface:

```ts
  /** Put plain text on the system clipboard (paste-text sliver). */
  putTextOnClipboard(text: string): void
  /** Read the system clipboard text (assert a copy landed). */
  readClipboardText(): string
```

And to the installed object (after `putRedBitmapOnClipboard`):

```ts
    putTextOnClipboard(text) {
      clipboard.writeText(text)
    },
    readClipboardText() {
      return clipboard.readText()
    },
```

- [ ] **Step 2: Add renderer selection hooks**

In `src/renderer/src/smoke/e2eHooks.ts`, add to the `CanvasE2E` interface (after `focusTerminal`):

```ts
  /** Programmatically select `length` cells from (col,row) in a terminal (copy sliver). */
  selectTerminal: (id: string, col: number, row: number, length: number) => void
  /** The terminal's current selection text (assert against the clipboard). */
  terminalSelection: (id: string) => string
```

And to the `api` object (after `focusTerminal`):

```ts
    selectTerminal(id, col, row, length) {
      e2eTerminals.get(id)?.select(col, row, length)
    },
    terminalSelection(id) {
      return e2eTerminals.get(id)?.getSelection() ?? ''
    },
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck:node && pnpm typecheck:web`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/main/e2eMain.ts src/renderer/src/smoke/e2eHooks.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "test(terminal): e2e clipboard + selection harness hooks"
```

---

### Task 2.7: e2e — copy + paste-text

**Files:**
- Modify: `e2e/terminalIO.e2e.ts`

- [ ] **Step 1: Add the two tests**

Append inside the `test.describe('terminal I/O', …)` block:

```ts
  test('Ctrl+C with a selection copies it to the clipboard', async ({ page, electronApp }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await pollEval(page, `${readInput(id)} !== null`, 3000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    // Select 5 cells on the first row and copy.
    await evalIn(page, `window.__canvasE2E.selectTerminal(${JSON.stringify(id)}, 0, 0, 5)`)
    const sel = await evalIn<string>(page, `window.__canvasE2E.terminalSelection(${JSON.stringify(id)})`)
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: 'c', ctrlKey: true })`
    )
    await page.waitForTimeout(200) // settle the async clipboard.writeText IPC
    const copied = await mainCall<string>(electronApp, 'readClipboardText')
    expect(copied).toBe(sel)
    expect(copied.length).toBeGreaterThan(0)
  })

  test('Ctrl+V pastes clipboard text into the terminal', async ({ page, electronApp }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    await evalIn(page, `window.__canvasE2E.clearTerminalInput(${JSON.stringify(id)})`)
    await mainCall(electronApp, 'putTextOnClipboard', 'HELLO_PASTE_123')
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: 'v', ctrlKey: true })`
    )
    const pasted = await pollEval(page, `${readInput(id)}.includes('HELLO_PASTE_123')`, 3000)
    expect(pasted, 'pasted text reached the PTY input').toBe(true)
  })
```

- [ ] **Step 2: Run the e2e file, verify the new tests pass**

Run: `pnpm test:e2e e2e/terminalIO.e2e.ts`
Expected: 3 tests PASS (Shift+Enter, copy, paste-text).

- [ ] **Step 3: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add e2e/terminalIO.e2e.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "test(e2e): terminal copy + paste-text"
```

---

# Slice 3 — Image paste + drag-drop

### Task 3.1: Drag-drop path injection (pure helper + test)

**Files:**
- Create: `src/renderer/src/canvas/boards/terminal/terminalDrop.ts`
- Test: `src/renderer/src/canvas/boards/terminal/terminalDrop.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/src/canvas/boards/terminal/terminalDrop.test.ts
import { describe, it, expect } from 'vitest'
import { quotePathsForPaste } from './terminalDrop'

describe('quotePathsForPaste', () => {
  it('quotes each path and joins with spaces, trailing space', () => {
    expect(quotePathsForPaste(['C:\\a\\b.png'])).toBe('"C:\\a\\b.png" ')
    expect(quotePathsForPaste(['/x/y.png', '/x/z.txt'])).toBe('"/x/y.png" "/x/z.txt" ')
  })

  it('drops empty/blank paths (webUtils.getPathForFile returns "" for synthetic files)', () => {
    expect(quotePathsForPaste(['', '  ', '/ok'])).toBe('"/ok" ')
  })

  it('returns empty string for no usable paths', () => {
    expect(quotePathsForPaste(['', ''])).toBe('')
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/boards/terminal/terminalDrop.test.ts`
Expected: FAIL — `Cannot find module './terminalDrop'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/renderer/src/canvas/boards/terminal/terminalDrop.ts
/**
 * Turn dropped-file paths into a single quoted string to inject into the PTY via
 * term.paste. Empty paths are dropped — webUtils.getPathForFile returns '' for files
 * that aren't backed by a real OS path (e.g. a synthetic drag).
 */
export function quotePathsForPaste(paths: string[]): string {
  return paths
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `"${p}" `)
    .join('')
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm vitest run src/renderer/src/canvas/boards/terminal/terminalDrop.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/renderer/src/canvas/boards/terminal/terminalDrop.ts src/renderer/src/canvas/boards/terminal/terminalDrop.test.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "feat(terminal): pure drop-path → paste-string helper"
```

---

### Task 3.2: Wire the drop handler + staged-image cleanup

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

- [ ] **Step 1: Import the helper**

Add to the local imports:

```ts
import { quotePathsForPaste } from './terminal/terminalDrop'
```

- [ ] **Step 2: Add the drop handler to the well**

Update the well wrapper (the same `div` edited in Task 2.5) to add `onDragOver` + `onDrop`:

```tsx
          <div
            className="nodrag nowheel"
            style={screenWrap}
            onMouseDown={(e) => {
              e.stopPropagation()
              termRef.current?.focus()
            }}
            onContextMenu={openMenu}
            onDragOver={(e) => {
              if (e.dataTransfer?.types?.includes('Files')) {
                e.preventDefault() // required for onDrop to fire
                e.stopPropagation()
              }
            }}
            onDrop={(e) => {
              const files = e.dataTransfer?.files
              if (!files || files.length === 0) return
              // stopPropagation beats App.tsx's window-level drop-cancel (anti-navigation).
              e.preventDefault()
              e.stopPropagation()
              const paths = Array.from(files).map((f) => window.api.pathForFile(f))
              const payload = quotePathsForPaste(paths)
              if (payload) termRef.current?.paste(payload)
            }}
          >
            <div ref={screenRef} style={screen} />
          </div>
```

- [ ] **Step 3: Clean up staged images on teardown**

In the spawn effect's cleanup return (the function returned from `spawn`, currently around line 428-450), add a cleanup call next to `killTerminal`. Find:

```ts
      void window.api.killTerminal(board.id)
```

and add right after it:

```ts
      void window.api.cleanupStagedImages(board.id)
```

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm typecheck:web && pnpm lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/renderer/src/canvas/boards/TerminalBoard.tsx
git -C "Z:\canvas-ade-terminal-io" commit -m "feat(terminal): drag-drop file → inject path; cleanup staged images on teardown"
```

---

### Task 3.3: e2e — image paste stages a file and injects its path

**Files:**
- Modify: `e2e/terminalIO.e2e.ts`

- [ ] **Step 1: Add the test**

Append inside the describe block:

```ts
  test('Ctrl+V with a clipboard image stages a PNG and injects its path', async ({
    page,
    electronApp
  }) => {
    // Needs a project dir so .canvas/tmp has a home.
    const proj = await mainCall<string>(electronApp, 'createTempProject', 'canvas-e2e-img-', 'imgproj')
    try {
      const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
      await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
      await evalIn(page, `window.__canvasE2E.setZoom(1)`)
      await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
      await evalIn(page, `window.__canvasE2E.clearTerminalInput(${JSON.stringify(id)})`)
      await mainCall(electronApp, 'putRedBitmapOnClipboard', 4, 4)
      await evalIn(
        page,
        `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: 'v', ctrlKey: true })`
      )
      // The injected payload is a quoted path ending in .png inside .canvas/tmp.
      const injected = await pollEval(
        page,
        `${readInput(id)}.includes('.canvas') && ${readInput(id)}.includes('paste-') && ${readInput(id)}.includes('.png')`,
        4000
      )
      expect(injected, 'a staged .png path was injected').toBe(true)
      // And the staged file actually exists on disk.
      const raw = await evalIn<string>(page, readInput(id))
      const m = raw.match(/"([^"]+\.png)"/)
      expect(m, 'path is quoted in the input').not.toBeNull()
      const exists = await mainCall<boolean>(electronApp, 'fileExists', m![1])
      expect(exists, 'staged file exists on disk').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', proj)
    }
  })
```

- [ ] **Step 2: Run the e2e file**

Run: `pnpm test:e2e e2e/terminalIO.e2e.ts`
Expected: 4 tests PASS.

- [ ] **Step 3: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add e2e/terminalIO.e2e.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "test(e2e): terminal image paste stages + injects a .canvas/tmp path"
```

---

# Slice 4 — Scale-correct on-canvas selection (spike-gated)

### Task 4.1: Feasibility spike (manual — gates the rest of the slice)

**Files:** none (investigation).

- [ ] **Step 1: Prove the synthetic-event approach on a zoomed board**

Run `pnpm dev`. Open a terminal board, run a command that prints a long line (e.g. `echo ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`). Set the camera to a non-1 zoom (scroll to ~0.6). With NO code yet, drag-select across the printed line and confirm the selection lands SHORT of / past the cursor (reproduce the bug).

- [ ] **Step 2: Hand-test the shim in the devtools console**

In the renderer devtools console, paste a throwaway capture-phase `mousedown`/`mousemove`/`mouseup` listener on the `.xterm-screen` element that rewrites `clientX/clientY` by the live zoom and re-dispatches a sentinel-tagged `MouseEvent` to the same element / `document`, stopping the original. Confirm a drag now selects the cell under the cursor. (This is the exact mechanism Task 4.2 productionizes.)

- [ ] **Step 3: Decision gate**

If the hand-test selects correctly → proceed to Task 4.2.
If it does NOT (xterm ignores the synthetic events, or a loop/double-select appears) → STOP and switch to the documented fallback: ship "select in full view" (the board portals to the untransformed modal host where z=1 and native selection already works) + a one-click affordance, and mark Tasks 4.2-4.4 as superseded. Record the decision in the spec's §5.5.

---

### Task 4.2: Pure coordinate-correction math

**Files:**
- Create: `src/renderer/src/canvas/boards/terminal/terminalSelection.ts`
- Test: `src/renderer/src/canvas/boards/terminal/terminalSelection.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/renderer/src/canvas/boards/terminal/terminalSelection.test.ts
import { describe, it, expect } from 'vitest'
import { correctClientPoint } from './terminalSelection'

const rect = { left: 100, top: 50 }

describe('correctClientPoint', () => {
  it('is the identity at z = 1', () => {
    expect(correctClientPoint({ x: 160, y: 90 }, rect, 1)).toEqual({ x: 160, y: 90 })
  })

  it('doubles the in-element offset at z = 0.5 (zoomed out → screen px are half-size)', () => {
    // offset (60,40) → corrected offset (120,80) → (220,130)
    expect(correctClientPoint({ x: 160, y: 90 }, rect, 0.5)).toEqual({ x: 220, y: 130 })
  })

  it('halves the in-element offset at z = 2 (zoomed in)', () => {
    expect(correctClientPoint({ x: 160, y: 90 }, rect, 2)).toEqual({ x: 130, y: 70 })
  })

  it('guards a zero/invalid zoom (returns the point unchanged)', () => {
    expect(correctClientPoint({ x: 160, y: 90 }, rect, 0)).toEqual({ x: 160, y: 90 })
    expect(correctClientPoint({ x: 160, y: 90 }, rect, NaN)).toEqual({ x: 160, y: 90 })
  })
})
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run src/renderer/src/canvas/boards/terminal/terminalSelection.test.ts`
Expected: FAIL — `Cannot find module './terminalSelection'`.

- [ ] **Step 3: Write the implementation (math only for now)**

```ts
// src/renderer/src/canvas/boards/terminal/terminalSelection.ts
/**
 * xterm computes a selection cell as (clientX − rect.left) / cellWidth, but the
 * Terminal board renders inside React Flow's `transform: scale(z)` viewport: the offset
 * is in scaled screen px while cellWidth is unscaled, so the cell is off by a factor z
 * at any zoom ≠ 1. We feed xterm a corrected coordinate so its native selection lands
 * on the cell under the cursor.
 *
 * Derivation: a point at true CSS offset u renders at z·u from the visual left, and
 * rect.left IS the visual left, so clientX − rect.left = z·u. Dividing by z recovers u.
 */
export function correctClientPoint(
  client: { x: number; y: number },
  rect: { left: number; top: number },
  z: number
): { x: number; y: number } {
  if (!Number.isFinite(z) || z <= 0) return { x: client.x, y: client.y }
  return {
    x: rect.left + (client.x - rect.left) / z,
    y: rect.top + (client.y - rect.top) / z
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm vitest run src/renderer/src/canvas/boards/terminal/terminalSelection.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/renderer/src/canvas/boards/terminal/terminalSelection.ts src/renderer/src/canvas/boards/terminal/terminalSelection.test.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "feat(terminal): pure scale-correct selection coordinate math"
```

---

### Task 4.3: The capture-phase selection shim + wiring

**Files:**
- Modify: `src/renderer/src/canvas/boards/terminal/terminalSelection.ts`
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

- [ ] **Step 1: Add the shim installer to `terminalSelection.ts`**

Append:

```ts
const SENTINEL = '__caScaledMouse'

/**
 * Install a capture-phase mouse shim: rewrite each selection mouse event's coordinate
 * by the live zoom and re-dispatch a sentinel-tagged clone to xterm (mousedown → the
 * screen element, move/up → document, matching where xterm listens during a drag), so
 * xterm's native selection lands on the right cell under camera scale. No-op at z = 1.
 * Returns a disposer.
 */
export function installSelectionShim(
  wrap: HTMLElement,
  screenEl: HTMLElement,
  getZoom: () => number
): () => void {
  const clone = (e: MouseEvent): MouseEvent | null => {
    if ((e as unknown as Record<string, unknown>)[SENTINEL]) return null // our own re-dispatch
    const z = getZoom()
    if (!Number.isFinite(z) || z === 1 || z <= 0) return null // no correction needed
    const rect = screenEl.getBoundingClientRect()
    const p = correctClientPoint({ x: e.clientX, y: e.clientY }, { left: rect.left, top: rect.top }, z)
    const ev = new MouseEvent(e.type, {
      bubbles: true,
      cancelable: true,
      view: window,
      button: e.button,
      buttons: e.buttons,
      clientX: p.x,
      clientY: p.y,
      screenX: e.screenX,
      screenY: e.screenY,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey
    })
    ;(ev as unknown as Record<string, unknown>)[SENTINEL] = true
    return ev
  }

  const onDown = (e: MouseEvent): void => {
    const ev = clone(e)
    if (!ev) return
    e.stopImmediatePropagation()
    e.preventDefault()
    screenEl.dispatchEvent(ev)
  }
  const onMoveOrUp = (target: Document) => (e: MouseEvent): void => {
    const ev = clone(e)
    if (!ev) return
    e.stopImmediatePropagation()
    target.dispatchEvent(ev)
  }
  const onMove = onMoveOrUp(document)
  const onUp = onMoveOrUp(document)

  wrap.addEventListener('mousedown', onDown, true)
  window.addEventListener('mousemove', onMove, true)
  window.addEventListener('mouseup', onUp, true)
  return () => {
    wrap.removeEventListener('mousedown', onDown, true)
    window.removeEventListener('mousemove', onMove, true)
    window.removeEventListener('mouseup', onUp, true)
  }
}
```

- [ ] **Step 2: Track the live zoom + install the shim in TerminalBoard**

Add the import:

```ts
import { installSelectionShim } from './terminal/terminalSelection'
import { useOnViewportChange } from '@xyflow/react'
```

Inside `TerminalBoard`, add a zoom ref kept current by React Flow (near the other refs):

```ts
  // Live camera zoom for the selection shim (read at event time, not a render dep).
  const zoomRef = useRef(1)
  useOnViewportChange({ onChange: (vp) => (zoomRef.current = vp.zoom) })
```

In the `spawn` effect, after `term.open(el)` and the WebGL attach, install the shim (the `.xterm-screen` element exists once `term.open` ran):

```ts
    // Scale-correct selection: feed xterm coordinates corrected for the camera zoom.
    const screenEl = el.querySelector('.xterm-screen') as HTMLElement | null
    const wrapEl = el.parentElement // the nodrag/nowheel screenWrap
    const selectionDisp =
      screenEl && wrapEl ? installSelectionShim(wrapEl, screenEl, () => zoomRef.current) : null
```

In the spawn effect's cleanup return, dispose it. Find the `dataDisp.dispose()` line and add after it:

```ts
      selectionDisp?.()
```

- [ ] **Step 3: Typecheck + lint + unit**

Run: `pnpm typecheck:web && pnpm lint && pnpm vitest run src/renderer/src/canvas/boards/terminal/terminalSelection.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/renderer/src/canvas/boards/terminal/terminalSelection.ts src/renderer/src/canvas/boards/TerminalBoard.tsx
git -C "Z:\canvas-ade-terminal-io" commit -m "feat(terminal): capture-phase mouse shim → scale-correct selection on the canvas"
```

---

### Task 4.4: e2e — drag-select tracks the cursor at zoom ≠ 1

**Files:**
- Modify: `src/renderer/src/smoke/e2eHooks.ts`
- Modify: `e2e/terminalIO.e2e.ts`

- [ ] **Step 1: Add harness hooks for deterministic content + cell geometry**

In `src/renderer/src/smoke/e2eHooks.ts`, add to the `CanvasE2E` interface:

```ts
  /** Reset a terminal's buffer and write known text (selection-shim sliver). */
  resetTerminalWrite: (id: string, text: string) => void
  /** Screen-pixel center of cell (col,row) for a terminal, from the SCALED screen rect. */
  terminalCellPoint: (id: string, col: number, row: number) => { x: number; y: number } | null
```

And to the `api` object:

```ts
    resetTerminalWrite(id, text) {
      const t = e2eTerminals.get(id)
      if (!t) return
      t.reset()
      t.write(text)
    },
    terminalCellPoint(id, col, row) {
      const t = e2eTerminals.get(id)
      if (!t) return null
      const host = document.querySelector(`.react-flow__node[data-id="${id}"] .xterm-screen`)
      if (!host) return null
      const r = host.getBoundingClientRect()
      // The screen element width/height map exactly to cols/rows (no padding here), so
      // a scaled cell is r.width/cols × r.height/rows. Center the point in the cell.
      const cw = r.width / t.cols
      const ch = r.height / t.rows
      return { x: r.left + (col + 0.5) * cw, y: r.top + (row + 0.5) * ch }
    },
```

- [ ] **Step 2: Add the test**

Append inside the describe block in `e2e/terminalIO.e2e.ts`:

```ts
  test('drag-select tracks the cursor at zoom ≠ 1 (scale-correct selection)', async ({
    page,
    electronApp
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    // Frame the board, then zoom OUT so the camera scale would otherwise break selection.
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await evalIn(page, `window.__canvasE2E.setZoom(0.6)`)
    await page.waitForTimeout(150)
    // Known content at row 0, col 0.
    await evalIn(page, `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, 'ABCDEFGHIJKLMNOPQRST')`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    // Drag from the center of cell 0 to the center of cell 10 (real OS mouse input).
    const p0 = await evalIn<{ x: number; y: number }>(
      page,
      `window.__canvasE2E.terminalCellPoint(${JSON.stringify(id)}, 0, 0)`
    )
    const p1 = await evalIn<{ x: number; y: number }>(
      page,
      `window.__canvasE2E.terminalCellPoint(${JSON.stringify(id)}, 10, 0)`
    )
    await mainCall(electronApp, 'sendInput', { type: 'mouseDown', x: Math.round(p0.x), y: Math.round(p0.y), button: 'left', clickCount: 1 })
    await mainCall(electronApp, 'sendInput', { type: 'mouseMove', x: Math.round((p0.x + p1.x) / 2), y: Math.round(p0.y), button: 'left' })
    await mainCall(electronApp, 'sendInput', { type: 'mouseMove', x: Math.round(p1.x), y: Math.round(p1.y), button: 'left' })
    await mainCall(electronApp, 'sendInput', { type: 'mouseUp', x: Math.round(p1.x), y: Math.round(p1.y), button: 'left', clickCount: 1 })
    await page.waitForTimeout(100)
    const sel = await evalIn<string>(page, `window.__canvasE2E.terminalSelection(${JSON.stringify(id)})`)
    // With the shim, the selection starts at A and spans roughly the first ~10 cells.
    // Without it, the zoom-0.6 mapping would land ~6 cells short (wrong prefix/length).
    expect(sel.startsWith('ABCDEFGHIJ'), `selection was "${sel}"`).toBe(true)
  })
```

- [ ] **Step 3: Run the e2e file**

Run: `pnpm test:e2e e2e/terminalIO.e2e.ts`
Expected: 5 tests PASS. If the selection test is off-by-a-few cells on a contended host, the `startsWith('ABCDEFGHIJ')` assertion is the regression guard — a pre-shim failure is grossly wrong (≈6 cells), not off-by-one.

- [ ] **Step 4: Commit**

```bash
git -C "Z:\canvas-ade-terminal-io" add src/renderer/src/smoke/e2eHooks.ts e2e/terminalIO.e2e.ts
git -C "Z:\canvas-ade-terminal-io" commit -m "test(e2e): drag-select tracks the cursor under camera zoom"
```

---

# Final verification

- [ ] **Step 1: Full local gate**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: all PASS (new unit/integration tests included).

- [ ] **Step 2: Full e2e**

Run: `pnpm test:e2e`
Expected: the whole suite passes, including the 5 `terminalIO` tests. (Known env flake: the `browser`/`browser-gesture`/`focus-detach` trio — rerun if it flakes; memory `e2e-browser-trio-flake`.)

- [ ] **Step 3: Manual confirmation in the real app**

Run: `pnpm dev`. With a `claude` terminal board: Shift+Enter inserts a newline; select text and Ctrl+C copies; Ctrl+V pastes; copy an image + Alt+V (CC native) and Ctrl+V (staged path) both attach it; drag a file in → its path appears; right-click shows the menu; selection tracks the cursor at several zoom levels.

- [ ] **Step 4: Update the spec status + open the PR**

Flip the spec's `Status:` to `implemented`, commit, and open a PR from `fix/terminal-io` → `main`. Re-run the full gate + e2e matrix per CLAUDE.md before merge.

---

## Spec coverage check

- F1 Shift+Enter → Tasks 1.1, 1.3, 1.5 ✓
- F2a scale-correct selection → Tasks 4.1-4.4 ✓ (spike-gated, fallback documented)
- F2b copy (selection-aware Ctrl+C) → Tasks 1.1, 2.4, 2.7 ✓
- F3 paste text (Ctrl+V, bracketed via term.paste) → Tasks 2.2-2.4, 2.7 ✓
- F4 image paste (F4a Alt+V via F10; F4b staged path) → Tasks 1.4, 2.1-2.4, 3.3 ✓
- F5 drag-drop path → Tasks 3.1-3.2 ✓
- F6 context menu (mouse-mode aware) → Task 2.5 ✓
- F10 menu-null → Task 1.4 ✓
- Clipboard via MAIN IPC → Tasks 2.2-2.3 ✓
- Staging in .canvas/tmp + cleanup → Tasks 2.1, 3.2 ✓
- Security (frame-guarded, MAIN-only writes) → Tasks 2.2, 2.3 ✓
- Out of scope: F7 links, F8 search — not in any task (intentional) ✓

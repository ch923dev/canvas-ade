# Terminal Font Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user shrink/grow/reset a terminal board's xterm font per board, with a sticky last-used default so every new terminal opens at the size they last chose — and guarantee a clip-free fit (no clipped bottom row) at every supported size.

**Architecture:** A new optional `fontSize?` field on `TerminalBoard` (zero-migration). Four triggers (keyboard + Ctrl-wheel, title-bar `A−`/`A+`, Configure popover row, right-click menu) all call one persist helper (`setFont`/`nudgeFont`/`resetFont`) that clamps, persists the board pin, and writes a global `localStorage` sticky default. A single `board.fontSize`-reactive effect applies the change to the live xterm (`term.options.fontSize`) and refits the grid (→ PTY resize). The pure clamp + sticky logic lives in a new, unit-tested `terminalFont.ts`. **Workstream B** folds in the bottom-row-clip bug: it is the same cell-height → fit path, so a measure-first probe roots the cause and the fix is verified clip-free across the font×height matrix.

**Two workstreams:** A (Tasks 1–10) = the font-resize feature. B (Tasks 11–13) = clip-free fit (measure → fix → matrix), done after A so the fix holds across every font size.

**Tech Stack:** React 18, `@xterm/xterm` v5 (`term.options.fontSize` setter + FitAddon), Zustand store, Vitest (unit/integration), Playwright `_electron` (e2e).

**Worktree:** `Z:\canvas-ade-terminal-font-resize` on `feat/terminal-font-resize`. Run all commands there.

**Spec:** `docs/superpowers/specs/2026-06-08-terminal-font-resize-design.md`.

**Conventions:** TypeScript strict, no unused locals/params. Commit per task. Match existing file style. Gate before handoff: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` (and e2e in Task 10). All commands run from the worktree root.

---

## File structure

- **Create** `src/renderer/src/canvas/boards/terminal/terminalFont.ts` — pure constants, clamp, sticky store, initial-size resolver.
- **Create** `src/renderer/src/canvas/boards/terminal/terminalFont.test.ts` — unit tests for the above.
- **Modify** `src/renderer/src/canvas/boards/terminal/terminalKeymap.ts` — font chords (`Ctrl/Cmd +/-/0`).
- **Modify** `src/renderer/src/canvas/boards/terminal/terminalKeymap.test.ts` — chord + handler tests.
- **Modify** `src/renderer/src/lib/boardSchema.ts` — `TerminalBoard.fontSize?` + `assertBoard` validation (NO version bump).
- **Modify** `src/renderer/src/lib/boardSchema.test.ts` — round-trip + reject tests.
- **Modify** `src/renderer/src/store/canvasStore.ts` — `PATCHABLE_KEYS.terminal += 'fontSize'`.
- **Modify** `src/renderer/src/store/canvasStore.test.ts` — patch-accept + cross-type-drop tests.
- **Modify** `src/renderer/src/canvas/boards/TerminalBoard.tsx` — refs, initial size, reactive effect, `setFont`/`nudgeFont`/`resetFont`, keymap wiring, Ctrl-wheel listener, title-bar buttons, right-click entries, pass props to TerminalConfig.
- **Modify** `src/renderer/src/canvas/boards/TerminalConfig.tsx` — live `Font size` row (`A−`/`A+`).
- **Modify** `src/renderer/src/smoke/e2eHooks.ts` — `terminalFontSize(id)` hook, plus (Workstream B) `terminalGeometry(id)` + `setBoardSize(id, w, h)` hooks.
- **Create** `e2e/terminalFont.e2e.ts` — keyboard-resize + sticky-inherit e2e.
- **Create** `docs/decisions/0005-terminal-font-size.md` — ADR.
- **Modify** `src/renderer/src/canvas/boards/TerminalBoard.tsx` — (Workstream B) clip-free fit: `screen` bottom padding, a whole-cell fit wrapper, and a `devicePixelRatio`-change refit listener.
- **Create** `e2e/terminalClip.e2e.ts` — Workstream B probe sweep → clip-free regression matrix.

---

## Task 1: Pure font helper (`terminalFont.ts`)

**Files:**
- Create: `src/renderer/src/canvas/boards/terminal/terminalFont.ts`
- Test: `src/renderer/src/canvas/boards/terminal/terminalFont.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/renderer/src/canvas/boards/terminal/terminalFont.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_FONT,
  MAX_TERMINAL_FONT,
  MIN_TERMINAL_FONT,
  clampTerminalFont,
  readStickyFont,
  resolveInitialFont,
  writeStickyFont
} from './terminalFont'

afterEach(() => window.localStorage.clear())

describe('clampTerminalFont', () => {
  it('clamps to [MIN, MAX]', () => {
    expect(clampTerminalFont(2)).toBe(MIN_TERMINAL_FONT)
    expect(clampTerminalFont(99)).toBe(MAX_TERMINAL_FONT)
    expect(clampTerminalFont(14)).toBe(14)
  })
  it('returns the default for non-finite input', () => {
    expect(clampTerminalFont(NaN)).toBe(DEFAULT_TERMINAL_FONT)
    expect(clampTerminalFont(Infinity)).toBe(DEFAULT_TERMINAL_FONT)
  })
})

describe('sticky store', () => {
  it('reads the default when unset', () => {
    expect(readStickyFont()).toBe(DEFAULT_TERMINAL_FONT)
  })
  it('round-trips a written value, clamped', () => {
    writeStickyFont(11)
    expect(readStickyFont()).toBe(11)
    writeStickyFont(99)
    expect(readStickyFont()).toBe(MAX_TERMINAL_FONT)
  })
  it('falls back to the default on garbage', () => {
    window.localStorage.setItem('ca.terminal.fontSize', 'not-a-number')
    expect(readStickyFont()).toBe(DEFAULT_TERMINAL_FONT)
  })
})

describe('resolveInitialFont', () => {
  it('uses the board pin when present (clamped)', () => {
    writeStickyFont(11)
    expect(resolveInitialFont(16)).toBe(16)
  })
  it('falls back to the sticky default when the pin is absent', () => {
    writeStickyFont(11)
    expect(resolveInitialFont(undefined)).toBe(11)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/terminal/terminalFont.test.ts`
Expected: FAIL — `Cannot find module './terminalFont'`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/src/canvas/boards/terminal/terminalFont.ts`:

```ts
/**
 * Per-board terminal font size: bounds, clamp, and the global "sticky" last-used
 * default. Pure (the only side effect is localStorage, guarded). The TerminalBoard
 * persists the per-board pin in `board.fontSize`; the sticky default seeds the size
 * of the NEXT terminal so the user pays the "too big" adjustment once, not per board.
 * See docs/decisions/0005-terminal-font-size.md.
 */
export const DEFAULT_TERMINAL_FONT = 12.5
export const MIN_TERMINAL_FONT = 8
export const MAX_TERMINAL_FONT = 22

/** localStorage key for the global new-terminal default (per machine, all projects). */
const STICKY_KEY = 'ca.terminal.fontSize'

/** Clamp to [MIN, MAX]; non-finite input collapses to the default. */
export function clampTerminalFont(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_FONT
  return Math.min(MAX_TERMINAL_FONT, Math.max(MIN_TERMINAL_FONT, n))
}

/** Read the sticky default (clamped). Default on miss / parse-fail / no storage. */
export function readStickyFont(): number {
  try {
    const raw = window.localStorage.getItem(STICKY_KEY)
    if (raw == null) return DEFAULT_TERMINAL_FONT
    return clampTerminalFont(Number.parseFloat(raw))
  } catch {
    return DEFAULT_TERMINAL_FONT
  }
}

/** Persist the sticky default (clamped). No-op if storage is unavailable. */
export function writeStickyFont(n: number): void {
  try {
    window.localStorage.setItem(STICKY_KEY, String(clampTerminalFont(n)))
  } catch {
    /* storage disabled (private mode / test) — the sticky default just won't persist */
  }
}

/** Initial size for a board: its own pin if set, else the sticky default. */
export function resolveInitialFont(boardFontSize: number | undefined): number {
  return boardFontSize != null ? clampTerminalFont(boardFontSize) : readStickyFont()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/terminal/terminalFont.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/terminal/terminalFont.ts src/renderer/src/canvas/boards/terminal/terminalFont.test.ts
git commit -m "feat(terminal): pure font-size helper (clamp + sticky default)"
```

---

## Task 2: Keymap font chords (`terminalKeymap.ts`)

**Files:**
- Modify: `src/renderer/src/canvas/boards/terminal/terminalKeymap.ts`
- Test: `src/renderer/src/canvas/boards/terminal/terminalKeymap.test.ts`

- [ ] **Step 1: Add the failing tests**

In `terminalKeymap.test.ts`, append these inside the existing `describe('resolveTerminalKey', …)` block (before its closing `})` on line 74):

```ts
  it('Ctrl+- and Ctrl+_ → fontDec (Windows)', () => {
    expect(resolveTerminalKey(chord('-', { ctrlKey: true }), WIN)).toEqual({ kind: 'fontDec' })
    expect(resolveTerminalKey(chord('_', { ctrlKey: true }), WIN)).toEqual({ kind: 'fontDec' })
  })
  it('Ctrl+= and Ctrl++ → fontInc (Windows)', () => {
    expect(resolveTerminalKey(chord('=', { ctrlKey: true }), WIN)).toEqual({ kind: 'fontInc' })
    expect(resolveTerminalKey(chord('+', { ctrlKey: true }), WIN)).toEqual({ kind: 'fontInc' })
  })
  it('Ctrl+0 → fontReset (Windows)', () => {
    expect(resolveTerminalKey(chord('0', { ctrlKey: true }), WIN)).toEqual({ kind: 'fontReset' })
  })
  it('mac: Cmd is the primary modifier for font chords; Ctrl+- does not', () => {
    expect(resolveTerminalKey(chord('-', { metaKey: true }), { hasSelection: false, isMac: true })).toEqual({ kind: 'fontDec' })
    expect(resolveTerminalKey(chord('-', { ctrlKey: true }), { hasSelection: false, isMac: true })).toBeNull()
  })
  it('plain -/=/0 (no modifier) → null', () => {
    expect(resolveTerminalKey(chord('-'), WIN)).toBeNull()
    expect(resolveTerminalKey(chord('='), WIN)).toBeNull()
    expect(resolveTerminalKey(chord('0'), WIN)).toBeNull()
  })
  it('Alt+Ctrl+- → null (Alt reserved)', () => {
    expect(resolveTerminalKey(chord('-', { ctrlKey: true, altKey: true }), WIN)).toBeNull()
  })
```

Also extend the `handleTerminalKey` spy harness so the effects type stays satisfied. First update the `spyFx` return-type annotation (line 107) so the new counters are accessible:

```ts
  const spyFx = (
    over: Partial<TerminalKeyEffects> = {}
  ): TerminalKeyEffects & {
    calls: { newline: number; copy: number; paste: number; fontStep: number; fontReset: number }
  } => {
```

Then change the `calls` object and add the two methods in the body:

```ts
    const calls = { newline: 0, copy: 0, paste: 0, fontStep: 0, fontReset: 0 }
    return {
      calls,
      newline: () => {
        calls.newline++
      },
      copySelection: () => {
        calls.copy++
        return true
      },
      paste: () => {
        calls.paste++
      },
      fontStep: () => {
        calls.fontStep++
      },
      fontReset: () => {
        calls.fontReset++
      },
      ...over
    }
```

Update the "unowned key" assertion (line 169) to include the new counters:

```ts
    expect(fx.calls).toEqual({ newline: 0, copy: 0, paste: 0, fontStep: 0, fontReset: 0 })
```

And add a handler test inside `describe('handleTerminalKey …')` (before its closing `})` on line 171):

```ts
  it('Ctrl+-: preventDefault + fontStep(-1) + returns false', () => {
    const e = evt('-', { ctrlKey: true })
    const fx = spyFx()
    expect(handleTerminalKey(e, WIN, fx)).toBe(false)
    expect(e.prevented).toBe(true)
    expect(fx.calls.fontStep).toBe(1)
  })
  it('Ctrl+0: preventDefault + fontReset + returns false', () => {
    const e = evt('0', { ctrlKey: true })
    const fx = spyFx()
    expect(handleTerminalKey(e, WIN, fx)).toBe(false)
    expect(e.prevented).toBe(true)
    expect(fx.calls.fontReset).toBe(1)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/terminal/terminalKeymap.test.ts`
Expected: FAIL — `resolveTerminalKey` returns `null` for the font chords; `fontStep`/`fontReset` are not on `TerminalKeyEffects` (type error in `spyFx`).

- [ ] **Step 3: Implement the keymap changes**

In `terminalKeymap.ts`, extend the action union (line 22):

```ts
export type TerminalKeyAction =
  | { kind: 'newline' }
  | { kind: 'copy' }
  | { kind: 'paste' }
  | { kind: 'fontInc' }
  | { kind: 'fontDec' }
  | { kind: 'fontReset' }
```

In `resolveTerminalKey`, insert the font block right after `const primary = …` (line 47) and BEFORE the `if (!primary || e.altKey) return null` guard:

```ts
  const primary = ctx.isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey

  // Font-size chords: primary modifier (Cmd on mac, Ctrl else), no Alt/Shift. We
  // deliberately SHADOW these from the shell — matches VS Code / iTerm terminal zoom.
  if (primary && !e.altKey && !e.shiftKey) {
    if (e.key === '=' || e.key === '+') return { kind: 'fontInc' }
    if (e.key === '-' || e.key === '_') return { kind: 'fontDec' }
    if (e.key === '0') return { kind: 'fontReset' }
  }

  if (!primary || e.altKey) return null
```

Extend `TerminalKeyEffects` (after the `paste()` member, ~line 66):

```ts
  /** Smart-paste clipboard contents into the terminal (image → staged path, else text). */
  paste(): void
  /** Nudge the per-board font size by `delta` px (clamped by the board). */
  fontStep(delta: number): void
  /** Reset the per-board font size to the default. */
  fontReset(): void
```

Extend `handleTerminalKey`'s tail (the block after the copy branch, lines 96–99):

```ts
  e.preventDefault()
  if (action.kind === 'newline') fx.newline()
  else if (action.kind === 'paste') fx.paste()
  else if (action.kind === 'fontInc') fx.fontStep(1)
  else if (action.kind === 'fontDec') fx.fontStep(-1)
  else if (action.kind === 'fontReset') fx.fontReset()
  return false
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/renderer/src/canvas/boards/terminal/terminalKeymap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/terminal/terminalKeymap.ts src/renderer/src/canvas/boards/terminal/terminalKeymap.test.ts
git commit -m "feat(terminal): own Ctrl/Cmd +/-/0 font chords in the keymap"
```

---

## Task 3: Schema field + store patch key

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts`
- Test: `src/renderer/src/lib/boardSchema.test.ts`
- Modify: `src/renderer/src/store/canvasStore.ts`
- Test: `src/renderer/src/store/canvasStore.test.ts`

- [ ] **Step 1: Add the failing tests**

In `boardSchema.test.ts`, add (match the existing imports — `createBoard`, `toObject`, `fromObject`, `SCHEMA_VERSION`, and the `TerminalBoard` type are already used in that file; add any missing to the import line):

```ts
describe('terminal fontSize (zero-migration optional field)', () => {
  it('round-trips a terminal fontSize', () => {
    const board = { ...createBoard('terminal', { id: 't1', x: 0, y: 0 }), fontSize: 11 } as TerminalBoard
    const restored = fromObject(toObject([board], null))
    expect((restored.boards[0] as TerminalBoard).fontSize).toBe(11)
  })
  it('an old terminal without fontSize still parses (field absent)', () => {
    const board = createBoard('terminal', { id: 't1', x: 0, y: 0 })
    const restored = fromObject(toObject([board], null))
    expect((restored.boards[0] as TerminalBoard).fontSize).toBeUndefined()
  })
  it('rejects a non-numeric terminal fontSize', () => {
    const doc = {
      schemaVersion: SCHEMA_VERSION,
      viewport: null,
      boards: [{ ...createBoard('terminal', { id: 't1', x: 0, y: 0 }), fontSize: 'big' }],
      connectors: [],
      groups: []
    }
    expect(() => fromObject(doc)).toThrow(/fontSize/)
  })
})
```

In `canvasStore.test.ts`, add (the file already imports `useCanvasStore`; add `createBoard` + the `TerminalBoard` type to its imports from `'../lib/boardSchema'` if not present):

```ts
describe('terminal fontSize patch', () => {
  it('updateBoard persists fontSize on a terminal (PATCHABLE_KEYS.terminal)', () => {
    const t = createBoard('terminal', { id: 't1', x: 0, y: 0 }) as TerminalBoard
    useCanvasStore.setState({ boards: [t], past: [], future: [] })
    useCanvasStore.getState().updateBoard('t1', { fontSize: 11 })
    expect((useCanvasStore.getState().boards[0] as TerminalBoard).fontSize).toBe(11)
  })
  it('drops a fontSize patched onto a browser (cross-type guard)', () => {
    const b = createBoard('browser', { id: 'b1', x: 0, y: 0 })
    useCanvasStore.setState({ boards: [b], past: [], future: [] })
    useCanvasStore.getState().updateBoard('b1', { fontSize: 11 } as Partial<TerminalBoard>)
    expect((useCanvasStore.getState().boards[0] as Record<string, unknown>).fontSize).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/renderer/src/lib/boardSchema.test.ts src/renderer/src/store/canvasStore.test.ts`
Expected: FAIL — `fontSize` not accepted by `updateBoard` (dropped → undefined), and the non-numeric case does not throw.

- [ ] **Step 3: Implement the schema + store changes**

In `boardSchema.ts`, add the optional field to `TerminalBoard` (after `agentTranscriptPath?`, ~line 68):

```ts
  /**
   * Per-board xterm font size in px. Absent ⇒ use the sticky default (else 12.5). Optional
   * + default-at-read ⇒ NO SCHEMA_VERSION bump (mirrors previewSourceId / agentSessionId).
   */
  fontSize?: number
```

In `assertBoard`'s `case 'terminal':` block, add after the `agentTranscriptPath` check (after line 532, before `return`):

```ts
      if (b.fontSize !== undefined && !isFiniteNum(b.fontSize)) {
        fail('terminal fontSize is not a number')
      }
```

(`toObject` uses `structuredClone(boards)`, so it serializes `fontSize` automatically — no change there. Do NOT touch `SCHEMA_VERSION` or `MIGRATIONS`.)

In `canvasStore.ts`, add `'fontSize'` to `PATCHABLE_KEYS.terminal` (the array at ~line 381):

```ts
  terminal: [
    ...COMMON_KEYS,
    'shell',
    'launchCommand',
    'cwd',
    'port',
    'agentSessionId',
    'agentTranscriptPath',
    'fontSize'
  ],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/renderer/src/lib/boardSchema.test.ts src/renderer/src/store/canvasStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/boardSchema.ts src/renderer/src/lib/boardSchema.test.ts src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts
git commit -m "feat(terminal): persist optional fontSize (no schema bump) + PATCHABLE key"
```

---

## Task 4: TerminalBoard core — initial size, reactive apply, persist actions, keymap wiring

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

This wires the live term. No new unit test (covered by the e2e in Task 10); verify with typecheck + the existing suite.

- [ ] **Step 1: Add the import**

After the `useTerminalFlip` import (line 53), add:

```ts
import {
  clampTerminalFont,
  readStickyFont,
  resolveInitialFont,
  writeStickyFont,
  DEFAULT_TERMINAL_FONT
} from './terminal/terminalFont'
```

- [ ] **Step 2: Add the store `updateBoard` selector + font refs**

Near the existing `projectDir` selector (line 220), add:

```ts
  const updateBoard = useCanvasStore((s) => s.updateBoard)
```

After the `startLaunchRef` declaration (line 173), add the font refs:

```ts
  // board.fontSize for the spawn closure's INITIAL xterm construction, read via a ref so
  // a size change never becomes a spawn dep (which would respawn the PTY). Mirrors lodRef.
  const fontSizeRef = useRef<number | undefined>(board.fontSize)
  // Keymap effects + the Ctrl-wheel listener call the latest nudge/reset through refs so
  // the spawn callback's identity stays stable (no respawn when the font handlers change).
  const fontStepRef = useRef<(delta: number) => void>(() => {})
  const fontResetRef = useRef<() => void>(() => {})
  // Trailing timer that coalesces a burst of nudges (Ctrl-wheel / held key) into one undo step.
  const fontBurstRef = useRef<ReturnType<typeof setTimeout> | null>(null)
```

Keep `fontSizeRef` synced — add after the existing `lodRef` sync effect (after line 227):

```ts
  useEffect(() => {
    fontSizeRef.current = board.fontSize
  }, [board.fontSize])
```

- [ ] **Step 3: Use the resolved initial size in the xterm constructor**

In `spawn`, replace the hard-coded line (line 361):

```ts
      fontSize: 12.5,
```

with:

```ts
      fontSize: resolveInitialFont(fontSizeRef.current),
```

- [ ] **Step 4: Add the persist actions + the reactive apply effect**

Immediately after the `useEffect(() => spawn(), [spawn])` line (line 594), add:

```ts
  // ── Per-board font size ───────────────────────────────────────────────────────
  // Persist path (the four triggers call these — they never touch xterm directly):
  const setFont = useCallback(
    (next: number): void => {
      const clamped = clampTerminalFont(next)
      if (clamped === clampTerminalFont(board.fontSize ?? readStickyFont())) return // no-op at bound
      // Leading-edge undo checkpoint: snapshot once per burst so a Ctrl-wheel / held-key run
      // collapses into ONE undo step; the trailing timer ends the burst (beginChange dedups).
      if (fontBurstRef.current === null) useCanvasStore.getState().beginChange()
      if (fontBurstRef.current) clearTimeout(fontBurstRef.current)
      fontBurstRef.current = setTimeout(() => {
        fontBurstRef.current = null
      }, 500)
      updateBoard(board.id, { fontSize: clamped }) // persist the per-board pin
      writeStickyFont(clamped) // update the new-terminal default
    },
    [board.id, board.fontSize, updateBoard]
  )
  const nudgeFont = useCallback(
    (delta: number): void =>
      setFont((termRef.current?.options.fontSize ?? DEFAULT_TERMINAL_FONT) + delta),
    [setFont]
  )
  const resetFont = useCallback((): void => setFont(DEFAULT_TERMINAL_FONT), [setFont])

  // Keep the keymap/wheel refs pointed at the latest handlers (stable spawn identity).
  useEffect(() => {
    fontStepRef.current = nudgeFont
    fontResetRef.current = resetFont
  }, [nudgeFont, resetFont])

  // Apply a persisted font change to the LIVE term + reflow the grid (→ PTY resize). Keyed on
  // board.fontSize ONLY (NOT a spawn dep) so resizing never respawns the PTY. Reads the sticky
  // default for an unpinned board (dep never changes → runs once on mount, after construction).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const fs = clampTerminalFont(board.fontSize ?? readStickyFont())
    if (term.options.fontSize === fs) return
    term.options.fontSize = fs
    try {
      fitRef.current?.fit() // unfitted well (LOD / display:none) → applies on the next RO fit
    } catch {
      /* element not laid out yet */
    }
  }, [board.fontSize])

  // Clear the burst timer on unmount.
  useEffect(
    () => () => {
      if (fontBurstRef.current) clearTimeout(fontBurstRef.current)
    },
    []
  )
```

- [ ] **Step 5: Wire the keymap effects in `spawn`**

In `spawn`'s `attachCustomKeyEventHandler` effects object (the object passed as the 3rd arg, lines 422–433), add two members after `paste`:

```ts
          paste: () => void pasteIntoTerminal(term, board.id),
          fontStep: (d) => fontStepRef.current(d),
          fontReset: () => fontResetRef.current()
```

- [ ] **Step 6: Verify typecheck + the existing suite still pass**

Run: `pnpm typecheck`
Expected: PASS (no type errors).

Run: `pnpm exec vitest run src/renderer/src/canvas/boards`
Expected: PASS — existing TerminalBoard tests (e.g. `TerminalBoard.paste.test.ts`) unaffected.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "feat(terminal): live per-board font apply + persist actions + keymap wiring"
```

---

## Task 5: Ctrl+wheel font zoom

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

- [ ] **Step 1: Add the native, non-passive wheel listener**

After the burst-timer cleanup effect added in Task 4, add:

```ts
  // Ctrl+wheel font zoom over the well (VS Code / iTerm idiom; macOS pinch arrives as
  // ctrl-wheel). NATIVE non-passive listener — React's synthetic onWheel is passive, so
  // preventDefault would no-op. The screen div is inside `.nowheel`, so React Flow never
  // zooms; we stop plain-wheel scrollback only when Ctrl is held.
  useEffect(() => {
    const el = screenRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      e.stopPropagation()
      fontStepRef.current(e.deltaY < 0 ? 1 : -1)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])
```

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "feat(terminal): Ctrl+wheel font zoom over the well"
```

---

## Task 6: Title-bar `A−` / `A+` buttons

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

- [ ] **Step 1: Add the buttons to the actions group, revealed on hover/select**

In the `actions` JSX (lines 721–753), insert this as the FIRST child right after the opening `<>` (line 722):

```tsx
      {(selected || hovered) && (
        <>
          <IconBtn name="minus" title="Smaller font (Ctrl -)" onClick={() => nudgeFont(-1)} />
          <IconBtn name="plus" title="Bigger font (Ctrl +)" onClick={() => nudgeFont(1)} />
        </>
      )}
```

(`selected` and `hovered` are already destructured props on `TerminalBoard`. `minus`/`plus` are existing `IconName`s. Buttons stay enabled; `setFont` clamps so they no-op at the 8/22 bounds.)

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "feat(terminal): title-bar A-/A+ font buttons (revealed on hover/select)"
```

---

## Task 7: Right-click menu font entries

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

- [ ] **Step 1: Append font entries to the well context menu**

In the `menuEntries` `useMemo` (lines 770–812), add three entries after the `clear` entry (after its closing `}` near line 808, inside the array):

```tsx
            {
              kind: 'action',
              id: 'font-bigger',
              label: 'Bigger font',
              onSelect: () => nudgeFont(1)
            },
            {
              kind: 'action',
              id: 'font-smaller',
              label: 'Smaller font',
              onSelect: () => nudgeFont(-1)
            },
            {
              kind: 'action',
              id: 'font-reset',
              label: 'Reset font',
              onSelect: () => resetFont()
            }
```

Add `nudgeFont` and `resetFont` to the `useMemo` dependency array (currently `[menu, board.id]`):

```ts
    [menu, board.id, nudgeFont, resetFont]
```

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "feat(terminal): Bigger/Smaller/Reset font entries in the well menu"
```

---

## Task 8: Configure popover font row

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalConfig.tsx`
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx` (pass the two props)

- [ ] **Step 1: Pass `fontSize` + `onSetFont` from TerminalBoard**

In `TerminalBoard.tsx`, update the `TerminalConfig` render (line 871):

```tsx
              {configOpen && (
                <TerminalConfig
                  board={board}
                  onClose={() => setConfigOpen(false)}
                  fontSize={clampTerminalFont(board.fontSize ?? readStickyFont())}
                  onSetFont={setFont}
                />
              )}
```

- [ ] **Step 2: Add the props + the live `Font size` row to TerminalConfig**

In `TerminalConfig.tsx`, extend the props (the destructured signature, lines 18–24):

```tsx
export function TerminalConfig({
  board,
  onClose,
  fontSize,
  onSetFont
}: {
  board: TerminalBoardData
  onClose: () => void
  fontSize: number
  onSetFont: (next: number) => void
}): ReactElement {
```

Add the row immediately after the `Working dir` `<label>` block (after line 140, before the `<div style={footer}>`):

```tsx
      <div style={lbl}>
        Font size
        <div style={fontRow}>
          <button type="button" style={stepBtn} onClick={() => onSetFont(fontSize - 1)}>
            A−
          </button>
          <span style={fontVal}>{fontSize}</span>
          <button type="button" style={stepBtn} onClick={() => onSetFont(fontSize + 1)}>
            A+
          </button>
        </div>
      </div>
```

Add the three styles next to the other `const` styles at the bottom of the file (after `footer`, ~line 208):

```ts
const fontRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8
}
const stepBtn: React.CSSProperties = {
  height: 26,
  width: 34,
  borderRadius: 'var(--r-ctl)',
  border: '1px solid var(--border-subtle)',
  background: 'var(--inset)',
  color: 'var(--text)',
  fontFamily: 'var(--ui)',
  fontSize: 13,
  cursor: 'pointer'
}
const fontVal: React.CSSProperties = {
  minWidth: 34,
  textAlign: 'center',
  fontFamily: 'var(--mono)',
  fontSize: 12,
  color: 'var(--text-2)'
}
```

(The row is **live** — `onSetFont` is the board's `setFont`, so a click applies to the term immediately via the reactive effect and updates the sticky default. It is NOT gated behind `Apply & restart`; `apply()` never touches `fontSize`, so changing the font then hitting Cancel keeps the already-applied size.)

- [ ] **Step 3: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalConfig.tsx src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "feat(terminal): live Font size row in the Configure popover"
```

---

## Task 9: e2e hook

**Files:**
- Modify: `src/renderer/src/smoke/e2eHooks.ts`

- [ ] **Step 1: Add the `terminalFontSize` hook to the interface + implementation**

In the E2E hooks interface, add near `terminalMounted` (line 123):

```ts
  /** The live xterm font size for a terminal board (px), or undefined if not mounted. */
  terminalFontSize: (id: string) => number | undefined
```

In the returned object, add near the `terminalMounted` implementation (line 373):

```ts
    terminalFontSize(id) {
      return e2eTerminals.get(id)?.options.fontSize
    },
```

- [ ] **Step 2: Verify typecheck passes**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/smoke/e2eHooks.ts
git commit -m "test(terminal): e2e hook to read the live xterm font size"
```

---

## Task 10: e2e test + ADR + full gate

**Files:**
- Create: `e2e/terminalFont.e2e.ts`
- Create: `docs/decisions/0005-terminal-font-size.md`

- [ ] **Step 1: Write the e2e test**

Create `e2e/terminalFont.e2e.ts`:

```ts
// e2e/terminalFont.e2e.ts
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

const fontOf = (id: string) => `window.__canvasE2E.terminalFontSize(${JSON.stringify(id)})`

test.describe('terminal font resize', () => {
  test('Ctrl+- shrinks the live font and persists it on the board', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    const before = await evalIn<number>(page, fontOf(id))
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(id)}, { key: '-', ctrlKey: true })`
    )
    const shrank = await pollEval(page, `${fontOf(id)} < ${before}`, 3000)
    expect(shrank, 'live font shrank by Ctrl+-').toBe(true)
    const persisted = await evalIn<number>(
      page,
      `window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(id)}).fontSize`
    )
    expect(persisted).toBe(before - 1)
  })

  test('a new terminal inherits the sticky last-used size', async ({ page }) => {
    const a = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(a)})`, 8000)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(a)})`)
    const start = await evalIn<number>(page, fontOf(a))
    // shrink once and wait for the live apply to settle, then read the sticky size.
    await evalIn(
      page,
      `window.__canvasE2E.dispatchTerminalKey(${JSON.stringify(a)}, { key: '-', ctrlKey: true })`
    )
    await pollEval(page, `${fontOf(a)} === ${start - 1}`, 3000)
    const sticky = start - 1
    const b = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(b)})`, 8000)
    const inherited = await pollEval(page, `${fontOf(b)} === ${sticky}`, 3000)
    expect(inherited, 'new terminal opened at the sticky size').toBe(true)
  })
})
```

- [ ] **Step 2: Build + run the e2e (Windows leg)**

Run: `pnpm test:e2e -- terminalFont`
Expected: PASS — both tests green. (`pnpm test:e2e` runs `pretest:e2e` = `electron-vite build` first, so the source changes are in the app under test. Do NOT use bare `pnpm exec playwright test` — it skips the build, memory `e2e-playwright-build-gotcha`.)

- [ ] **Step 3: Write the ADR**

Create `docs/decisions/0005-terminal-font-size.md`:

```markdown
# ADR 0005 — Per-board terminal font size

**Status:** Accepted · **Date:** 2026-06-08 · **Sibling of:** ADR 0004 (planning text font controls).

## Context
The terminal board's xterm font was a hard-coded `12.5px`. On some displays it reads too large, and
the pain recurred on every new terminal — there was no per-board control and no way to shift the
default.

## Decision
Add a per-board font size: an optional `TerminalBoard.fontSize?` (numeric, clamped `[8, 22]`, step 1,
reset `12.5`). Four user triggers — keyboard (`Ctrl/Cmd +/-/0`) + Ctrl-wheel, title-bar `A−`/`A+`,
the Configure popover row, and the well right-click menu — all funnel into one persist helper. A
`board.fontSize`-reactive effect applies the change to the live xterm and refits (→ PTY resize). A
global `localStorage` **sticky default** (`ca.terminal.fontSize`) seeds the size of the next terminal,
so the adjustment is paid once.

## What stays cut
Font family / weight / line-height controls; a global Settings-modal panel; any change to the Browser
or Planning boards. We deliberately shadow `Ctrl+=`/`Ctrl+-`/`Ctrl+0` from the shell (VS Code / iTerm
parity).

## Consequences
- **No `SCHEMA_VERSION` bump.** `fontSize?` is optional + default-at-read (mirrors `previewSourceId` /
  `agentSessionId`); old docs parse unchanged. This keeps schema **v8 free** for the Mermaid diagram
  element (ADR 0004) and avoids collision with the in-flight `text-create-edit-ux` work.
- Reversible: dropping the controls leaves `fontSize` data that still validates.
- **Clip-free fit folded in.** Because font size IS cell height, this feature subsumes the bottom-row
  clip bug: a measure-first probe roots the cause and a `fitWhole` wrapper + 12px padding + a
  `devicePixelRatio`-change refit keep the grid within the well at every size. `BoardFrame`'s
  `overflow:hidden` is unchanged — the grid sizing is fixed, not the clip.
```

- [ ] **Step 4: Run the full local gate**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: typecheck clean · lint 0 errors · format clean · all unit+integration tests green (existing baseline + the new tests).

(If `format:check` flags the new files, run `pnpm format` and re-stage — memory `gate-must-run-format-check`.)

- [ ] **Step 5: Commit**

```bash
git add e2e/terminalFont.e2e.ts docs/decisions/0005-terminal-font-size.md
git commit -m "test(terminal): e2e font-resize + sticky-inherit; ADR 0005"
```

- [ ] **Step 6: Run the e2e matrix before handoff (memory `e2e-before-handoff`)**

Run: `pnpm test:e2e:matrix`
Expected: Windows-native + Linux-Docker legs both green (Docker must be running for the Linux leg). The terminal trio is not in the known browser-trio flake set; a clean run is expected.

---

# Workstream B — clip-free fit (folds in the bottom-row-clip bug)

> **MEASURE BEFORE FIXING.** Task 11 is a runtime probe that captures the actual geometry and turns
> the clip into a failing assertion. Task 12 selects a fix FROM THE PROBE NUMBERS (candidates coded
> below) — do not pick one before reading Task 11's output. Do these tasks AFTER Workstream A (the
> fix must hold across font sizes, and the font-change refit from Task 4 is part of the guarantee).
> `BoardFrame.tsx:437` `overflow:hidden` STAYS — fix the grid sizing, not the clip. No
> preload/sandbox changes.

## Task 11: Probe — measure the clip (red test + geometry capture)

**Files:**
- Modify: `src/renderer/src/smoke/e2eHooks.ts`
- Create: `e2e/terminalClip.e2e.ts`

- [ ] **Step 1: Add the geometry + resize e2e hooks**

In `e2eHooks.ts`, add to the interface (near `terminalFontSize`):

```ts
  /** Rendered terminal geometry for the clip probe: rects of the live xterm sub-elements vs the
   *  clipping well, plus dpr/rows/cols. Null if not mounted. */
  terminalGeometry: (id: string) =>
    | null
    | {
        dpr: number
        rows: number
        cols: number
        cellHeight: number
        gridBottom: number
        wellBottom: number
        overflow: number
      }
  /** Drive a REAL board resize (store → React Flow → the well ResizeObserver → fit). */
  setBoardSize: (id: string, w: number, h: number) => void
  /** Pin a terminal's font size (drives the reactive apply + refit). For the clip×font matrix. */
  setBoardFont: (id: string, px: number) => void
```

In the returned object, add:

```ts
    terminalGeometry(id) {
      const term = e2eTerminals.get(id)
      if (!term) return null
      const node = document.querySelector(`.react-flow__node[data-id="${id}"]`)
      const screenEl = node?.querySelector('.xterm-screen') as HTMLElement | null
      const wellEl = (node?.querySelector('.xterm') as HTMLElement | null)?.closest(
        '.nowheel'
      ) as HTMLElement | null
      if (!screenEl || !wellEl) return null
      const grid = screenEl.getBoundingClientRect()
      const well = wellEl.getBoundingClientRect()
      return {
        dpr: window.devicePixelRatio,
        rows: term.rows,
        cols: term.cols,
        cellHeight: grid.height / Math.max(1, term.rows),
        gridBottom: grid.bottom,
        wellBottom: well.bottom,
        overflow: grid.bottom - well.bottom // > 0 ⇒ the grid spills past the clip boundary
      }
    },
    setBoardSize(id, w, h) {
      useCanvasStore.getState().resizeBoard(id, w, h)
    },
    setBoardFont(id, px) {
      useCanvasStore.getState().updateBoard(id, { fontSize: px })
    },
```

- [ ] **Step 2: Write the probe sweep (it doubles as the regression in Task 13)**

Create `e2e/terminalClip.e2e.ts`:

```ts
// e2e/terminalClip.e2e.ts
import { test, expect } from './fixtures'
import { evalIn, pollEval, seed } from './helpers'

type Geo = { dpr: number; rows: number; cols: number; cellHeight: number; gridBottom: number; wellBottom: number; overflow: number }
const geoOf = (id: string) => `window.__canvasE2E.terminalGeometry(${JSON.stringify(id)})`
const TOLERANCE = 1 // px — sub-pixel rounding only; a clipped glyph is ≥ ~6px

test.describe('terminal clip-free fit', () => {
  test('the grid never spills past the well across a height sweep', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    // Fill down to the last row so a clipped row shows a glyph, not whitespace.
    await evalIn(
      page,
      `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, Array.from({length: 60}, (_, i) => 'ROW' + i).join('\\r\\n'))`
    )
    const offenders: Array<{ h: number } & Geo> = []
    // Odd step hits fractional remainders that a coarse step would skip.
    for (let h = 200; h <= 620; h += 7) {
      await evalIn(page, `window.__canvasE2E.setBoardSize(${JSON.stringify(id)}, 460, ${h})`)
      await page.waitForTimeout(60) // let the ResizeObserver fit + xterm render settle
      const geo = await evalIn<Geo | null>(page, geoOf(id))
      if (geo && geo.overflow > TOLERANCE) offenders.push({ h, ...geo })
    }
    expect(
      offenders,
      `bottom-row clip at heights (overflow px shown): ${JSON.stringify(offenders, null, 2)}`
    ).toEqual([])
  })
})
```

- [ ] **Step 3: Build + run the probe — capture the measurement**

Run: `pnpm test:e2e -- terminalClip`
Expected on the CURRENT code: **FAIL** if the bug reproduces — the failure message lists each offending
`{ h, dpr, rows, cellHeight, gridBottom, wellBottom, overflow }`. **Read this output — it is the
root-cause measurement.** Note the pattern (does `overflow` grow with `rows`? is `cellHeight`
fractional under dpr ≠ 1? is `overflow` ≈ a constant sub-cell remainder?). If it PASSES on this dev
box's dpr, record that and proceed — Task 12 still hardens the path; re-run on a 1.25/1.5-dpr display
(or with `--force-device-scale-factor=1.25`, Step note below) to reproduce.

> To exercise non-1.0 dpr in `_electron`: launch with `--force-device-scale-factor=1.5` (add to the
> Playwright `_electron.launch` args in `e2e/fixtures.ts` for a one-off local repro run; do NOT commit
> that arg — it would pin the whole suite's dpr).

- [ ] **Step 4: Commit the probe**

```bash
git add src/renderer/src/smoke/e2eHooks.ts e2e/terminalClip.e2e.ts
git commit -m "test(terminal): clip-free-fit probe (geometry capture + height sweep)"
```

---

## Task 12: Apply the fix indicated by the probe

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

**Decision rule (read Task 11's numbers):**
- **Always apply Fix 1** (design-compliance; restores the slack the spec mandates).
- If `overflow` is roughly constant (≈ one sub-cell remainder independent of `rows`) → Fix 1 likely
  suffices; verify the probe goes green.
- If `cellHeight` is fractional and `overflow` grows with `rows` (DPR rounding: rendered cell taller
  than the floored fit cell) → also apply **Fix 2** (whole-cell fit wrapper) — it removes any partial
  row regardless of the rendered-vs-measured gap.
- Apply **Fix 3** (DPR refit) in Task 13 regardless — it is a standalone correctness gap.

- [ ] **Step 1: Fix 1 — restore the design's 12px bottom padding**

In `TerminalBoard.tsx`, change the `screen` style (line ~1111):

```ts
const screen: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  padding: '12px' // was '12px 12px 4px' — 4px bottom dropped the slack (DESIGN.md §7.1 = 12px)
}
```

- [ ] **Step 2: Fix 2 (apply only if the probe shows a growing/fractional overflow) — whole-cell fit**

Replace the bare `fit.fit()` calls with a wrapper that trims the well to a whole multiple of the
rendered cell height before fitting, so xterm never lays out a partial row. Add this helper near the
top of the component body (after the refs):

```ts
  // Fit, then guarantee the grid is a WHOLE number of CURRENTLY-RENDERED cells tall. FitAddon floors
  // rows against xterm's MEASURED cell height, but under fractional DPR the RENDERED cell can be
  // taller than measured, so rows*renderedCell can exceed the well by a sub-cell remainder that the
  // overflow:hidden well then clips. After fitting, if the rendered grid spills, drop one row.
  const fitWhole = useCallback((): void => {
    const fit = fitRef.current
    const term = termRef.current
    if (!fit || !term) return
    try {
      fit.fit()
    } catch {
      return // well not laid out (LOD / display:none)
    }
    const screenEl = screenRef.current?.querySelector('.xterm-screen') as HTMLElement | null
    const wellEl = screenRef.current?.closest('.nowheel') as HTMLElement | null
    if (!screenEl || !wellEl) return
    if (screenEl.getBoundingClientRect().bottom - wellEl.getBoundingClientRect().bottom > 1 && term.rows > 1) {
      term.resize(term.cols, term.rows - 1) // shed the partial row (fires onResize → PTY resize)
    }
  }, [])
```

Then route the fit calls through it: in `spawn` replace the `fit.fit()` after `term.open(el)` (line 375), the `ResizeObserver` callback's `fit.fit()` (line 537), the reactive font effect's `fitRef.current?.fit()` (Task 4), and `restart`'s `fit?.fit()` (line 621) with `fitWhole()`. (Keep each call site's existing try/catch context; `fitWhole` already guards internally, so a plain `fitWhole()` replaces the guarded `fit.fit()`.)

> Note for the executor: `fitWhole` reads layout (`getBoundingClientRect`) synchronously after
> `fit.fit()`. xterm updates its DOM during `fit.fit()`, so the rects are current. If the probe shows
> the overflow only appears one frame later, wrap the measure-and-trim in a `requestAnimationFrame` and
> re-run the probe.

- [ ] **Step 3: Build + run the probe to verify it goes green**

Run: `pnpm test:e2e -- terminalClip`
Expected: PASS — `offenders` is empty across the sweep.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "fix(terminal): clip-free bottom row — restore 12px padding + whole-cell fit"
```

---

## Task 13: DPR-change refit + matrix verification

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`
- Modify: `e2e/terminalClip.e2e.ts`

- [ ] **Step 1: Fix 3 — refit on devicePixelRatio change**

Today only the host `ResizeObserver` triggers a fit; moving the window to a different-DPR monitor
changes the cell height without resizing the host, so `rows` goes stale. Add a DPR-change listener
(the `matchMedia('(resolution: …)')` idiom) near the other effects:

```ts
  // Refit when devicePixelRatio changes (e.g. the window moved to a monitor with different scaling) —
  // the host doesn't resize, so the ResizeObserver never fires, but the cell height changed.
  useEffect(() => {
    let mql: MediaQueryList | null = null
    const onChange = (): void => {
      fitWhole()
      attach() // re-arm for the NEW dpr (each mql is dpr-specific)
    }
    const attach = (): void => {
      mql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      mql.addEventListener('change', onChange, { once: true })
    }
    attach()
    return () => mql?.removeEventListener('change', onChange)
  }, [fitWhole])
```

- [ ] **Step 2: Extend the probe across font sizes (the acceptance matrix)**

In `e2e/terminalClip.e2e.ts`, add a second test that sweeps height at multiple font sizes:

```ts
  test('stays clip-free across font sizes', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo ready' })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 8000)
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)
    await evalIn(page, `window.__canvasE2E.focusTerminal(${JSON.stringify(id)})`)
    await evalIn(
      page,
      `window.__canvasE2E.resetTerminalWrite(${JSON.stringify(id)}, Array.from({length: 60}, (_, i) => 'ROW' + i).join('\\r\\n'))`
    )
    const offenders: Array<{ font: number; h: number; overflow: number }> = []
    for (const font of [8, 11, 14, 18, 22]) {
      await evalIn(page, `window.__canvasE2E.setBoardFont(${JSON.stringify(id)}, ${font})`)
      await page.waitForTimeout(60) // reactive apply + refit
      for (let h = 220; h <= 600; h += 11) {
        await evalIn(page, `window.__canvasE2E.setBoardSize(${JSON.stringify(id)}, 460, ${h})`)
        await page.waitForTimeout(50)
        const geo = await evalIn<Geo | null>(page, geoOf(id))
        if (geo && geo.overflow > TOLERANCE) offenders.push({ font, h, overflow: geo.overflow })
      }
    }
    expect(offenders, `clip across font×height: ${JSON.stringify(offenders, null, 2)}`).toEqual([])
  })
```

(`setBoardFont` was added to the e2e hooks in Task 11.)

- [ ] **Step 3: Build + run the clip matrix**

Run: `pnpm test:e2e -- terminalClip`
Expected: PASS — both tests green (no offenders at any font × height).

- [ ] **Step 4: Full gate + e2e matrix**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Then: `pnpm test:e2e:matrix`
Expected: all green (Windows-native + Linux-Docker). (The Linux-Docker dpr is 1.0; the cross-dpr
guarantee rests on Fix 1/2 + the Fix 3 listener, with the local 1.25/1.5 repro from Task 11 Step 3.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx e2e/terminalClip.e2e.ts src/renderer/src/smoke/e2eHooks.ts
git commit -m "fix(terminal): refit on dpr change + clip-free matrix across font sizes"
```

---

## Self-review checklist (run before handoff)

- [ ] **Spec coverage:** per-board pin (Task 3, 4) · sticky default (Task 1, 4) · keyboard+Ctrl-wheel (Task 2, 4, 5) · title-bar (Task 6) · Configure row (Task 8) · right-click (Task 7) · PTY resize on change (Task 4 reactive effect) · zero-migration (Task 3) · undo coalescing (Task 4) · ADR (Task 10) · **clip-free fit: measure-first probe (Task 11) · fix from probe (Task 12) · DPR refit + font×height matrix (Task 13)** — all mapped.
- [ ] **No placeholders:** every code step is concrete. Task 12's candidate selection is a decision rule over Task 11's measured numbers (each candidate is fully coded), not a placeholder.
- [ ] **Type consistency:** `setFont` / `nudgeFont` / `resetFont` / `fontStep` / `fontReset` / `clampTerminalFont` / `readStickyFont` / `writeStickyFont` / `resolveInitialFont` / `terminalFontSize` / `terminalGeometry` / `setBoardSize` / `setBoardFont` / `fitWhole` names match across tasks.
- [ ] **Clip-fix guardrails:** `BoardFrame.tsx:437` `overflow:hidden` untouched; no preload/sandbox change; `fitWhole` replaces every `fit.fit()` call site (mount, ResizeObserver, font effect, restart).

## Cross-zone / coordination

- `boardSchema.ts` — additive optional `fontSize?` on `TerminalBoard` only, **no version bump**; the `text-create-edit-ux` worktree edits `TextElement` + bumps v8 → different interfaces, clean merge. Do NOT touch `SCHEMA_VERSION`/`MIGRATIONS`.
- `canvasStore.ts` — one entry in `PATCHABLE_KEYS.terminal`, away from that worktree's planning/selection code.
- Update `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` row for this worktree before/after the run.
- Merge order: this feature merges before rebrand #17. Re-run the gate after merging.

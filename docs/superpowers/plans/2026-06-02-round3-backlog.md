# Round-3 Backlog Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the residual Round-3 review findings (`docs/reviews/2026-06-01-round3.md`) — all Low or below — without weakening any locked invariant.

**Architecture:** Surgical fixes grouped into the review's four file-disjoint lanes. Pure store/helper logic is fixed test-first (TDD); UI one-liners are fixed and verified by typecheck + full unit suite + manual repro. Each finding is its own commit (repo convention: one commit per bug).

**Tech Stack:** Electron 33 · TypeScript (strict) · React 18 · Zustand · Vitest · node-pty (MAIN).

**Worktree:** `Z:\canvas-ade-r3-backlog` on branch `fix/round3-backlog` (off `main`). All paths below are relative to that worktree root.

**Scope this pass — 11 of 12 findings.** PREV-A (`BrowserPreviewLayer.tsx`) is **DEFERRED**: that file is owned by the active `canvas-ade-fullview-reset` worktree (coordination board). Do NOT edit it here — coordinate or pick it up after that branch merges. PERSIST-B and PERSIST-C are **optional** (benign / info) and folded in only if cheap.

**Gate (run after every task):**
```
pnpm typecheck
pnpm test
```
Expected: typecheck silent (0 errors); test suite green. Per-task tests named below.

---

## Lane C — terminal / whiteboard (highest impact)

### Task 1: PTY-2 — Restart clears the idle-on-mount flag

**Why:** `restart()` respawns a live PTY but never clears `idleOnMountIds`. A restored/duplicated terminal Restarted without ever clicking Start stays flagged idle; the next spawn-effect re-run renders the idle "Start" overlay over a running shell, and clicking Start spawns a *second* PTY under the same id.

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx:458` (`restart` callback)

- [ ] **Step 1: Add the clear at the top of `restart`**

In `restart = useCallback(() => { ... }`, immediately after the `const term = termRef.current; if (!term) return` guard, add the clear (Restart is explicit start intent, mirroring the Start button at `:382`):

```ts
  const restart = useCallback(() => {
    const term = termRef.current
    if (!term) return
    // A Restart is explicit start intent — drop the idle-on-mount flag (mirrors the
    // Start button) so a later spawn-effect re-run (config Apply) doesn't render the
    // idle overlay over this now-live PTY and let Start spawn a 2nd session (PTY-2).
    clearIdleOnMount(board.id)
    void window.api.killTerminal(board.id)
```

`clearIdleOnMount` is already imported (used by `startLaunchRef` at `:382`). Confirm the import line near the top of the file includes it; if not, add it to the existing `from '../../store/canvasStore'` import.

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 3: Manual repro (no unit seam — restart is a component callback)**

`pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start` to confirm no terminal regression (E2E_DONE, terminal seeds green). Manual: open a project → never-Started terminal → Restart → Configure → change cwd → Apply → confirm NO idle overlay appears over the running shell.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "fix(terminal): Restart clears idle-on-mount flag (PTY-2)"
```

---

### Task 2: WB-1 — Degenerate arrow/pen tap no longer pushes a phantom undo snapshot

**Why:** Arrow/pen call `beginChange()` on pointer-DOWN. A tap-without-drag is then discarded as degenerate on pointer-up with no `commit`, leaving an identical snapshot on the undo stack (phantom step) — the exact `lastRecorded` class the **move** path was hardened against. Fix: defer `beginChange()` into the commit branches on pointer-up, mirroring move.

**Files:**
- Modify: `src/renderer/src/canvas/boards/PlanningBoard.tsx:249-263` (arrow/pen pointer-down) and `:321-334` (arrow/pen pointer-up)

- [ ] **Step 1: Remove `beginChange()` from the arrow + pen pointer-DOWN branches**

In `onWellPointerDown`, drop the two `beginChange()` calls (only for arrow/pen — leave `check`/`text` immediate-commit paths untouched):

```ts
      if (tool === 'arrow') {
        const arrow = makeArrow(newId(), p)
        drag.current = { mode: 'arrow', id: arrow.id }
        setDraftArrow(arrow)
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      if (tool === 'pen') {
        const points = pushBoardPoint([], p)
        drag.current = { mode: 'pen', points }
        setDraftStroke(points)
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
```

- [ ] **Step 2: Add `beginChange()` inside the commit branches on pointer-UP**

In `onWellPointerUp`, call `beginChange()` immediately before each real `commit(...)` (inside the degenerate guard), mirroring the move path at `:318`:

```ts
    } else if (d.mode === 'arrow') {
      const a = draftArrow
      setDraftArrow(null)
      // Discard a degenerate (no-drag) arrow. Checkpoint ONLY when we actually commit,
      // so a tap-without-drag pushes no phantom undo snapshot (WB-1; mirrors move).
      if (a && (Math.abs(a.x2 - a.x) > 4 || Math.abs(a.y2 - a.y) > 4)) {
        beginChange()
        commit([...elements, a])
      }
      setTool('select')
    } else if (d.mode === 'pen') {
      const pts = d.points
      setDraftStroke(null)
      if (pts.length >= 4) {
        beginChange()
        commit([...elements, makeStroke(newId(), pts)])
      }
      setTool('select')
    }
```

`beginChange` is already in the `onWellPointerUp` dependency array (`:335`); leave it. Remove `beginChange` from the `onWellPointerDown` dep array (`:268`) since it's no longer referenced there.

- [ ] **Step 3: Typecheck (catches the now-unused dep / no-unused-locals)**

Run: `pnpm typecheck`
Expected: 0 errors. If `beginChange` left in the down-handler deps triggers nothing (deps aren't unused-checked), still remove it for correctness.

- [ ] **Step 4: Run the planning unit suite**

Run: `pnpm test -- elements`
Expected: PASS (pure element transforms unaffected; this is a regression guard that the commit logic still builds the same arrays).

- [ ] **Step 5: Manual repro**

Select arrow → single click on the whiteboard, no drag → Ctrl/Cmd-Z → the previous real edit must reverse (NOT a silent no-op). Repeat with pen.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/boards/PlanningBoard.tsx
git commit -m "fix(planning): defer undo checkpoint to commit for arrow/pen (WB-1)"
```

---

## Lane B — canvas state

### Task 3: STATE-2 — `updateBoard` / `resizeBoard` preserve the redo branch on a no-op patch

**Why:** Both set `changed=true` on id match alone (not value diff), so a patch re-applying identical values clears the armed redo branch and mints a new `boards` ref (defeating downstream `boards !== before` guards). `beginChange`'s contract promises the opposite. Fix test-first in the pure store.

**Files:**
- Test: `src/renderer/src/store/canvasStore.test.ts`
- Modify: `src/renderer/src/store/canvasStore.ts:295-317` (`updateBoard`) and `:319-329` (`resizeBoard`)

- [ ] **Step 1: Write failing tests**

Add to `canvasStore.test.ts` (match the file's existing import/setup style — `useCanvasStore.getState()`, `setState` reset between tests):

```ts
describe('STATE-2: no-op patch preserves redo branch', () => {
  it('updateBoard with identical values does not clear future', () => {
    const s = useCanvasStore.getState()
    s.loadObject({ schemaVersion: 2, viewport: null, boards: [
      { id: 'a', type: 'planning', x: 0, y: 0, w: 300, h: 200, elements: [] }
    ] })
    // Move, then undo → arms a redo branch.
    useCanvasStore.getState().beginChange()
    useCanvasStore.getState().updateBoard('a', { x: 50 })
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().future.length).toBe(1)
    // Re-apply the SAME current x (no-op) — must NOT wipe redo.
    const cur = useCanvasStore.getState().boards.find((b) => b.id === 'a')!
    useCanvasStore.getState().updateBoard('a', { x: cur.x })
    expect(useCanvasStore.getState().future.length).toBe(1)
  })

  it('resizeBoard with identical w/h does not clear future', () => {
    const s = useCanvasStore.getState()
    s.loadObject({ schemaVersion: 2, viewport: null, boards: [
      { id: 'a', type: 'planning', x: 0, y: 0, w: 300, h: 200, elements: [] }
    ] })
    useCanvasStore.getState().beginChange()
    useCanvasStore.getState().resizeBoard('a', 400, 250)
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().future.length).toBe(1)
    const cur = useCanvasStore.getState().boards.find((b) => b.id === 'a')!
    useCanvasStore.getState().resizeBoard('a', cur.w, cur.h)
    expect(useCanvasStore.getState().future.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm test -- canvasStore`
Expected: the two new tests FAIL (`future.length` is 0 after the no-op patch).

- [ ] **Step 3: Fix `updateBoard` — only change on a real value diff**

Replace the `updateBoard` body's change detection (`:303-316`):

```ts
  updateBoard: (id, patch) =>
    set((s) => {
      const src = patch as Record<string, unknown>
      let changed = false
      const boards = s.boards.map((b) => {
        if (b.id !== id) return b
        const allowed = PATCHABLE_KEYS[b.type]
        const safe: Record<string, unknown> = {}
        let diff = false
        for (const key of allowed) {
          if (key in src) {
            safe[key] = src[key]
            // Reference/value compare: a patch re-applying identical values must NOT
            // mint a new boards ref or clear the redo branch (STATE-2). New-array refs
            // (e.g. elements) on a real edit still differ, so genuine edits register.
            if ((b as Record<string, unknown>)[key] !== src[key]) diff = true
          }
        }
        if (!diff) return b
        changed = true
        return { ...b, ...safe } as Board
      })
      if (!changed) return s
      return s.future.length ? { boards, future: [] } : { boards }
    }),
```

- [ ] **Step 4: Fix `resizeBoard` — only change when clamped w/h actually differ**

Replace `resizeBoard` (`:319-329`):

```ts
  resizeBoard: (id, w, h) =>
    set((s) => {
      let changed = false
      const boards = s.boards.map((b) => {
        if (b.id !== id) return b
        const nw = Math.max(MIN_BOARD_SIZE.w, w)
        const nh = Math.max(MIN_BOARD_SIZE.h, h)
        if (nw === b.w && nh === b.h) return b
        changed = true
        return { ...b, w: nw, h: nh }
      })
      if (!changed) return s
      return s.future.length ? { boards, future: [] } : { boards }
    }),
```

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm test -- canvasStore`
Expected: PASS (new tests + all existing).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts
git commit -m "fix(store): no-op updateBoard/resizeBoard preserves redo branch (STATE-2)"
```

---

### Task 4: STATE-1 — Duplicate / push-spawn while focused don't leave the new board dimmed

**Why:** While focused, every board where `focusedId !== b.id` renders at 55% opacity. `addCentered` clears focus after add (#14); the ⋯-menu **Duplicate** and **push-preview spawn** paths don't, so the new board mounts as a faded ghost inside the focused frame.

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx:513-516` (`duplicate`) and `:501-505` (`applyPush` spawn branch)

- [ ] **Step 1: Clear focus in the `duplicate` action**

```ts
      duplicate: (id) => {
        hardCloseFullView()
        // Exit focus so the clone isn't born dimmed (mirrors addCentered, #14 / STATE-1).
        setFocusedId(null)
        duplicateBoard(id)
      },
```

- [ ] **Step 2: Clear focus in `applyPush`'s spawn branch**

In the `else` (fresh-spawn) branch of `applyPush`:

```ts
      } else {
        // Exit focus so the freshly spawned browser isn't born dimmed (STATE-1).
        setFocusedId(null)
        const id = st.addBoard('browser', { x: from.x + from.w + 40, y: from.y })
        st.updateBoard(id, patch)
        st.selectBoard(id)
      }
```

- [ ] **Step 3: Confirm `setFocusedId` is in the `boardActions` useMemo deps**

`boardActions` deps (`:531`) — `setFocusedId` is a `useState` setter (stable identity), so React doesn't require it in deps, but add it for lint parity if the file's other memos list setters. Check the existing style; if setters are omitted elsewhere, leave it omitted. Run `pnpm typecheck` to confirm no exhaustive-deps error breaks the build (it's a lint warning, not a type error).

- [ ] **Step 4: Typecheck + manual repro**

Run: `pnpm typecheck` → 0 errors.
Manual: double-click a board to focus → ⋯ → Duplicate → the copy must appear at full opacity (not dimmed). Same via a Terminal preview push that spawns a Browser while focused.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/Canvas.tsx
git commit -m "fix(canvas): clear focus on duplicate/push-spawn so new board isn't dimmed (STATE-1)"
```

---

## Lane D — main / persistence

### Task 5: SEC-1 — Validate PTY `cwd` (fall back to home if not an existing dir)

**Why:** `opts.cwd` flows from the renderer straight into `pty.spawn` with no existence/dir check — the one spawn input that escaped the `shell`/`dir` hardening. A corrupt/hand-edited `canvas.json` with a missing `cwd` reaches spawn. Hardening parity (trusted-user input by design; this degrades, not exploits).

**Files:**
- Test: `src/main/pty.test.ts`
- Modify: `src/main/pty.ts` (add `safeCwd` helper + import `statSync`; use it at `:430`)

- [ ] **Step 1: Write a failing test for the pure helper**

Add to `pty.test.ts` (import `safeCwd` — exported in the next step). Use `os.tmpdir()` (guaranteed to exist) and a bogus path:

```ts
import os from 'node:os'
import { safeCwd } from './pty'

describe('safeCwd', () => {
  it('returns an existing directory unchanged', () => {
    expect(safeCwd(os.tmpdir())).toBe(os.tmpdir())
  })
  it('falls back to homedir for a non-existent path', () => {
    expect(safeCwd('Z:\\definitely\\not\\a\\real\\dir\\xyzzy')).toBe(os.homedir())
  })
  it('falls back to homedir for undefined / a file (not a dir)', () => {
    expect(safeCwd(undefined)).toBe(os.homedir())
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test -- pty`
Expected: FAIL — `safeCwd` not exported.

- [ ] **Step 3: Add the helper + wire it in**

At the top of `pty.ts`, ensure `statSync` is imported from `node:fs` (add to the existing fs import or a new line). Add the exported helper near the other module helpers:

```ts
import { statSync } from 'node:fs'

/**
 * SEC-1: validate a spawn cwd. The renderer's `opts.cwd` is trusted-user input but a
 * corrupt/hand-edited canvas.json can carry a missing or non-dir path; an invalid cwd
 * throws inside pty.spawn. Mirror the `shell`/`dir` hardening: fall back to home unless
 * cwd is an existing directory.
 */
export function safeCwd(cwd?: string): string {
  try {
    if (cwd && statSync(cwd).isDirectory()) return cwd
  } catch {
    /* not accessible / does not exist → fall through */
  }
  return os.homedir()
}
```

Then change the spawn option (`:430`) from `cwd: opts.cwd || os.homedir(),` to:

```ts
        cwd: safeCwd(opts.cwd),
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm test -- pty`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/pty.ts src/main/pty.test.ts
git commit -m "fix(pty): validate spawn cwd, fall back to home if not a dir (SEC-1)"
```

---

### Task 6: PERSIST-A — Surface a failed final flush on project switch

**Why:** `switchTo` does `await window.api.project.save(toObject())` but discards the boolean. `project:save` returns `false` on write failure; the debounced autosaver is gated out once status flips to `loading`, so a failed final flush of the *outgoing* project is swallowed and its tail edits are lost with no signal — the silent-loss class SAVE-1 closed.

**Files:**
- Modify: `src/renderer/src/canvas/AppChrome.tsx:63-72` (`switchTo`)

- [ ] **Step 1: Check the save result before tearing down**

```ts
  const switchTo = async (load: () => Promise<unknown>): Promise<void> => {
    setOpen(false)
    // 1. Flush the current project to disk before tearing it down. project:save returns
    //    false on a write failure; the debounced autosaver is gated off once we flip to
    //    'loading', so a swallowed false here loses the outgoing project's tail edits with
    //    no signal (PERSIST-A / the SAVE-1 silent-loss class). Surface it and abort.
    const saved = await window.api.project.save(toObject())
    if (saved === false) {
      // eslint-disable-next-line no-console
      console.error('project switch: final flush failed; aborting switch to avoid data loss')
      return
    }
    // 2. Suppress autosave + dispose native views/PTYs.
    setProjectLoading()
    await disposeLiveResources()
    // 3. Load the new project.
    applyOpenResult((await load()) as Parameters<typeof applyOpenResult>[0])
  }
```

(Aborting on failure keeps the outgoing project open and editable — the user can retry. This matches the review's "optionally offer to abort the switch.")

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck` → 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/canvas/AppChrome.tsx
git commit -m "fix(project): abort switch on failed final flush, don't swallow data loss (PERSIST-A)"
```

---

### Task 7: SEC-2 — `pty:port` re-post uses the document origin, not `'*'`

**Why:** Nit. Not exploitable today (single same-origin document, `webviewTag:false`, nav guard). Flagged because `'*'` becomes load-bearing if an iframe is ever added.

**Files:**
- Modify: `src/preload/index.ts:164`

- [ ] **Step 1: Replace the wildcard target origin**

```ts
ipcRenderer.on('pty:port', (e, msg: { id: string }) => {
  // Same-origin re-post (SEC-2): pin the target origin instead of '*' so this stays
  // safe if an iframe is ever introduced. MessagePorts ride in the transfer list.
  window.postMessage({ __ptyPort: true, id: msg.id }, window.location.origin, e.ports)
})
```

- [ ] **Step 2: Typecheck + smoke**

Run: `pnpm typecheck` → 0 errors.
Run the headless terminal smoke to confirm the port still arrives:
`pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start` → terminal seeds green (E2E_DONE). The MessagePort handshake breaking would surface as a terminal that never reaches `running`.

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "fix(preload): pin pty:port re-post origin instead of '*' (SEC-2)"
```

---

## Lane A — preview (PREV-B, PREV-C only; PREV-A deferred)

### Task 8: PREV-B — Node RESIZE gets the synchronous detach that node DRAG has

**Why:** `onNodeDragStart` fires `void window.api.detachAllPreviews()` synchronously to dodge the #43961 ghost. The NodeResizer path only `setNodeGesture(true)`; the actual detach then rides the async `beginMotion` (`await capturePreview` per view). For the first frames of a resize the live `WebContentsView` is still attached and `flushBatch` repositions it every frame — it can ghost at the old size until the snapshot lands.

**Files:**
- Modify: `src/renderer/src/canvas/BoardNode.tsx:246` (`onResize`)

- [ ] **Step 1: Add the synchronous safety detach in `onResize`**

```ts
          onResize={() => {
            usePreviewStore.getState().setNodeGesture(true)
            // Pull live native views out IMMEDIATELY (mirrors onNodeDragStart): the async
            // beginMotion snapshot lags the first resize frames, during which flushBatch
            // repositions an always-above native layer that can ghost at the old size
            // (PREV-B / #43961). Idempotent; reattach happens on resize end.
            void window.api.detachAllPreviews?.()
          }}
```

- [ ] **Step 2: Typecheck + manual repro**

Run: `pnpm typecheck` → 0 errors.
Manual: place a Browser board (live preview) overlapping another board → grab a resize handle → no native-view ghost frame at the old bounds.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/canvas/BoardNode.tsx
git commit -m "fix(preview): synchronous detach on node resize, matching drag (PREV-B)"
```

---

### Task 9: PREV-C — `menuOpen` becomes a ref-count Set (one menu closing can't reattach under another)

**Why:** `menuOpen` is one global boolean written by every `BoardFrame` from its own `open` state with cleanup `() => setMenuOpen(false)`. If two popovers were ever open at once, the first to close clears the shared flag and prematurely reattaches live views under the still-open second menu (occluded by the always-above native layer). Today the outside-pointerdown listener keeps two from co-existing — the invariant is held by incidental UI behavior, not the state model.

**Files:**
- Test: `src/renderer/src/store/previewStore.test.ts` (create if absent)
- Modify: `src/renderer/src/store/previewStore.ts:72,93,119` (`menuOpen` derivation + `setMenuOpen` signature)
- Modify: `src/renderer/src/canvas/BoardFrame.tsx:170-174` (pass a stable token)

- [ ] **Step 1: Write failing tests for ref-counted menu state**

Create/append `previewStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { usePreviewStore } from './previewStore'

describe('PREV-C: ref-counted menuOpen', () => {
  beforeEach(() => usePreviewStore.setState({ openMenus: new Set(), menuOpen: false }))

  it('stays open while ANY menu is open', () => {
    const { setMenuOpen } = usePreviewStore.getState()
    setMenuOpen('a', true)
    setMenuOpen('b', true)
    expect(usePreviewStore.getState().menuOpen).toBe(true)
    setMenuOpen('a', false) // first to close
    expect(usePreviewStore.getState().menuOpen).toBe(true) // b still open
    setMenuOpen('b', false)
    expect(usePreviewStore.getState().menuOpen).toBe(false)
  })

  it('is idempotent on repeat open/close of the same token', () => {
    const { setMenuOpen } = usePreviewStore.getState()
    setMenuOpen('a', true)
    setMenuOpen('a', true)
    setMenuOpen('a', false)
    expect(usePreviewStore.getState().menuOpen).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- previewStore`
Expected: FAIL — `setMenuOpen` currently takes a boolean; `openMenus` undefined.

- [ ] **Step 3: Convert the store to a ref-count Set**

In `previewStore.ts`, add `openMenus` to state and derive `menuOpen` from its size. Update the interface signature (`:93`) and the action (`:119`):

```ts
  /** Tokens (one per open ⋯ menu / device-overlapping popover). menuOpen = size > 0. */
  openMenus: Set<string>
  menuOpen: boolean
  /** Track a popover as open/closed BY TOKEN so one closing can't reattach live views
   *  under another still-open popover (PREV-C). */
  setMenuOpen: (token: string, active: boolean) => void
```

Initial state + action in the `create<PreviewState>` body:

```ts
  openMenus: new Set<string>(),
  menuOpen: false,
  setMenuOpen: (token, active) =>
    set((s) => {
      const next = new Set(s.openMenus)
      if (active) next.add(token)
      else next.delete(token)
      const menuOpen = next.size > 0
      // Only emit when the derived flag or the set actually changed.
      if (menuOpen === s.menuOpen && next.size === s.openMenus.size) return s
      return { openMenus: next, menuOpen }
    }),
```

Keep the existing `menuOpen` field (the BrowserPreviewLayer reads it unchanged — it only cares whether ANY menu is open).

- [ ] **Step 4: Update `BoardFrame` to pass a stable per-instance token**

In `BoardFrame.tsx`, generate a stable token with React's `useId` and key the calls by it (`:170-174`):

```ts
  const menuToken = useId()
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)
  useEffect(() => {
    setMenuOpen(menuToken, open)
    if (open) return () => setMenuOpen(menuToken, false)
  }, [open, setMenuOpen, menuToken])
```

Add `useId` to the existing `react` import at the top of `BoardFrame.tsx`.

- [ ] **Step 5: Run tests to verify pass**

Run: `pnpm test -- previewStore`
Expected: PASS. Then `pnpm test -- BoardMenu` to confirm the existing menu test still passes.

- [ ] **Step 6: Typecheck (catches any other `setMenuOpen(bool)` callers)**

Run: `pnpm typecheck`
Expected: 0 errors. Grep first to be safe: `setMenuOpen(` should appear ONLY in `BoardFrame.tsx` and the store. If another caller exists, update it to the `(token, active)` signature.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/store/previewStore.ts src/renderer/src/store/previewStore.test.ts src/renderer/src/canvas/BoardFrame.tsx
git commit -m "fix(preview): ref-count menuOpen by token so one close doesn't reattach under another (PREV-C)"
```

---

## Optional / deferred

- **PREV-A** (`BrowserPreviewLayer.tsx:464` evict-resurrection recheck) — **DEFERRED**: file owned by `canvas-ade-fullview-reset`. The one-line fix is `if (!recs.current.has(id)) return` after the `await capturePreview(id)` in `evictLiveBoard`. Apply only after coordinating with / merging that branch.
- **PERSIST-B** (autosave timer not cancelled on switch) — benign (data-correct, redundant write). Requires lifting the autosaver out of `useAutosave`'s closure to expose `cancel()` to `AppChrome` — more invasive than its Low-benign severity warrants. Skip this pass.
- **PERSIST-C** (`createProject` bypasses `writeProject` envelope) — Info, functionally correct (hardcoded valid constant, no prior file to rotate). Skip unless touching `projectStore.ts` anyway.

---

## Final verification (after all tasks)

- [ ] **Full gate:** `pnpm typecheck && pnpm test` — typecheck silent, suite green (expect new tests from Tasks 3, 5, 9 added to the count).
- [ ] **e2e:** `pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start` → `E2E_DONE`. The browser-trio (browser / browser-gesture / focus-detach) is a known env `capturePage` flake (memory `e2e-browser-trio-flake`) — rerun once for a clean pass; everything else must be green.
- [ ] **Update the review doc:** mark the closed findings in `docs/reviews/2026-06-01-round3.md` (strike-through or a "Fixed in `fix/round3-backlog`" column) so the backlog reflects reality.
- [ ] **Merge:** sequential merge into `main`, re-running the full gate + e2e after the merge (board components interact even when files are disjoint — memory `parallel-agent-worktrees`).

## Self-review notes

- **Spec coverage:** 11/12 findings tasked (PREV-A deferred for worktree-zone collision; PERSIST-B/C consciously deferred with rationale). ✅
- **No placeholders:** every code step shows the actual edit against the real current source (read from the worktree). ✅
- **Type consistency:** `setMenuOpen(token: string, active: boolean)` is used identically in store + BoardFrame + tests; `safeCwd` signature matches its test + call site; `idleOnMountIds`/`clearIdleOnMount` reuse existing exports. ✅

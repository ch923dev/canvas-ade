# Terminal Session Park/Adopt on Undo (#15) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Undo of a deleted Terminal board reattaches the SAME live `node-pty` process (verified by pid) and replays its scrollback, instead of spawning a fresh shell.

**Architecture:** Park-on-delete / adopt-on-undo in MAIN. The delete site in the renderer (`Canvas.onNodesChange` `remove` intent) calls `pty:park`, which moves the session out of `sessions` into `parked` (so the unmount's `killTerminal` no-ops) and starts a 120 s TTL. A per-session capped (256 KB) output ring buffer — appended in the single `proc.onData` listener and replayed on adopt — restores scrollback with no new dependency. On re-mount, `TerminalBoard` tries `pty:adopt` first; if there's a parked session it rebinds a fresh MessagePort to the still-running proc, else it spawns fresh.

**Tech Stack:** Electron 33 (MAIN + preload + renderer), node-pty, xterm.js, React 18, React Flow v12, Zustand, TypeScript strict, vitest. Verify with `pnpm test · typecheck · lint · format:check · build` + the `CANVAS_SMOKE=e2e` harness.

**Branch:** `fix/terminal-undo-session-15` (off `fix/confirmed-bugs`).

**Spec:** `docs/superpowers/specs/2026-05-30-terminal-undo-session-15-design.md`.

---

## File map

- `src/main/pty.ts` — ring buffer on `Session`, `parked` map, `park`/`reapParked`/`adopt`, `pty:park`/`pty:adopt` handlers, `appendRing` (pure), e2e accessors `debugTerminalPid`/`debugWriteTerminal`, `disposeAllPtys` + `onExit` reap parked. **Owns all session lifecycle.**
- `src/main/pty.test.ts` — unit tests for `appendRing`.
- `src/preload/index.ts` — add `parkTerminal` / `adoptTerminal` to `api` (types flow via `typeof api`).
- `src/renderer/src/canvas/Canvas.tsx` — park a terminal on the `remove` intent.
- `src/renderer/src/canvas/boards/TerminalBoard.tsx` — adopt-first gate in the spawn effect.
- `src/renderer/src/smoke/e2eHooks.ts` — `deleteBoard(id)` + `undo()` hooks.
- `src/main/e2eSmoke.ts` — adopt assertion (pid identity + scrollback marker).

**Verification note:** the pure ring-buffer logic is unit-tested (Task 1). The park/adopt wiring is integration-level (electron + node-pty runtime), so its authoritative test is the e2e harness in **Task 9** — it proves Tasks 2–8 end to end (same pid + replayed marker after delete→undo). Tasks 2–8 are gated on `typecheck` + `build` (compile correctness) and committed incrementally.

---

### Task 1: Pure output ring buffer (`appendRing`)

**Files:**
- Modify: `src/main/pty.ts`
- Test: `src/main/pty.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/main/pty.test.ts` (top, after the existing imports — add `appendRing` to the import from `./pty`):

```ts
import { appendRing } from './pty'

describe('appendRing', () => {
  it('concatenates when the result is under the cap', () => {
    expect(appendRing('ab', 'cd', 10)).toBe('abcd')
  })
  it('returns exactly the input at the cap boundary', () => {
    expect(appendRing('abcd', 'ef', 6)).toBe('abcdef')
  })
  it('drops the oldest bytes when over the cap (keeps the last `cap`)', () => {
    expect(appendRing('abcd', 'efgh', 6)).toBe('cdefgh')
  })
  it('keeps only the last `cap` bytes when a single chunk exceeds the cap', () => {
    expect(appendRing('', 'abcdefgh', 4)).toBe('efgh')
  })
  it('is a no-op for an empty chunk', () => {
    expect(appendRing('abc', '', 10)).toBe('abc')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/main/pty.test.ts`
Expected: FAIL — `appendRing is not exported` / `is not a function`.

- [ ] **Step 3: Implement `appendRing`**

In `src/main/pty.ts`, add near the top (after the `import` block, before `SpawnOpts`):

```ts
/**
 * Append `chunk` to a capped output ring buffer, keeping only the last `cap`
 * characters (drop-oldest). Pure, so it is unit-tested. Used to record each
 * session's recent output for replay when a deleted terminal is adopted on undo.
 */
export function appendRing(prev: string, chunk: string, cap: number): string {
  const next = prev + chunk
  return next.length <= cap ? next : next.slice(next.length - cap)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/main/pty.test.ts`
Expected: PASS (5 new tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/pty.ts src/main/pty.test.ts
git commit -m "feat(pty): pure appendRing capped output buffer (#15)"
```

---

### Task 2: Ring buffer on each session + constants

**Files:**
- Modify: `src/main/pty.ts`

- [ ] **Step 1: Add constants + extend `Session` with a boxed buffer**

In `src/main/pty.ts`, replace the `Session` interface + `sessions` declaration:

```ts
/** Park a deleted terminal's process this long before reaping it (#15). */
const PARK_TTL_MS = 120_000
/** Cap of each session's replay buffer (#15). */
const RING_CAP_BYTES = 256 * 1024

interface Session {
  proc: pty.IPty
  port: MessagePortMain
  /**
   * Recent output, boxed so the SAME reference travels into `parked` on park and
   * back into a session on adopt — the single `proc.onData` listener keeps appending
   * to it across the move (closures capture the box, not the map entry).
   */
  buf: { data: string }
}

const sessions = new Map<string, Session>()
```

- [ ] **Step 2: Wire the buffer into `proc.onData` (spawn path)**

In the `pty:spawn` handler, replace the data-forward line:

```ts
proc.onData((d) => port1.postMessage({ t: 'data', d }))
```

with (it appends to the boxed buffer and forwards to the CURRENT live port — there is none while parked, so the post is guarded; the buffer keeps recording):

```ts
const buf = { data: '' }
proc.onData((d) => {
  buf.data = appendRing(buf.data, d, RING_CAP_BYTES)
  // Forward to the current live port (looked up at fire time, so it follows an
  // adopt onto the new port); none while parked → guard the post.
  const live = sessions.get(opts.id)
  if (live) {
    try {
      live.port.postMessage({ t: 'data', d })
    } catch {
      /* port closed */
    }
  }
})
```

- [ ] **Step 3: Store the boxed buffer on the session**

In the same handler, replace:

```ts
sessions.set(opts.id, { proc, port: port1 })
```

with:

```ts
sessions.set(opts.id, { proc, port: port1, buf })
```

- [ ] **Step 4: Verify it compiles + existing tests pass**

Run: `pnpm typecheck && pnpm test src/main/pty.test.ts`
Expected: typecheck clean; pty tests PASS (no behavior change yet — buffer is recorded, output still forwarded).

- [ ] **Step 5: Commit**

```bash
git add src/main/pty.ts
git commit -m "feat(pty): record each session's output in a boxed ring buffer (#15)"
```

---

### Task 3: Park a session (move aside + TTL)

**Files:**
- Modify: `src/main/pty.ts`

- [ ] **Step 1: Add the `parked` map + `park`/`reapParked`**

In `src/main/pty.ts`, after the `sessions` declaration add:

```ts
interface Parked {
  proc: pty.IPty
  buf: { data: string }
  timer: ReturnType<typeof setTimeout>
}

/** Deleted-but-undoable sessions, kept alive up to PARK_TTL_MS for adopt-on-undo. */
const parked = new Map<string, Parked>()

/** Reap a parked session: stop its TTL timer and kill its process tree. */
function reapParked(id: string): Promise<void> {
  const p = parked.get(id)
  if (!p) return Promise.resolve()
  parked.delete(id)
  clearTimeout(p.timer)
  return killTree(p.proc)
}

/**
 * Park the live session for `id` instead of killing it (#15): move it out of
 * `sessions` (so the board-unmount's `pty:kill` no-ops), close the renderer port
 * (the proc keeps running and the onData listener keeps recording into `buf`), and
 * start a TTL after which the process tree is reaped if no undo adopts it.
 */
function park(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  sessions.delete(id)
  try {
    s.port.close()
  } catch {
    /* already closed */
  }
  const timer = setTimeout(() => void reapParked(id), PARK_TTL_MS)
  timer.unref?.()
  parked.set(id, { proc: s.proc, buf: s.buf, timer })
}
```

- [ ] **Step 2: Register the `pty:park` IPC handler**

In `registerPtyHandlers`, after the `pty:kill` handler add:

```ts
ipcMain.handle('pty:park', (_e, id: string) => {
  park(id)
  return true
})
```

- [ ] **Step 3: Verify it compiles**

Run: `pnpm typecheck`
Expected: clean. (`adopt` referenced by `pty:adopt` is added in Task 4 — do NOT add the `pty:adopt` handler yet.)

- [ ] **Step 4: Commit**

```bash
git add src/main/pty.ts
git commit -m "feat(pty): park a session on delete with a TTL reaper (#15)"
```

---

### Task 4: Adopt a parked session + reap parked on exit/shutdown

**Files:**
- Modify: `src/main/pty.ts`

- [ ] **Step 1: Add `adopt`**

In `src/main/pty.ts`, after `park`, add (it rebinds a fresh MessagePort to the still-running proc, replays the buffer so the new xterm reconstructs scrollback, and re-announces `running`):

```ts
/**
 * Adopt a parked session for `id` (#15): clear its TTL, bind a fresh MessagePort
 * to the still-running proc, move it back into `sessions`, replay the recorded
 * output buffer so the re-mounted xterm reconstructs its scrollback, and re-emit
 * `running`. Returns the live pid so the e2e can assert process identity. If no
 * session is parked, returns `{ adopted: false }` and the caller spawns fresh.
 */
function adopt(id: string, win: BrowserWindow): { adopted: boolean; pid?: number } {
  const p = parked.get(id)
  if (!p) return { adopted: false }
  clearTimeout(p.timer)
  parked.delete(id)

  const { port1, port2 } = new MessageChannelMain()
  port1.on('message', (e) => {
    const m = e.data as { t: string; d?: string; cols?: number; rows?: number }
    if (m.t === 'input' && typeof m.d === 'string') p.proc.write(m.d)
    else if (m.t === 'resize' && m.cols && m.rows) p.proc.resize(m.cols, m.rows)
  })
  port1.start()

  // Back into `sessions` with the SAME boxed buffer; the spawn-time onData listener
  // now forwards live output to this new port (it looks up sessions.get(id)).
  sessions.set(id, { proc: p.proc, port: port1, buf: p.buf })
  win.webContents.postMessage('pty:port', { id }, [port2])

  // Replay recorded scrollback, then re-announce running.
  if (p.buf.data) port1.postMessage({ t: 'data', d: p.buf.data })
  port1.postMessage({ t: 'state', state: 'running' satisfies PtyState })

  return { adopted: true, pid: p.proc.pid }
}
```

- [ ] **Step 2: Register the `pty:adopt` IPC handler**

In `registerPtyHandlers`, after the `pty:park` handler add:

```ts
ipcMain.handle('pty:adopt', (_e, id: string) => {
  const win = getWin()
  if (!win) return { adopted: false }
  return adopt(id, win)
})
```

- [ ] **Step 3: Reap a parked proc that exits on its own**

In the `pty:spawn` handler's `proc.onExit` callback, after the existing `cleanup(opts.id, proc)` line, add:

```ts
// If this proc was parked (deleted, awaiting undo) and exited on its own, drop it.
const p = parked.get(opts.id)
if (p && p.proc === proc) {
  clearTimeout(p.timer)
  parked.delete(opts.id)
}
```

- [ ] **Step 4: Reap parked sessions on shutdown**

Replace `disposeAllPtys` with (awaits parked tree-kills too, preserving the #49 await-before-exit guarantee):

```ts
export function disposeAllPtys(): Promise<void> {
  const parkedDone = [...parked.keys()].map((id) => reapParked(id))
  const liveDone = [...sessions.keys()].map((id) => cleanup(id))
  return Promise.all([...parkedDone, ...liveDone]).then(() => undefined)
}
```

- [ ] **Step 5: Verify it compiles + pty tests pass**

Run: `pnpm typecheck && pnpm test src/main/pty.test.ts`
Expected: clean + PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/pty.ts
git commit -m "feat(pty): adopt a parked session on undo + reap parked on exit/shutdown (#15)"
```

---

### Task 5: E2E-only debug accessors (pid + write)

**Files:**
- Modify: `src/main/pty.ts`

- [ ] **Step 1: Add `debugTerminalPid` + `debugWriteTerminal`**

At the end of `src/main/pty.ts`, add:

```ts
/**
 * E2E (in-process smoke) ONLY — pid of the live OR parked session for `id`, so the
 * harness can assert process IDENTITY across a delete→undo (adopt must reattach the
 * SAME process, not spawn a new one). Read-only; exposes nothing new to the renderer.
 */
export function debugTerminalPid(id: string): number | null {
  return sessions.get(id)?.proc.pid ?? parked.get(id)?.proc.pid ?? null
}

/**
 * E2E ONLY — write directly to the live session's process (a runtime marker the
 * harness can look for in the replayed scrollback after undo). Not wired to the
 * renderer; the harness runs in MAIN and calls this directly.
 */
export function debugWriteTerminal(id: string, data: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  s.proc.write(data)
  return true
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/main/pty.ts
git commit -m "test(pty): e2e-only debugTerminalPid + debugWriteTerminal (#15)"
```

---

### Task 6: Preload — expose `parkTerminal` / `adoptTerminal`

**Files:**
- Modify: `src/preload/index.ts`

- [ ] **Step 1: Add the two methods to `api`**

In `src/preload/index.ts`, in the `api` object's Terminal section, after the `killTerminal` line add:

```ts
  // Park the session on delete (keep the proc alive for adopt-on-undo, #15).
  parkTerminal: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:park', id),
  // Adopt a parked session on undo; { adopted:false } → caller spawns fresh (#15).
  adoptTerminal: (id: string): Promise<{ adopted: boolean; pid?: number }> =>
    ipcRenderer.invoke('pty:adopt', id),
```

- [ ] **Step 2: Verify it compiles (types flow via `typeof api`)**

Run: `pnpm typecheck`
Expected: clean (`window.api.parkTerminal` / `adoptTerminal` now typed).

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "feat(preload): expose parkTerminal + adoptTerminal (#15)"
```

---

### Task 7: Canvas — park a terminal on the delete intent

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx`

- [ ] **Step 1: Park before removing a terminal board**

In `src/renderer/src/canvas/Canvas.tsx`, in `onNodesChange`, replace the `remove` branch:

```ts
        } else if (intent.kind === 'remove') {
          removeBoard(intent.id)
          setFocusedId((f) => (f === intent.id ? null : f))
        }
```

with (park the live PTY first so undo can adopt it; the board-unmount's `killTerminal` then no-ops because the session was moved to `parked`):

```ts
        } else if (intent.kind === 'remove') {
          // #15: parking a terminal's live session BEFORE removal lets undo adopt it.
          // Sent before removeBoard → main parks before the unmount's kill arrives
          // (a single renderer's IPC is delivered in send order).
          const removed = useCanvasStore.getState().boards.find((x) => x.id === intent.id)
          if (removed?.type === 'terminal') void window.api.parkTerminal(intent.id)
          removeBoard(intent.id)
          setFocusedId((f) => (f === intent.id ? null : f))
        }
```

- [ ] **Step 2: Verify it compiles + lint clean**

Run: `pnpm typecheck && pnpm lint`
Expected: clean (no new deps for the `onNodesChange` useCallback — `useCanvasStore.getState()` is read imperatively).

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/canvas/Canvas.tsx
git commit -m "feat(canvas): park a terminal's session on delete (#15)"
```

---

### Task 8: TerminalBoard — adopt before spawning

**Files:**
- Modify: `src/renderer/src/canvas/boards/TerminalBoard.tsx`

- [ ] **Step 1: Gate spawning behind an adopt check**

In `src/renderer/src/canvas/boards/TerminalBoard.tsx`, inside the `spawn` callback, find the launch block:

```ts
    let spawned = false
    const launch = (): void => {
      if (spawned) return
      const dims = fit.proposeDimensions()
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
      spawned = true
      window.api
        .spawnTerminal({
```

Replace `let spawned = false` + the `if (spawned) return` guard so spawning is also gated on a resolved "not adopted" decision:

```ts
    // #15: try to ADOPT a parked session (undo of a delete) before spawning fresh.
    // `spawnAllowed` stays false until adopt resolves with adopted:false, so neither
    // the immediate launch() nor the ResizeObserver can spawn a fresh shell over an
    // adoptable one. When adopted, the reposted port + replayed scrollback arrive via
    // the existing onWinMsg listener.
    let spawned = false
    let spawnAllowed = false
    let disposed = false
    const launch = (): void => {
      if (spawned || !spawnAllowed) return
      const dims = fit.proposeDimensions()
      if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return
      spawned = true
      window.api
        .spawnTerminal({
```

- [ ] **Step 2: Replace the immediate `launch()` call with the adopt decision**

Find:

```ts
    // Try immediately (board mounted at normal zoom → already laid out).
    launch()
```

Replace with:

```ts
    // Decide adopt-vs-spawn once. Adopted → the reposted port + replayed buffer
    // arrive over onWinMsg (no spawn). Not adopted → allow the normal spawn flow
    // (immediate try here + the ResizeObserver's deferred try for the #34 LOD case).
    void window.api.adoptTerminal(board.id).then((res) => {
      if (disposed) return
      if (res.adopted) {
        setState('running')
      } else {
        spawnAllowed = true
        launch()
      }
    })
```

- [ ] **Step 3: Mark disposed in the cleanup**

In the `return () => { ... }` cleanup of the `spawn` callback, add `disposed = true` as the FIRST line:

```ts
    return () => {
      disposed = true
      window.removeEventListener('message', onWinMsg)
```

- [ ] **Step 4: Verify it compiles + lint + build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: clean; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx
git commit -m "feat(terminal): adopt a parked session on re-mount before spawning (#15)"
```

---

### Task 9: E2E — prove process identity + scrollback survive delete→undo

**Files:**
- Modify: `src/renderer/src/smoke/e2eHooks.ts`
- Modify: `src/main/e2eSmoke.ts`

- [ ] **Step 1: Add `deleteBoard` + `undo` e2e hooks**

In `src/renderer/src/smoke/e2eHooks.ts`, add to the `CanvasE2E` interface (after `setGesture`):

```ts
  /** Delete a board the way the canvas does (parks a terminal's session first). */
  deleteBoard: (id: string) => void
  /** Undo the last store change (restores a deleted board → adopt path). */
  undo: () => void
```

And add to the `api` object (after `setGesture`):

```ts
    deleteBoard(id) {
      const b = useCanvasStore.getState().boards.find((x) => x.id === id)
      if (b?.type === 'terminal') void window.api.parkTerminal(id)
      useCanvasStore.getState().removeBoard(id)
    },
    undo() {
      useCanvasStore.getState().undo()
    }
```

- [ ] **Step 2: Add the adopt assertion to the harness**

In `src/main/e2eSmoke.ts`, add `debugTerminalPid` + `debugWriteTerminal` to the import from `./pty`... it has none yet — add this import near the top (after the existing imports):

```ts
import { debugTerminalPid, debugWriteTerminal } from './pty'
```

Then, AFTER the `terminal-respawn` block and BEFORE the `browser-deadurl` block, insert:

```ts
  // ── #15 (park/adopt on undo): write a unique marker into the live terminal,
  // capture its pid, delete the board (parks the session), undo (adopts it), then
  // assert the SAME pid is back AND the marker replayed from the buffer — a fresh
  // spawn would have neither. Restore zoom first so the re-mounted xterm lays out. ──
  await evalIn(win, 'window.__canvasE2E.setZoom(1)')
  const ADOPT_MARKER = 'CANVAS_E2E_ADOPT_MARKER'
  debugWriteTerminal(termId, `echo ${ADOPT_MARKER}\r`)
  const markerSeen = await poll(async () => {
    const text = await evalIn<string | null>(
      win,
      `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
    )
    return typeof text === 'string' && text.includes(ADOPT_MARKER)
  }, 8000)
  const pidBefore = debugTerminalPid(termId)
  await evalIn(win, `window.__canvasE2E.deleteBoard(${JSON.stringify(termId)})`)
  await delay(200) // let the unmount + park settle
  await evalIn(win, 'window.__canvasE2E.undo()')
  const adoptedOk = await poll(async () => {
    const pidNow = debugTerminalPid(termId)
    const text = await evalIn<string | null>(
      win,
      `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
    )
    return (
      pidNow !== null &&
      pidBefore !== null &&
      pidNow === pidBefore &&
      typeof text === 'string' &&
      text.includes(ADOPT_MARKER)
    )
  }, 10000)
  parts.push({
    name: 'terminal-adopt',
    ok: markerSeen && adoptedOk,
    detail:
      markerSeen && adoptedOk
        ? `same pid ${pidBefore} + scrollback replayed after undo`
        : `markerSeen=${markerSeen} pidBefore=${pidBefore} adoptedOk=${adoptedOk}`
  })
```

Note: after `undo()` the board count returns to its pre-delete value, so the existing
final `seed` count check (`count === 4`) still holds — the delete+undo nets to zero.

- [ ] **Step 3: Build + run the e2e harness**

Run: `pnpm build && CANVAS_SMOKE=e2e pnpm start`
Expected (single, isolated run — no other Electron instances; GPU surface healthy):
- `E2E_TERMINAL-ADOPT {"name":"terminal-adopt","ok":true,"detail":"same pid <N> + scrollback replayed after undo"}`
- `E2E_DONE {"ok":true,...}` with every part ok.

If `terminal-adopt` is `ok:false` with `pidBefore` set but `adoptedOk=false`, the session was killed before park — verify Task 7 sends `parkTerminal` before `removeBoard`. If the `browser` part is `empty=true` (GPU surface), that is the known host-GPU artifact (see spec/CLAUDE.md), not this feature — re-run in a fresh session.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/smoke/e2eHooks.ts src/main/e2eSmoke.ts
git commit -m "test(e2e): assert delete→undo reattaches the same PTY + scrollback (#15)"
```

---

### Task 10: Full gate run + finalize

**Files:** none (verification only)

- [ ] **Step 1: Run every gate**

Run:
```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm format:check && pnpm build
```
Expected: tests PASS (incl. the 5 `appendRing` tests), typecheck/lint/format clean, build succeeds.

- [ ] **Step 2: Run the e2e harness once more (fresh session)**

Run: `pnpm build && CANVAS_SMOKE=e2e pnpm start`
Expected: `E2E_DONE {"ok":true,...}` including `terminal-adopt` ok. (If `browser` is `empty=true`, it's the host-GPU artifact — confirm `terminal-adopt`, `terminal`, `terminal-respawn`, `terminal-lod`, `planning`, `browser-deadurl`, `seed` are all ok.)

- [ ] **Step 3: Final commit (if format auto-fixed anything)**

```bash
git add -A -- src docs
git commit -m "chore(#15): formatting + final gate pass" || echo "nothing to finalize"
```

---

## Self-review (filled in by author)

- **Spec coverage:** park-on-delete (Task 3 + Task 7) · adopt-on-undo (Task 4 + Task 8) · ring buffer + replay (Tasks 1,2,4) · 120 s TTL (Task 3) · redo-kills (no code — redo removes via store, not `onNodesChange`, so no park; covered by design) · disposeAll/onExit reap (Task 4) · pid-identity + scrollback e2e (Task 9). All spec requirements map to a task.
- **Redo path:** intentionally no task — a redo removes the board through the store (not the `onNodesChange` remove intent), so it never parks; the adopted session is killed by the unmount, matching the locked "redo kills" decision.
- **Type/name consistency:** `appendRing`, `RING_CAP_BYTES`, `PARK_TTL_MS`, `Session.buf:{data}`, `Parked`, `parked`, `park`, `reapParked`, `adopt`, `debugTerminalPid`, `debugWriteTerminal`, preload `parkTerminal`/`adoptTerminal`, hooks `deleteBoard`/`undo`, e2e part `terminal-adopt` — used consistently across tasks.
- **Ordering guarantee:** Task 7 relies on a single renderer's IPC being delivered in send order (park before the unmount's kill). The Task 9 e2e empirically validates it (pid match); if it ever flakes, await `parkTerminal` before `removeBoard`.

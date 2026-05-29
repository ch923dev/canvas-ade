# Design — Restore a deleted terminal's live session on undo (bug #15)

- **Date:** 2026-05-30
- **Branch:** `fix/terminal-undo-session-15` (off `fix/confirmed-bugs`)
- **Bug:** #15 — undo of a Terminal-board delete spawns a *fresh* shell instead of restoring the live agent session.

## Problem

A Terminal board has two halves:

- the **screen** — the `xterm.js` instance in the renderer window (what you see/type), and
- the **engine** — the `node-pty` process (shell + any agent) running in MAIN.

Today, deleting a terminal board unmounts `TerminalBoard`, whose effect cleanup calls
`killTerminal(id)` → `killTree(proc)` — the engine is killed. Undo restores the board row,
re-mounts `TerminalBoard`, and its spawn effect calls `spawnTerminal` → a **brand-new** shell.
A mid-task agent and the on-screen history are lost.

## Goal / success criteria

After deleting a terminal board and pressing undo (within the TTL):

1. The **same** `node-pty` process is reattached — verifiable by **PID identity** (same pid before delete and after undo).
2. The terminal's **scrollback/history** is restored (replayed), not blank.
3. The user can keep interacting with the still-running agent.
4. No regression to: config-respawn, restart, LOD/drag survival, app-quit cleanup, security model.

## Non-goals (out of scope)

- Persisting a parked session across an **app restart** (runtime-only; persistence is Phase 3).
- Restoring the session on **redo-then-undo** of a delete (see Locked decisions).
- Pixel-exact restore of full-screen **TUI/alt-screen** agents (raw-byte replay reconstructs to the last redraw; the agent repaints on next interaction).

## Locked decisions

| Topic | Decision |
|---|---|
| Mechanism | Park-on-delete / adopt-on-undo in MAIN. |
| Scrollback | Capped per-session **output ring buffer** in MAIN, replayed on adopt. **No new dependency** (rejected `@xterm/addon-serialize`). |
| Ring buffer cap | ~256 KB, drop-oldest. |
| Park TTL | **120 s** — then `killTree` the parked engine. |
| Redo of a delete | **Kills** the session (no re-park); a later undo spawns fresh. |
| Delete chokepoint | The renderer **delete site** (`Canvas.onNodesChange` `remove` intent), NOT the React unmount. |

## Architecture

The crux: `TerminalBoard`'s effect cleanup runs on **two** different events —
(a) a true component unmount (board deleted), and
(b) an effect re-run when spawn deps change (config-respawn: shell/launchCommand/cwd edited).
Case (b) **must still kill** and respawn. So we cannot "park whenever the box disappears."

**Solution:** park is requested explicitly at the *delete site* in the renderer, which `move`s
the session from `sessions` into a `parked` map. The unmount cleanup still calls
`killTerminal(id)`, but `cleanup` finds nothing in `sessions` (already moved) → no-op. Config-respawn
never calls park, so its cleanup kills normally. This cleanly separates the two paths with no flag.

```
delete (Backspace/Delete) ──> Canvas.onNodesChange 'remove' (terminal?) ──> pty:park(id)
                                                                              │ moves sessions→parked, starts 120s timer
                              ──> removeBoard(id) ──> TerminalBoard unmount ──> killTerminal(id) [no-op: parked]

undo ──> board row restored ──> TerminalBoard mount ──> spawn effect ──> pty:adopt(id)
            adopted? ── yes ─> rewire port, replay ring buffer, re-emit running  (SAME pid)
                     └─ no  ─> spawnTerminal  (fresh, current behavior)
```

## Detailed design

### MAIN — `src/main/pty.ts`

- **Ring buffer per session.** Extend `Session` with a buffer of recent raw output. In `proc.onData`,
  append the chunk (then trim to the cap) **and** forward to the port as today. Extract the
  append+cap logic as a **pure** helper (e.g. `appendRing(prev, chunk, cap): string`) for unit tests.
- **`parked: Map<id, { proc, buffer, timer }>`.**
- **`pty:park(id)`** — if a live session exists: `sessions.delete(id)`, close its renderer port
  (the proc keeps running and keeps appending to `buffer`; the now-portless `proc.onData` forward is
  guarded), and start a `setTimeout(TTL)` that on expiry runs `killTree(proc)` + `parked.delete(id)`.
  Returns `void`. (Because the session is moved out of `sessions`, the subsequent unmount
  `killTerminal(id)` → `cleanup` no-ops.)
- **`pty:adopt(id)`** — if `parked` has `id`: clear the timer; create a fresh `MessageChannelMain`;
  rewire `proc.onData → port1` (+ buffer append) and `port1` input/resize → `proc`; move the entry
  into `sessions`; `win.webContents.postMessage('pty:port', { id }, [port2])`; **replay** the ring
  buffer to `port1` as `{ t:'data', d }`; re-emit `{ t:'state', state:'running' }`. Return
  `{ adopted: true, pid }`. Else return `{ adopted: false }`.
- **`disposeAllPtys`** — also `killTree` every `parked` proc and clear their timers (so app-quit /
  `crashShutdown` don't leak a parked agent).
- **Constants:** `PARK_TTL_MS = 120_000`, `RING_CAP_BYTES = 256 * 1024`.
- **E2E-only:** `debugTerminalPid(id): number | null` — the pid of the live (or, for the test, just-adopted) session, to assert PID identity. Read-only; no security change.

`killTree`, `cleanup`, `isStaleExit`, spawn/restart paths are unchanged.

### preload — `src/preload/index.ts` (+ `index.d.ts`)

Add to the `api`: `parkTerminal(id): Promise<void>` and `adoptTerminal(id): Promise<{ adopted: boolean; pid?: number }>`. No new MessagePort surface (adopt reuses the existing `pty:port` channel).

### Renderer — `src/renderer/src/canvas/Canvas.tsx`

In `onNodesChange`, the `remove` intent: if the removed board is `type === 'terminal'`, call
`window.api.parkTerminal(intent.id)` **before** `removeBoard(intent.id)`. This is the single
realistic delete path (React Flow `deleteKeyCode` Backspace/Delete → remove intent).

### Renderer — `src/renderer/src/canvas/boards/TerminalBoard.tsx`

In the spawn effect, after the xterm + `onWinMsg` listener are set up: call `adoptTerminal(board.id)`.
- **adopted** → do **not** call `spawnTerminal`; the existing `onWinMsg` receives the reposted port,
  the replayed buffer arrives as `data` (xterm reconstructs), and `{t:'state',running}` sets state.
  Then send one resize to match the new fit dimensions.
- **not adopted** → the current `launch()`/`spawnTerminal` path (unchanged).

Cleanup is unchanged (`killTerminal` → no-op when parked).

## Data-flow walkthroughs

- **Delete → undo (happy path):** park moves engine aside + 120 s timer; unmount kill no-ops; undo
  re-mounts → adopt → same pid + replayed scrollback. ✓
- **Config-respawn:** deps change → effect cleanup `killTerminal` kills the in-`sessions` engine (no
  park requested) → effect re-runs → adopt finds nothing → fresh spawn. Unchanged. ✓
- **Redo of a delete:** redo removes the board via the store (not `onNodesChange`) → no park → unmount
  `killTerminal` kills the adopted engine. A later undo spawns fresh. (Accepted.)
- **Undo of a board *create*:** undo removes a just-created board (not via `onNodesChange`) → no park →
  killed. Correct (you're un-creating it). ✓
- **TTL expiry / app-quit / crash:** parked engine reaped by the timer or `disposeAllPtys`. ✓
- **New board from the dock:** new id → adopt finds no parked match → fresh spawn. Only undo restores
  the same id. ✓

## Testing

- **Unit (`src/main/pty.test.ts`):** `appendRing` (append, cap, drop-oldest, exact-boundary); park→adopt
  Map transitions and TTL reap via injectable timer/realpath-style seams where practical.
- **E2E (`src/main/e2eSmoke.ts` + hooks):** seed a terminal; write a unique runtime marker into the PTY
  over the port; capture `debugTerminalPid`; delete the board; undo; assert (a) **same pid** and (b) the
  marker is present in the framebuffer (a fresh spawn would have neither). New e2e hooks:
  `deleteBoard(id)`, `undo()`, `writeTerminal(id, data)`.
- **Gates:** `pnpm test · typecheck · lint · format:check · build` + the e2e harness, all green.

## Risks / tradeoffs

- **Memory:** one capped (~256 KB) buffer per terminal, always on (needed for pre-delete scrollback).
  Bounded by cap × terminals — a few MB worst case. Acceptable.
- **Alt-screen TUI replay:** reconstructs to the last redraw, not a pixel-perfect snapshot; the agent
  repaints on next interaction. Acceptable per non-goals.
- **Leaked agent window:** a deleted-not-undone agent runs up to 120 s. Bounded by the TTL.

# PTY-1: Parked PTY sessions not reaped on project switch

- **Severity:** Medium
- **Category:** PTY lifecycle / resource leak
- **Status:** CONFIRMED (high confidence)
- **Files touched:** `src/renderer/src/store/disposeLiveResources.ts`, `src/main/pty.ts`, `src/renderer/src/canvas/AppChrome.tsx`
- **Assigned:** _(blank)_

## Summary
Switching projects leaks node-pty child process trees. A terminal that was **deleted within the last 120 s**
(awaiting undo) is moved to main's `parked` map. On project switch, `disposeLiveResources()` only kills
**live** terminals still present in the boards array; the parked session is neither iterated nor reaped, so
its shell + agent child tree stays alive until the `PARK_TTL_MS = 120_000` timer fires.

## Where
`disposeLiveResources.ts:13-17` iterates `useCanvasStore` boards filtered to `type === 'terminal'` and calls
`window.api.killTerminal(b.id)`. A deleted-then-parked terminal is **no longer in the boards array**, so it is
never iterated.

Even if `killTerminal` were called for a parked id, `pty:kill → cleanup → cleanupCore` (`pty.ts:565`) does
`sessions.get(id)` and no-ops on the `if (!s) return` guard — the parked session lives in the `parked` map
(moved there by `parkCore`, `pty.ts:129/137`), not `sessions`.

The only drain of `parked` is `disposeAllPtysCore` (`pty.ts:587-595`, via `reapParkedCore`), and
`disposeAllPtys()` is wired **only to app-quit** (`index.ts:199`) — never to project switch
(`AppChrome.tsx:62 switchTo → disposeLiveResources()` only). Preload (`preload/index.ts:69-74`) exposes
`pty:kill/pty:park/pty:adopt` but **no parked-reaping IPC** the renderer could call on switch.

## How it triggers
1. Open a terminal board, let it spawn an agent / long-lived dev server.
2. Delete that terminal (it parks, awaiting undo).
3. Within 120 s, switch to another project.
4. The parked session's process tree stays alive until `reapParked` fires at the 120 s TTL.

## Verification evidence
Adversarially confirmed. Matches the prior cross-check note
`../2026-06-01-indepth-review/CROSSCHECK-ed1d551.json:172-173` (PR #12 added the both-map drain but
connected it **only** to app-quit). This is the residual of the previously-noted "parked-PTY leak on switch".

## Suggested fix direction
Add a parked-reap step to the project-switch teardown. Either:
- Expose a `pty:disposeAll` (or `pty:reapParked`) IPC and call it from `disposeLiveResources()` /
  `AppChrome.switchTo` before loading the new project, **or**
- Have `disposeAllPtysCore` run on switch (not just quit) — drains both `sessions` and `parked`.

Prefer draining both maps on switch since parked sessions belong to the project being left.

## Collision notes
Lane A. Touches `main/pty.ts` (+ maybe `preload/index.ts`, `index.ts`) and `store/disposeLiveResources.ts`.
No overlap with Lanes B/C/D.

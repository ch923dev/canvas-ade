# FIND-009 — boardCwds map leaks a stale (board-id → cwd) entry when a parked terminal is reaped on TTL expiry or exits while parked, until project switch

| | |
|---|---|
| **Severity** | Low |
| **Category** | resource leak |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/main/pty.ts:224-234` |
| **Discovery slice** | M-PTY-TERM (run 1) |

## Summary
boardCwds (resolved spawn cwd per board id, for the read-only gitDiff) is set on spawn (line 473) and deleted only in cleanupCore (line 568) or cleared wholesale in disposeAllPtys (line 686). The two teardown paths for a PARKED (deleted-but-undoable) session never delete its boardCwds entry: reapParkedCore (TTL expiry, lines 224-234) and the parked-natural-exit branch in onExit (lines 463-467) both remove the proc from the `parked` map but leave boardCwds[id] in place. So a terminal board that is deleted (-> parkCore moves it to `parked`, boardCwds untouched by design so it survives undo) and is then NOT undone within PARK_TTL_MS (reaped) — or exits on its own while parked — leaves a permanent boardCwds[id] entry until the next project switch. The cleanupCore comment (lines 564-567) explicitly says the map 'otherwise only drained on project switch' and that the live-teardown delete was added to stop accretion, but the symmetric parked-teardown paths were not updated, so the accretion the comment intended to fix still occurs for parked-then-reaped/exited boards.

## Trigger
Create a terminal board (spawn sets boardCwds[id]); delete the board (parkCore parks it, leaving boardCwds[id]); let the 120s PARK_TTL expire without an undo (reapParkedCore runs, deletes from `parked` but not from boardCwds) — or have the parked shell exit on its own (onExit lines 463-467 delete from `parked` but not from boardCwds). Repeat across many terminal create/delete cycles in one long-lived project session and boardCwds grows by one stale (id -> cwd path) entry each time, never reclaimed until disposeAllPtys on project switch.

## Evidence / concrete faulty path (code-grounded)
Faulty path (shipped, reproducible): 1) Create a terminal board → pty:spawn handler sets boardCwds.set(opts.id, spawnCwd) (src/main/pty.ts:473). 2) Delete the board → pty:park IPC (line 516) → park() (line 325) → parkCore() removes it from `sessions` (line 250) and arms setTimeout(() => reap(id), PARK_TTL_MS) (line 256); boardCwds[id] untouched (by design, survives undo). 3) Do NOT undo within PARK_TTL_MS (120s) → the timer fires reapParked (line 316) → reapParkedCore (lines 229-233): `parkedMap.delete(id); clearTimeout(p.timer); return deps.killTree(p.proc)` — boardCwds[id] is NEVER deleted. Alternate trigger: the parked shell exits on its own → onExit parked branch (lines 463-467) `parked.delete(opts.id)` with no boardCwds.delete. Drain only at disposeAllPtys() boardCwds.clear() (line 686, project switch). cleanupCore (line 568) is the sole per-board delete and is unreachable on the parked path because parkCore (line 250) already removed the id from `sessions`, so cleanupCore hits `if (!s) return` (line 561). No correctness impact: boardGitDiff (src/main/gitDiff.ts:19) only reads getTerminalCwd for ids the orchestrator resolves to existing boards (gitDiff.ts:9 comment), and a reaped board id is gone, so the stale entry is never queried.

## Verifier reasoning (why CONFIRMED; scope & severity)
The candidate's mechanism is factually correct against the shipped code. boardCwds (src/main/pty.ts:167) is set on spawn (line 473), deleted only in cleanupCore (line 568) and cleared wholesale in disposeAllPtys (line 686). The two parked-teardown paths both skip boardCwds: reapParkedCore (lines 229-233) does parkedMap.delete + clearTimeout + killTree with no boardCwds.delete; the onExit parked branch (lines 463-467) does clearTimeout + parked.delete with no boardCwds.delete. parkCore (line 250) removes the session from `sessions` WITHOUT routing through cleanupCore, so cleanupCore early-returns for a parked id (line 561) and never runs its boardCwds.delete (line 568). So a deleted-and-reaped (or parked-then-self-exited) terminal leaves a stale boardCwds[id] entry until the next project switch. This is the exact accretion the cleanupCore comment (lines 564-567) says the live-teardown delete was added to prevent — the symmetric parked paths were simply not updated, so the intent is defeated for the parked case. The production path is real, not test-only: pty:park IPC (line 516) → park (line 325) → parkCore arms setTimeout(reap, PARK_TTL_MS) (line 256) → reapParked (line 316) → reapParkedCore. Severity stays Low: each leaked slot is one (board-id string → cwd path string) Map entry (a few hundred bytes), it is self-bounding (fully drained on every project switch via disposeAllPtys), and it has ZERO correctness/security impact — boardCwds is keyed by board id and only read by boardGitDiff via the orchestrator, which only queries ids of boards that still exist, so a reaped/gone board id is never looked up and can never produce a wrong diff. It is a genuine but negligible resource leak, in scope as a resource/memory-leak class item (not a perf-re-render / a11y / styling / UX-feedback / file-size audit item).

## Fix direction (audit only — NOT applied)
Delete boardCwds[id] in reapParkedCore and the parked-natural-exit branch of onExit (mirror cleanupCore line 568), so a parked-then-reaped/exited board does not leave a stale (id->cwd) entry until project switch.

## Files this card touches
- `src/main/pty.ts (reapParkedCore 224-234; onExit parked branch 463-467)`

## Collision flags (sequence with)
- pty.ts boardCwds also relevant to FIND-001 fix

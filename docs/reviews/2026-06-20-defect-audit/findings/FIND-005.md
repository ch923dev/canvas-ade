# FIND-005 — Stale runDispatch clobbers a task transitioned by the board-gone handler or Retry (failed→done flip / dead-run result on the live retry)

| | |
|---|---|
| **Severity** | Medium |
| **Category** | concurrency · state-machine |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/renderer/src/canvas/boards/command/useCommandDispatch.ts:143-198` |
| **Discovery slice** | R-COMMAND (run 2) |

## Summary
runDispatch keys all its store writes by the captured task `id` and re-reads the live store fresh on each step (setTaskStatus(id,'reporting') → setTaskResult(id,...) → setTaskStatus(id, done|failed)), with NO run-generation/epoch guard. While one runDispatch is awaiting awaitSettled(terminalId), the same task can be transitioned out from under it by another path: (1) the onTaskStatus 'gone' handler sets the task to 'failed' (line 262) when its worker board is closed mid-flight, or (2) the user clicks Retry, which calls retryTask(id) (failed→queued, clears group) then pumps a SECOND concurrent runDispatch(id) on a fresh group. In MAIN, awaitSettled RESOLVES (not rejects) when the board leaves the canvas (mcpOrchestrator.ts:746 finish() on board-gone), returning the old/empty BoardResult. So the stale runDispatch then overwrites the task: it writes 'reporting', snapshots the OLD worker's result/diff, and flips status to isFailureResult(result)?'failed':'done' — clobbering the 'failed' set by the gone handler (a worker closed mid-flight can end up displayed as DONE) or applying the dead run's result onto the live retried run.

## Trigger
Dispatch a task; while it is 'executing' (awaitSettled pending), close its worker terminal board (status→gone). The gone handler marks the card failed; moments later awaitSettled resolves (board-gone) and the stale runDispatch overwrites it back to done/reporting with the old worker's result. The retry variant: gone→failed→user clicks ↻ (retry) before the old awaitSettled resolves → two runDispatch invocations race on the same id, the stale one clobbering the fresh run.

## Evidence / concrete faulty path (code-grounded)
Concrete faulty path (gone variant): (1) Dispatch a task; runDispatch spawns group, sets 'executing', delivers the prompt, then parks at `await retryUntilReady(() => awaitSettled(terminalId))` (useCommandDispatch.ts:174). (2) User closes the worker terminal board mid-flight. The renderer republishes a board snapshot without it → diffStatus emits `{status:'gone'}` (boardRegistry.ts:128) → emitStatus immediately → onTaskStatus handler sets the task to 'failed' (useCommandDispatch.ts:262, next='failed' via commandDispatch.ts:206). (3) Up to ~1s later awaitSettled's poll notices the missing board → finish()/resolve → returns readResult = `{present:false}` (mcpOrchestrator.ts:746,755; boardResults.ts:28). (4) The still-pending runDispatch resumes: setTaskStatus(id,'reporting') (line 178), setTaskResult(id,{present:false},'') (line 185), then isFailureResult({present:false})===false → setTaskStatus(id,'done') (line 186). Net result: a worker the user closed mid-run is displayed as successfully DONE, clobbering the 'failed' the gone handler set. Retry variant: gone→failed→user clicks ↻ → retryTask (failed→queued, group cleared, lines 242-243) → pump fires a fresh runDispatch(id) (line 139) while the first runDispatch (holding the OLD terminalId closure) is still awaiting the OLD awaitSettled; when it resolves it writes the dead run's result/status onto the now-live retried task — no epoch guard at useCommandDispatch.ts:178/185/186 distinguishes the two runs.

## Verifier reasoning (why CONFIRMED; scope & severity)
The candidate accurately describes a real lost-update race with no generation/epoch guard, and every link in the chain checks out against the actual code.

1. runDispatch (useCommandDispatch.ts:143-198) keys ALL its post-settle store writes by the captured task `id` and re-reads getState() fresh on each step, with NO check that the task is still the same run/group it spawned: setTaskStatus(id,'reporting') (line 178), setTaskResult(id,result,diff) (line 185), setTaskStatus(id, isFailureResult(result)?'failed':'done') (line 186). The captured `terminalId` lives in a local closure (line 161).

2. The store primitives confirm no guard: setTaskStatus/setTaskResult key only by id with no status/group comparison (commandStore.ts:235-240); retryTask only checks status==='failed' (line 246); TaskGroup carries no run-id that is checked on write.

3. MAIN awaitSettled RESOLVES (not rejects) on board-gone: the 1000ms poll hits `if (!registry.listBoards().some((b) => b.id === boardId)) return finish()` (mcpOrchestrator.ts:746) then `return registry.readResult(boardId)` (line 755), which for a gone board is readBoardResult → `{ present: false }` (boardResults.ts:28).

4. Timing favors the race: the 'gone' status push is EVENT-DRIVEN (applySnapshot→emitStatus, boardRegistry.ts:128/161 — fires immediately when the renderer republishes a snapshot lacking the board), while awaitSettled notices the gone board only on its 1000ms SETTLE_POLL_MS tick (mcpOrchestrator.ts:720,745-751). So the onTaskStatus 'gone' handler (useCommandDispatch.ts:257-264 → nextStatusForBoardChange returns 'failed' for executing, commandDispatch.ts:206) reliably sets the card to 'failed' BEFORE awaitSettled resolves up to ~1s later.

5. The failed→done FLIP is real and worse than claimed-neutral: isFailureResult({present:false}) is false because it requires r.status to be a string matching /fail|error/i (commandDispatch.ts:176-177). So when the stale runDispatch resumes, it overwrites 'failed' → 'reporting' → flips to 'done' (line 186) and snapshots the empty result onto the card — a worker closed mid-flight is displayed as DONE.

6. The retry variant is user-reachable: retry() calls retryTask(id) (failed→queued, clears group) then pumpRef.current?.() (lines 242-245); pump finds the re-queued task and fires a SECOND concurrent runDispatch(id) (line 139) while the first is still awaiting the OLD awaitSettled — the stale one then writes the dead run's empty result onto the live retried task.

No guard exists elsewhere; this is shipped renderer code, not test-only.

Severity downgraded from the claimed High to Medium: the trigger requires a board to be closed (or Retry clicked) specifically during the poll-bounded awaitSettled window, and the impact is a misleading card status / stale result display in the MCP orchestrator command board — not data loss, crash, or a security weakening. It is a genuine correctness defect users can hit, but with a narrow timing window and bounded blast radius.

## Fix direction (audit only — NOT applied)
Tag each dispatch with a generation/run id; before applying a settle result, verify the task is still running for THIS run id. Drop stale results so a late settle cannot flip a failed task to done or clobber a fresh Retry.

## Files this card touches
- `src/renderer/src/canvas/boards/command/useCommandDispatch.ts (143-198)`
- `src/renderer/src/store/commandStore.ts (task transitions)`

## Collision flags (sequence with)
- useCommandDispatch.ts → FIND-006

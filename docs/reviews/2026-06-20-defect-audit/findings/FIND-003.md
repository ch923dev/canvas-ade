# FIND-003 — Unguarded `await import('chokidar')` in fire-and-forget watch() rejects to MAIN unhandledRejection sink → app.exit(1) (call-site try/catch only guards sync throws)

| | |
|---|---|
| **Severity** | Medium |
| **Category** | error-handling · availability |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/main/fileWatch.ts:95-141` |
| **Discovery slice** | M-PERSIST (run 2) |

## Summary
createFileWatcher().watch() is documented and used as a best-effort, never-aborts side effect, but its body has NO try/catch around the two operations that can realistically reject/throw: `await import('chokidar')` (line 106, an ESM-only lazy dynamic import — fragile in packaged builds) and `chokidarWatch(root, {...})` (line 108, which can throw on an inaccessible/exotic root). The only guarded throw is the realpath fallback (lines 100-104). watch() is invoked as fire-and-forget `void fileWatcher?.watch(dir)` in index.ts:523 with no `.catch`. A rejection therefore becomes an unhandledRejection, and index.ts:842 wires `process.on('unhandledRejection', (reason) => crashShutdown(1, reason))`, i.e. `app.exit(1)`. So a recoverable file-tree-watcher init failure takes down the ENTIRE app (PTYs, previews, unsaved edits) instead of just leaving the docked tree non-live.

## Trigger
Open or switch to a project where chokidar's lazy ESM import fails (packaging/module-resolution error) or chokidarWatch throws on the project root (e.g. a root that becomes inaccessible between realpath and watch). The rejected promise from `void fileWatcher?.watch(dir)` reaches the global unhandledRejection handler → app.exit(1).

## Evidence / concrete faulty path (code-grounded)
CONFIRMED faulty path: index.ts:523 `void fileWatcher?.watch(dir)` (no .catch) -> fileWatch.ts watch() async body, line 106 `const { watch: chokidarWatch } = await import('chokidar')` is NOT in a try/catch (only realpath at 100-104 is) -> if that ESM dynamic import (chokidar 5.0.0, type:module, packed inside app.asar — NOT in electron-builder.yml asarUnpack) rejects, the discarded promise rejects in its async continuation. The surrounding try/catch at projectIpc.ts:253-257 catches only the SYNCHRONOUS callback invocation, not this later rejection (watch() returns immediately via `void`). The rejection reaches index.ts:842 `process.on('unhandledRejection', (reason) => crashShutdown(1, reason))`; crashShutdown=makeCrashHandler (index.ts:836-840) calls `deps.exit(exitCode)` = `app.exit(1)` (quit.ts:46) -> entire app exits (PTYs, previews, unsaved edits) for a recoverable docked-tree watcher init failure. Refutation of the candidate's other trigger half: empirically tested chokidar 5.0.0 watch() on '', 'Z:/ bad', and a non-existent root -> all returned without a synchronous throw and without an async error event; operational/permission errors route to the wired .on('error') (fileWatch.ts:130, non-fatal) or are swallowed by ignorePermissionErrors:true (line 112). So `chokidarWatch throws` does not occur — only the import() rejection is a real (uncommon) trigger.

## Verifier reasoning (why CONFIRMED; scope & severity)
The structural defect is real and verified by reading the actual code. createFileWatcher().watch() (fileWatch.ts:95-141) is an async function whose only try/catch wraps the realpath fallback (lines 100-104). The two post-await operations the candidate names — `await import('chokidar')` (line 106) and `chokidarWatch(root, {...})` (line 108) — are genuinely unguarded. The call site index.ts:523 is `void fileWatcher?.watch(dir)` with no `.catch`. I confirmed the global sink: index.ts:842 `process.on('unhandledRejection', (reason) => crashShutdown(1, reason))`, and crashShutdown = makeCrashHandler whose `exit: (code) => app.exit(code)` (index.ts:838, quit.ts:45-46) — so an unhandled rejection from watch() does call app.exit(1), taking down PTYs/previews/unsaved edits for a recoverable watcher-init failure.

I checked the one plausible exculpatory guard: the callback containing `void fileWatcher?.watch(dir)` is invoked inside a try/catch at projectIpc.ts:253-257 (`onProjectOpen(r.dir)`). This does NOT save the defect: try/catch only catches a SYNCHRONOUS throw from the callback. `void fileWatcher?.watch(dir)` returns the promise immediately and discards it; watch() is `async` and the throwable work (import/constructor) runs in the async continuation AFTER the synchronous callback has returned and the try block has exited. So the rejection still escapes to the global unhandledRejection sink. The codebase itself treats this exact class as a real bug (BUG-001 comments at index.ts:662-665 — "a throw escapes to uncaughtException -> crashShutdown(1)"; the memory.* try/catch guards; BUG-015 which notes the MAIN unhandledRejection->crash distinction).

I partially REFUTE the candidate's trigger framing, which is why this is Medium not High. I empirically tested chokidar v5.0.0's behavior: chokidarWatch() does NOT throw synchronously on empty/spaced/non-existent/inaccessible roots — it returns a watcher object and routes operational errors to the wired `.on('error')` handler (line 130, non-fatal) or swallows them via ignorePermissionErrors:true. So the "chokidarWatch throws on an inaccessible/exotic root" half of the trigger is refuted. Only the `await import('chokidar')` rejection half stands. That half is real but uncommon: chokidar is ESM-only (type:module) and is packed INSIDE app.asar (electron-builder.yml asarUnpack lists only **/*.node, node-pty, recordSession.js — NOT chokidar), loaded via dynamic import() — a genuinely more fragile path in packaged Electron than a CJS require, reachable on a corrupted/partial install or an asar+ESM resolution edge. watch() is a real runtime path (index.ts:523 on every project open/switch), not test-only; fileWatch.test.ts only covers the pure helpers and never exercises watch() or mocks an import failure.

Net: correct code-level defect (unguarded MAIN fire-and-forget reaching the crash sink, try/catch does not protect it), severe outcome (full-app exit) but a narrow/uncommon trigger (import-rejection only) — Medium. inScope=true: this is an error-handling correctness defect (crash on a recoverable failure), not a perf/a11y/styling/UX item from the 2026-06-19 improvement audit.

## Fix direction (audit only — NOT applied)
Wrap the await import(chokidar) + chokidarWatch(...) body in try/catch and resolve to a non-live no-op (tree degrades to non-live), or attach a .catch() at the `void fileWatcher?.watch(dir)` call site, so a recoverable watcher-init failure cannot reach the global unhandledRejection -> app.exit(1) sink. Consider asarUnpacking chokidar (ESM-in-asar is the fragile path).

## Files this card touches
- `src/main/fileWatch.ts (watch() 95-141)`
- `src/main/index.ts (call site 523; unhandledRejection sink 842)`

## Collision flags (sequence with)
- index.ts → FIND-001

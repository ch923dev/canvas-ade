# SAVE-1: Autosave I/O failure silently swallowed (no user feedback)

- **Severity:** Low
- **Category:** error-handling / silent failure
- **Status:** PARTIAL — original "crashes MAIN process" claim REFUTED; real residual confirmed
- **Files touched:** `src/main/projectIpc.ts`, `src/renderer/src/store/useAutosave.ts`
- **Assigned:** _(blank)_

## Summary
`project:save` (`projectIpc.ts:99-105`) has no try/catch around `await writeProject(dir, doc)`, and
`writeProject` can throw (mkdir, `writeFileAtomic`). On the renderer side, `useAutosave.ts:34`
`createAutosaver.run()` is fired via `void run()` / `void saver.flush()` and does not catch. An autosave I/O
failure (disk full, permission denied) is therefore **silently swallowed — the user gets no feedback that the
save failed**.

## What was REFUTED
The original claim said the rejection "propagates as an uncaught exception and crashes the main process" via
`index.ts:273-274 unhandledRejection → crashShutdown(1)`. **False.** Electron's `ipcMain.handle` awaits the
handler and serializes a rejected promise back to the renderer's `ipcRenderer.invoke()` — it does **not**
surface as a Node `unhandledRejection`, so `crashShutdown` never fires. No MAIN crash, no app termination, no
"subsequent saves fail until restart" (next debounce tick calls a fresh `writeProject`). The repo's own
`unconfirmed.md:10` already records this "runtime consumes them" reasoning for an analogous claim.

## Real impact
The renderer `invoke` promise rejects; `void run()` floats the rejection in the renderer (which has no crash
sink) → save failure is invisible. Low severity: no crash, no immediate data loss, but a persistently failing
disk means silent loss of all unsaved work with zero signal.

## Suggested fix direction
1. Wrap the `project:save` handler body in try/catch and return a typed `{ ok: false, error }` (or rethrow as a
   structured error) instead of letting it reject opaquely.
2. In `useAutosave`, `.catch()` the `run()` / `flush()` promises and surface a non-blocking "save failed"
   indicator (and/or `console.warn`) so a failing disk is visible.

## Collision notes
Lane C (with PERSIST-1). Touches `main/projectIpc.ts` + `store/useAutosave.ts`.

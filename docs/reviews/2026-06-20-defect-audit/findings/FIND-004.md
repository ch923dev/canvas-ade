# FIND-004 — project:reopenFromBak omits the BUG-006 approved-root gate — bounded arbitrary canvas.json.bak read from a compromised renderer

| | |
|---|---|
| **Severity** | Medium |
| **Category** | security · authz |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/main/projectIpc.ts:279-283` |
| **Discovery slice** | M-PERSIST (run 2) |

## Summary
project:open (line 232) and project:create (line 300) both enforce `isApprovedTarget(dir)` after `isUnsafeProjectDir`, the explicit BUG-006 defense so a compromised/sandbox-escaped renderer cannot open/read an arbitrary absolute path. The sibling recovery read `project:reopenFromBak` validates ONLY `isUnsafeProjectDir(dir)` (which merely blocks `..` traversal and requires an absolute path) and then calls `readBak(dir)`, which JSON-parses and returns the contents of `<dir>/canvas.json.bak`. Because the approved-root gate is absent, a renderer can pass any traversal-free absolute path and exfiltrate the parsed JSON of any file literally named `canvas.json.bak` anywhere on the filesystem — a real arbitrary-file-read primitive (bounded to that filename) that contradicts the module's own stated invariant.

## Trigger
A compromised renderer (the exact threat model BUG-006/isApprovedTarget defends) invokes `window.api.project.reopenFromBak('C:\\some\\other\\project')` (or any absolute, `..`-free path) for a dir never picked/opened. isUnsafeProjectDir passes; readBak reads and returns that location's canvas.json.bak contents.

## Evidence / concrete faulty path (code-grounded)
projectIpc.ts:279-283 — `ipcMain.handle('project:reopenFromBak', (e, dir) => { if (guard(e)) return {ok:false,error:'forbidden'}; if (isUnsafeProjectDir(dir)) return {ok:false,error:'invalid path'}; return readBak(dir) })` — no `await isApprovedTarget(dir)`, unlike line 232 (open) and line 300 (create) which both have it. `isUnsafeProjectDir` (lines 41-53) passes any `..`-free absolute path. readBak (projectStore.ts:96-100) → tryParse(join(dir,'canvas.json.bak')) (lines 71-78) JSON-parses and returns the file. Preload forwards the renderer-supplied dir verbatim (preload/index.ts:474-475). Repro: a compromised renderer calls `window.api.project.reopenFromBak('C:\\victim\\proj')` for a dir never picked/opened → `{ok:true, doc:<parsed contents of C:\victim\proj\canvas.json.bak>}` returned to the renderer. The un-gated read is even codified by projectIpc.integration.test.ts:135 ("returns the .bak doc ... no currentDir/recents/gc") invoking it with a bare `/proj`.

## Verifier reasoning (why CONFIRMED; scope & severity)
Verified against the actual code. BUG-006 (FIX-REPORT commit 4d7c25c) introduced `isApprovedTarget` as an explicit defense-in-depth gate so "a compromised renderer must not open an arbitrary path" (projectIpc.ts:230-232). Both `project:open` (line 232) and `project:create` (line 300) enforce `if (!(await isApprovedTarget(dir)))` immediately after `isUnsafeProjectDir`. The sibling recovery handler `project:reopenFromBak` (lines 279-283) enforces ONLY `guard(e)` + `isUnsafeProjectDir(dir)` and then calls `readBak(dir)` with no approved-root gate. `isUnsafeProjectDir` (lines 41-53) only rejects empty/relative/`..`-traversal paths — any traversal-free absolute path passes. `readBak` (projectStore.ts:96-100) → `tryParse(join(dir, CANVAS_BAK))` (lines 71-78) `JSON.parse`s and returns `<dir>/canvas.json.bak` and has no containment of its own. The handler accepts an arbitrary `dir` argument from the renderer (preload index.ts:474-475 forwards it verbatim); there is no server-side binding to the current project dir. So within the exact threat model BUG-006 defends (compromised/sandbox-escaped renderer), this is a reachable gap that contradicts the module's own stated invariant. The integration test at projectIpc.integration.test.ts:135-152 even asserts the handler returns the .bak doc for a bare `/proj` arg with "no currentDir/recents/gc" — codifying the un-gated read. Not a false positive: no compensating guard exists elsewhere; the path is the same IPC surface a compromised renderer reaches; it is not test-only (the renderer legitimately invokes it at canvasStore.ts:1065). Severity held at Medium (not High): it is a defense-in-depth layer behind the primary sandbox/contextIsolation boundary, requires an already-compromised renderer, and the exfil primitive is bounded to JSON files literally named `canvas.json.bak` (not arbitrary files), so it cannot read `/etc/passwd` etc. Not an improvement-audit/perf/a11y/style item — it is a security-correctness gap in a documented guard.

## Fix direction (audit only — NOT applied)
Apply the same approved-root gate that project:open / project:save enforce to project:reopenFromBak before reading canvas.json.bak, so a compromised renderer cannot read a .bak from an arbitrary directory.

## Files this card touches
- `src/main/projectIpc.ts (project:reopenFromBak 279-283)`

## Collision flags (sequence with)
- projectIpc.ts → FIND-014 (isUnderApprovedRoot)

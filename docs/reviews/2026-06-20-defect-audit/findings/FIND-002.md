# FIND-002 — FileBoard save is a blind last-writer-wins overwrite — concurrent external (agent) edits to an open dirty file are silently lost

| | |
|---|---|
| **Severity** | Medium |
| **Category** | data integrity · lost update |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/renderer/src/canvas/boards/FileBoard.tsx:264-282` |
| **Discovery slice** | R-FILETREE (run 1) |

## Summary
doSave() writes the in-memory buffer (textRef.current) back to disk unconditionally via window.api.file.writeText, with no check that the on-disk file is still the version that was loaded. FileBoard never reloads on an external change: it does NOT subscribe to file:treeEvent for its own path (no onTreeEvent anywhere in FileBoard; savedText is set only at initial load and after a successful save), and the writeText IPC takes no expected-mtime and performs no conflict check (fileIpc.ts:146-155 just does write-file-atomic(abs, text)). So if the file is modified on disk after the board loads it, those changes are silently clobbered on the next Ctrl+S. This is amplified by the product's core use case: an AI agent running in a Terminal board edits a source file the user has open and dirty in a File board → user saves → the agent's write is lost with no warning. mtimeMs is even surfaced by file:stat but is never captured or compared.

## Trigger
Open a file in a File board and make an unsaved edit (board becomes dirty). While it is open, modify that same file externally (e.g. an agent in a Terminal board writes it, or any external editor). Press Cmd/Ctrl+S in the board. The board's stale buffer overwrites the external version; the external edit is permanently lost, and the save reports success.

## Evidence / concrete faulty path (code-grounded)
Concrete faulty path: (1) FileBoard loads foo.ts → text=savedText="v1" (FileBoard.tsx:236-237). (2) User edits in CodeMirror → text="v1+user", dirty=true (line 121); board stays live (showEditor, line 126). (3) Agent in a Terminal board (or external editor) writes foo.ts="v2-agent"; chokidar fires file:treeEvent (fileWatch.ts:80) but FileBoard never subscribes (onTreeEvent absent from FileBoard.tsx — grep shows it only in FileTree.tsx:331) → buffer stays "v1+user", savedText stays "v1". (4) Ctrl+S → onEditorKeyDown (line 375-377) → doSave: dirtyRef.current true so it proceeds → window.api.file.writeText(p,"v1+user") (line 270). (5) file:writeText handler (fileIpc.ts:152) blindly `await writeFileAtomic(abs, "v1+user", 'utf8')`, clobbering "v2-agent"; setSavedText("v1+user") (line 272), returns success → the agent's write is permanently lost with no warning. Refutation checked and failed: no mtime capture (file:stat:176 returns mtimeMs but FileBoard never reads it), no save-time re-read/conflict check, no treeEvent subscription for the board's own path.

## Verifier reasoning (why CONFIRMED; scope & severity)
Verified against source. FileBoard.doSave (FileBoard.tsx:264-282) writes the in-memory buffer back unconditionally: it only checks `!p || savingRef.current || !dirtyRef.current` then calls `window.api.file.writeText(p, snapshot)` with no version/mtime guard. The IPC handler `file:writeText` (fileIpc.ts:146-155) takes only `{path,text}` and does a blind `writeFileAtomic(abs, text, 'utf8')` — no expected-mtime, no conflict detection. FileBoard's load effect (FileBoard.tsx:170-250) reads `stat`+`readText` only once per `[path, ext]` change (deps line 250) and sets `savedText` solely at initial load (line 237) and after a successful save (line 272); `mtimeMs` returned by `file:stat` (fileIpc.ts:176) is never captured for conflict detection. Crucially, a live `file:treeEvent` channel DOES exist (MAIN chokidar watcher → renderer, fileWatch.ts:80; `change` events pass through, fileWatch.ts:68) and `FileTree.tsx:319-339` subscribes to it — but a grep over src shows `onTreeEvent` is used ONLY in FileTree, never in FileBoard. So an open, dirty File board is never told its file changed on disk and never reloads. No save-time re-stat or staleness guard exists anywhere in the save path. The trigger is fully reachable in the shipped app and is the product's explicit core workflow (CLAUDE.md: agents in Terminal boards edit source files the user has open). Severity affirmed at Medium rather than escalated because it requires a specific concurrent interleaving (file open + unsaved edit + external write + save) — a narrow window, not an every-save loss — but the data lost is unrecoverable source edits with no warning and a false success report. In scope: a correctness/data-integrity defect, not a perf/a11y/styling/UX item.

## Fix direction (audit only — NOT applied)
Capture mtimeMs at load (file:stat already returns it). On save, re-stat and compare; if the on-disk mtime changed since load, surface a conflict prompt (overwrite / reload / diff) instead of a blind overwrite. Optionally subscribe the open board to file:treeEvent for its own path to offer a live reload.

## Files this card touches
- `src/renderer/src/canvas/boards/FileBoard.tsx (doSave 264-282; load effect 170-250)`
- `src/main/fileIpc.ts (file:writeText 146-155; file:stat returns mtimeMs)`

## Collision flags (sequence with)
- fileIpc.ts also read by the unconfirmed file:writeText-coercion candidate (no confirmed collision)

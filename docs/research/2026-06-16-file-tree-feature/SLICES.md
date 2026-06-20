# File-Tree Epic — Umbrella & Slice Coordination

**Umbrella branch:** `feat/file-tree` (integration target — slices PR into THIS, not `main`).
**Spec:** `KICKOFF.md` (same folder). **Schema:** v11 → **v12** (owned by S1).
**Editor:** CodeMirror 6 (not Monaco — CSP-forced; KICKOFF §3).

## How this epic runs

```
main ──┐
       └─ feat/file-tree (umbrella) ◄── PR ── feat/file-tree-s1-foundation
                         ◄── PR ── feat/file-tree-s2-tree-panel
                         ◄── PR ── feat/file-tree-s3-file-board
                         ◄── PR ── feat/file-tree-s4-planning-ref
                         ◄── PR ── feat/file-tree-s5-mcp-context
       ◄── PR (umbrella → main, full e2e matrix + user eyeball) ── when all 5 land
```

1. Each slice runs in **its own worktree** off the umbrella (`.claude/tools/new-worktree.ps1`), one
   session per worktree.
2. Slice opens a PR with **base = `feat/file-tree`**, title `[file-tree Sx] <title>`, and a body that
   copies that slice's **"What it is / Changed / Eyeball / Out of scope / Acceptance"** block below.
3. **User eyeballs** the slice (the dev build + the steps in its Eyeball block). Nothing merges
   without that.
4. On approval → **squash-merge** into the umbrella. Later slices `git rebase feat/file-tree`.
5. When all 5 are in + the **full e2e matrix** is green on the umbrella → open the **umbrella → main**
   PR (user eyeballs the whole feature once more) → merge.

**Develop in parallel, eyeball/merge in order.** S1 first. Then **S2 ∥ S3**. Then S4. Then S5.

**Per-slice gate before requesting eyeball:** `pnpm typecheck && pnpm lint && pnpm format:check` +
slice-scoped `pnpm test:e2e` (Windows leg) + the manual dev check. The **full** matrix
(`pnpm test:e2e:matrix`) is paid once, at the umbrella → main PR.

## Status board

| Slice | Branch | State | PR | Eyeballed |
|---|---|---|---|---|
| S1 Foundation | `feat/file-tree-s1-foundation` | ✅ MERGED (#178, squash `4e5198da`) | #178 | ✅ |
| S2 Tree panel | `feat/file-tree-s2-tree-panel` | ✅ MERGED (#180, squash `7102f392`) | #180 | ✅ |
| S3 File board | `feat/file-tree-s3-file-board` | ✅ MERGED (#179, squash `914c4e91`) | #179 | ✅ |
| S4 Planning ref | `feat/file-tree-s4-planning-ref` | ✅ MERGED (#193, squash `9a1f8138`) | #193 | ✅ |
| S5 MCP context | `feat/file-tree-s5-mcp-context` | ✅ MERGED (#198, squash `42b8907c`) | #198 | ✅ |

**✅ ALL 5 SLICES MERGED.** Umbrella reconciled with `origin/main` (merge `5e05d0b9`, incl. PA-3/4/7/8/10
+ Agent-Orchestration Onboarding #192). Gate green: 2724 unit / 1 skip · full e2e (Win) 162 pass / 1
flaky (placement, real-OS-input — passes on retry). **Next = the umbrella → `main` PR** (run the FULL
e2e matrix incl. the Linux leg at that gate; user eyeballs the whole feature once more).

---

# Slice charters + EYEBALL guides

> Every slice: read `CLAUDE.md`, `KICKOFF.md`, this file, and `ACTIVE-WORK.md` first. Stay in your
> owned files. Match `design-reference/` tokens. End runnable + gate-green.

## S1 — Foundation (containment + fs IPC + v12 schema + contracts)

**What it is (plain English):** The plumbing every other slice stands on. It (a) lets MAIN read/
write/list files *safely confined to the project folder*, (b) bumps the save format to v12 so a
"File board" and a Planning "file reference" can exist, and (c) ships harmless **placeholders** for
those two so the app compiles and the later UI slices just swap them in. **No visible feature yet —
this is the security + contract slice, so review it the hardest.**

**Owns / changes:**
- `src/main/pathSafe.ts` + `pathSafe.test.ts` — `resolveWithinRoot` / `realResolveWithinRoot`
  (KICKOFF §4: lexical boundary + realpath; reject absolute / `C:foo` drive-relative / UNC / `\\?\` /
  reserved names / ADS / trailing-dot / NUL).
- `src/main/fileIpc.ts` — `file:readText | writeText | listDir | stat` handlers; **every** one calls
  `ipcGuard.checkSender` then `realResolveWithinRoot(root, rel)`; writes via `write-file-atomic`;
  `listDir` does NOT follow symlinked subdirs.
- `src/preload/index.ts` + `index.d.ts` — full typed `api.file.*` surface **including
  `onTreeEvent`** (S2 emits it; the channel/types are defined here so the preload has one owner).
- Schema **v12**: `boardSchema.ts` (`'file'` board type + `'fileref'` element kind — unions,
  `createBoard`/`assertBoard`/`assertPlanningElement` cases, defaults, migration v11→v12),
  `boardSchemaVersion.ts` (11→12, both consts), `projectStore.ts` mirror (11→12),
  `canvasStore.ts` (`PATCHABLE_KEYS.file` + `openFileBoard(relPath)` action).
- **Placeholders:** `FileBoard.tsx` (shows filename + "viewer in S3"), a minimal fileref render in
  the planning layer, and the `BoardNode.tsx` dispatch case. A dock "File" entry to create a
  placeholder file board (so the type is reachable; S2/S3 refine).

**Contract it publishes (do not change signatures lightly after S1 merges):** `window.api.file`
shape; `openFileBoard(relPath: string)`; the `'file'` board + `'fileref'` element schema; the
`file:treeEvent` payload; DnD MIME `application/x-canvas-ade-fileref`.

**EYEBALL (how to check it's right):**
1. `pnpm typecheck && pnpm lint && pnpm format:check` — green.
2. `pnpm test:e2e --grep @file` (and `pnpm vitest run pathSafe`) — **read the pathSafe test output**:
   confirm the REJECT list (../, `C:\…`, **`C:foo`**, `\\srv\x`, `\\?\…`, `CON`, `nul.txt`,
   `x.txt:ads`, `secret.txt.`, NUL byte, prefix-collision sibling, in-root symlink→outside) and the
   ACCEPT list (`README.md`, `src/a.ts`, ``/`.` = root, `a/b/../c.txt`, names with spaces).
3. **Code review the security core:** open `pathSafe.ts` — two layers present? `fileIpc.ts` — does
   *every* handler `checkSender` + `realResolveWithinRoot`? No raw `ipcRenderer`/`fs` exposed in
   preload?
4. `CANVAS_DEV_TITLE='PR#NNN file-tree S1'; pnpm dev` → open a project → dock "File" → a **placeholder
   File board** appears showing a filename + "viewer in S3" → save & reopen the project → it persists
   (v12 round-trips). No regressions to existing boards.

**Out of scope:** the real tree, the real editor, real DnD, MCP. Those are S2–S5.

**Acceptance:** gate green; pathSafe matrix complete & passing; CSP unchanged; security model intact
(MAIN-only fs, sender-guarded, root-confined); v12 saves load in v12 and old v11 docs migrate.

---

## S2 — Docked tree panel + live watch + drag-source

**What it is:** The file browser. A slim panel docked to the window edge (auto-hide like the Dock)
showing the project's folder tree; it updates live when files change on disk; clicking a file opens
it as a File board; tree rows can be dragged (the drop side is S4).

**Owns / changes:** `SidePanel.tsx`, a virtualized `FileTree` (react-arborist recommended), wire into
`Canvas.tsx`/`AppChrome.tsx`; `src/main/fileWatch.ts` (chokidar v4 — `awaitWriteFinish` +
`atomic:true`; ignore `.git`/`node_modules`/`canvas.json.bak`) emitting `file:treeEvent`; tree rows
`draggable` with the `application/x-canvas-ade-fileref` payload; row click → `openFileBoard(relPath)`.

**EYEBALL:**
1. `CANVAS_DEV_TITLE='PR#NNN file-tree S2'; pnpm dev` → open a project folder.
2. The **tree panel reveals** on hover at the edge (auto-hide). Expand/collapse folders — children
   **lazy-load** (not eager-walked).
3. In an external editor/Explorer: **create, rename, delete** a file in the project → the tree
   **reflects it within ~1–2s** (chokidar). Save a file → no flicker/duplication (atomic option).
4. **Click a file** → a File board opens (placeholder text until S3 is merged; real content after).
5. **Start dragging** a row → a drag image appears (dropping onto Planning is verified in S4).
6. Open a large folder; scrolling stays smooth (virtualized).

**Out of scope:** editor content (S3), the drop/chip (S4).

**Acceptance:** gate green; tree correct & live; no fs access outside MAIN; lazy + virtualized; click
opens via the S1 `openFileBoard` contract.

---

## S3 — File board (CodeMirror 6 viewer/editor)

**What it is:** Replaces the S1 placeholder with the real on-canvas file viewer/editor using
CodeMirror 6 — readable & crisp at any zoom, editable on click, save to disk.

**Owns / changes:** `FileBoard.tsx` (CM6); editor deps in `package.json`; CM6 theme from
`index.css` tokens. Render strategy (KICKOFF §3): **static highlighted snapshot** when not focused /
zoomed out; **live editor counter-scaled to 1×** on edit-intent; dirty indicator + ⌘S save via
`api.file.writeText`; image files → `<img>`; large files → "open externally" guard. Apply
`nowheel`/`nodrag` (+`nopan` if needed); confirm `panOnScroll` off.

**EYEBALL (best after S2 is on the umbrella so you can open files from the tree; otherwise use
`pnpm test:e2e --grep @file`):**
1. `CANVAS_DEV_TITLE='PR#NNN file-tree S3'; pnpm dev` → open a project → open a **code file**.
2. Content shows **syntax-highlighted and crisp** at several zoom levels (zoom in/out — no blur on
   the snapshot).
3. **Click into the editor** → caret lands where you click (no ~2-line offset); selection works.
4. **Type an edit** → a **dirty dot** appears → **⌘S** → confirm the file changed on disk (external
   editor) → reopen → persisted.
5. Open an **image** file → renders as an image, not code. Open a **very large** file → the guard
   shows instead of hanging.
6. **Open DevTools console → NO CSP / `unsafe-eval` errors** (this is the whole reason we use CM6).

**Out of scope:** tree (S2), planning chip (S4), agent context (S5).

**Acceptance:** gate green; crisp read + working edit/save; CSP clean (no eval/blob); multiple File
boards coexist without slowdown.

---

## S4 — Planning file-reference element + DnD drop

**What it is:** Drag a file from the tree and drop it on a **Planning board** to leave a **chip**
(icon + filename + relative path). Click the chip to open the file as a File board. The chip behaves
like other whiteboard elements (move/select/erase) and persists.

**Owns / changes:** `FileRefCard.tsx`; `elements.ts` `makeFileRef`; the Planning **drop handler**
(mirror `usePlanningImageIO`: accept MIME `application/x-canvas-ade-fileref`, JSON-parse, place via
`screenToFlowPosition`); render `'fileref'` elements; click → `openFileBoard`.

**EYEBALL (after S2 + S3 are on the umbrella):**
1. `CANVAS_DEV_TITLE='PR#NNN file-tree S4'; pnpm dev` → open a project → add/locate a Planning board.
2. **Drag a file from the tree → drop on the Planning board** → a **chip** appears **at the drop
   point** (icon by extension + filename bold + relative path muted).
3. **Click the chip** → the File board for that file opens.
4. **Move / select / erase** the chip like a note — behaves consistently with other elements.
5. **Save & reload** the project → the chip persists at its position.

**Out of scope:** agent context (S5).

**Acceptance:** gate green; drop lands at the cursor; chip persists (v12); click opens via
`openFileBoard`; no element-store regressions.

---

## S5 — Agent-context wiring (MCP)

**What it is:** Make file references / open File boards available to the terminal/MCP agent as
**context** (so you can point an agent at a file you've referenced). Prefer exposing them as an **MCP
resource the agent reads** — do NOT inject file contents into the PTY write channel.

**Owns / changes:** `src/main/boardRegistry.ts`, `src/main/mcp.ts` — expose file boards + fileref
elements (path + optional snippet) as agent-readable context; keep the **PTY-write invariant**
(Browser-board content never reaches the PTY; file refs are trusted-user input).

**EYEBALL:**
1. `CANVAS_DEV_TITLE='PR#NNN file-tree S5'; pnpm dev` → open a project; have a Terminal board running
   a claude (MCP-connected) agent; drop a file reference on a Planning board.
2. Ask the agent what context/resources it can see → the **referenced file (and/or open File boards)
   appears** as available context.
3. Ask it to read the referenced file → it accesses the content **via MCP** (not because the file
   text was typed into the terminal).
4. **Confirm the invariant:** Browser-board content still never reaches the PTY write channel.

**Out of scope:** nothing further — this closes the epic.

**Acceptance:** gate green; context exposed via MCP resource; PTY-write invariant intact; no security
regression.

---

# Handoff prompts (copy-paste to start a slice session)

> Paste one of these into a fresh session in a NEW worktree off `feat/file-tree`. Replace `PR#NNN`
> with the real PR number once opened.

**S1:**
```
Implement slice S1 of the file-tree epic. Read CLAUDE.md, docs/research/2026-06-16-file-tree-feature/KICKOFF.md
and SLICES.md, and .claude/coordination/ACTIVE-WORK.md first. Create a worktree off the umbrella
feat/file-tree (.claude/tools/new-worktree.ps1) on branch feat/file-tree-s1-foundation. Build ONLY
S1 per the SLICES.md "S1" charter: pathSafe.ts (+ full reject/accept test matrix), fileIpc.ts
(sender-guarded, root-confined, write-file-atomic), the full api.file.* preload surface incl
onTreeEvent, schema v12 (file board + fileref element + migration, lock-step renderer+main), the
openFileBoard store action + PATCHABLE_KEYS, and harmless placeholders for FileBoard + fileref +
BoardNode dispatch + a dock "File" entry. Do NOT build the real tree/editor/DnD/MCP. Match design
tokens. Run the gate (typecheck/lint/format) + pathSafe unit tests + a manual dev check
(CANVAS_DEV_TITLE='PR#NNN file-tree S1'). Open a PR with base feat/file-tree, title "[file-tree S1]
Foundation: containment + fs IPC + v12 schema + contracts", and paste the S1 Eyeball/Acceptance block
into the PR body. Do not merge — I eyeball first.
```

**S2:**
```
Implement slice S2 of the file-tree epic (umbrella feat/file-tree; S1 must be merged first). Read
CLAUDE.md, KICKOFF.md, SLICES.md, ACTIVE-WORK.md. New worktree off feat/file-tree on branch
feat/file-tree-s2-tree-panel. Build ONLY S2 per the SLICES.md "S2" charter: docked auto-hide
SidePanel + virtualized FileTree (react-arborist) using api.file.listDir lazily; fileWatch.ts
(chokidar v4, awaitWriteFinish + atomic:true) emitting file:treeEvent; draggable rows with the
application/x-canvas-ade-fileref payload; row click → openFileBoard. Use only S1's published
contracts; add no schema. Match design tokens. Gate + scoped e2e + manual dev check
(CANVAS_DEV_TITLE='PR#NNN file-tree S2'). PR base feat/file-tree, title "[file-tree S2] Docked tree
panel + live watch + drag-source", paste the S2 Eyeball/Acceptance block. Do not merge — I eyeball.
```

**S3:**
```
Implement slice S3 of the file-tree epic (umbrella feat/file-tree; needs S1). Read CLAUDE.md,
KICKOFF.md, SLICES.md, ACTIVE-WORK.md. New worktree off feat/file-tree on branch
feat/file-tree-s3-file-board. Build ONLY S3 per the SLICES.md "S3" charter: replace the placeholder
FileBoard with CodeMirror 6 — static highlighted snapshot when read-only/zoomed-out, live editor
counter-scaled to 1x on edit-intent, dirty + Cmd/Ctrl+S save via api.file.writeText, image + large-
file handling, theme from index.css tokens, nowheel/nodrag(/nopan). NOTE: editor is CodeMirror 6, NOT
Monaco (CSP — KICKOFF §3); confirm zero CSP/unsafe-eval console errors. Use S1 contracts; add no
schema. Gate + scoped e2e + manual dev check (CANVAS_DEV_TITLE='PR#NNN file-tree S3'). PR base
feat/file-tree, title "[file-tree S3] File board — CodeMirror 6 viewer/editor", paste the S3
Eyeball/Acceptance block. Do not merge — I eyeball.
```

**S4:**
```
Implement slice S4 of the file-tree epic (umbrella feat/file-tree; needs S1 + S3). Read CLAUDE.md,
KICKOFF.md, SLICES.md, ACTIVE-WORK.md. New worktree off feat/file-tree on branch
feat/file-tree-s4-planning-ref. Build ONLY S4 per the SLICES.md "S4" charter: FileRefCard.tsx,
makeFileRef in elements.ts, a Planning drop handler (mirror usePlanningImageIO; accept MIME
application/x-canvas-ade-fileref; place via screenToFlowPosition), render fileref elements, click →
openFileBoard. Use S1 contracts + the S1 fileref schema; add no schema. Match design tokens. Gate +
scoped e2e + manual dev check (CANVAS_DEV_TITLE='PR#NNN file-tree S4'). PR base feat/file-tree, title
"[file-tree S4] Planning file-reference element + DnD", paste the S4 Eyeball/Acceptance block. Do not
merge — I eyeball.
```

**S5:**
```
Implement slice S5 of the file-tree epic (umbrella feat/file-tree; needs S3 + S4). Read CLAUDE.md,
KICKOFF.md, SLICES.md, ACTIVE-WORK.md. New worktree off feat/file-tree on branch
feat/file-tree-s5-mcp-context. Build ONLY S5 per the SLICES.md "S5" charter: expose file boards +
fileref elements as MCP agent context via boardRegistry.ts + mcp.ts — prefer an MCP resource the
agent READS; never inject file contents into the PTY write channel; preserve the invariant that
Browser-board content never reaches the PTY. Use S1 contracts; add no schema. Gate + scoped e2e +
manual dev check (CANVAS_DEV_TITLE='PR#NNN file-tree S5'). PR base feat/file-tree, title "[file-tree
S5] Agent-context wiring (MCP)", paste the S5 Eyeball/Acceptance block. Do not merge — I eyeball.
```

# Kickoff — File Tree + File Viewer/Editor + Planning File-References

**Status:** DRAFT spec (research complete, pre-implementation). Uncommitted on `main` — move to a
`feat/file-tree` worktree when build starts (feature work never lands on `main`; see CLAUDE.md ›
Parallel sessions). **Needs one sign-off:** the editor-engine change (Monaco → CodeMirror 6, §3).
**Date:** 2026-06-16. **Schema impact:** v11 → **v12** (breaking; floor 11 → 12).

---

## 1. Goal & scope

Let the user **see / read / edit project files** and **drag a file onto a Planning board as a
reference** — without turning Canvas ADE into an IDE. Lightweight, calm, on-canvas.

**Locked product decisions** (from 2026-06-16 sign-off):
- **Surface:** a **docked side-panel file tree** (window chrome) that, on open, **spawns a File
  *board*** on the canvas (a React Flow custom node). Both — tree to browse, boards to view/edit.
- **Scope:** **project folder only** — every fs op confined to the canvas project root.
- **Editor:** ~~Monaco~~ → **CodeMirror 6** (see §3 — CSP-forced change, needs sign-off).
- **Planning integration:** drag a file from the tree onto a Planning board → a **clickable chip**
  (icon + filename + relative path) that (a) opens the file as a File board on click, and (b) can be
  handed to the terminal / MCP agent as **context**.

**Explicit non-goals:** no IntelliSense/LSP, no multi-file search, no debugger, no SCM gutter, no
opening files outside the project root, no arbitrary-filesystem browser.

---

## 2. Architecture at a glance

```
┌──────────────────────────── RENDERER (sandboxed) ────────────────────────────┐
│  SidePanel (docked, auto-hide)        Canvas (React Flow)                       │
│   └─ FileTree (virtualized)            ├─ FileBoard node  (CodeMirror 6)        │
│        • window.api.file.listDir()     ├─ Planning board                        │
│        • drag source (dataTransfer)    │    └─ FileRefCard element ("chip")      │
│        • click → spawn File board      └─ drop target → screenToFlowPosition()  │
└───────────────────────────────────────────────────────────────────────────────┘
                 │ contextBridge (typed, one method per channel)
                 ▼
┌──────────────────────────────── MAIN (Node) ─────────────────────────────────┐
│  fileIpc.ts        ipcMain.handle('file:readText'|'writeText'|'listDir'|'stat') │
│    • ipcGuard.checkSender on EVERY handler                                       │
│    • pathSafe.realResolveWithinRoot(projectRoot, rel)  ← SECURITY CORE          │
│    • write-file-atomic for writes                                                │
│  fileWatch.ts      chokidar(root) → 'file:treeEvent' (add/change/unlink)        │
│  boardRegistry/mcp expose file boards + fileref elements as agent context       │
└───────────────────────────────────────────────────────────────────────────────┘
```

Everything fs-touching stays in MAIN behind frame-guarded IPC. The renderer only ever sends a
**relative** path; MAIN re-resolves it against the realpath'd root and re-validates. (CLAUDE.md
security model unchanged: contextIsolation/sandbox/thin-preload all preserved.)

---

## 3. Editor engine — Monaco → **CodeMirror 6** (SIGN-OFF NEEDED)

**Why the change.** The locked CSP (`script-src 'self'`, no `eval`, no `blob:`) is a **hard wall for
Monaco**: Monaco's workers require `'unsafe-eval'` ([monaco #2488](https://github.com/microsoft/monaco-editor/issues/2488))
and usually `worker-src blob:` — relaxations CLAUDE.md forbids. Keycloak ([#32901](https://github.com/keycloak/keycloak/issues/32901))
and Payload ([#10229](https://github.com/payloadcms/payload/issues/10229)) hit exactly this and
dropped/avoided Monaco. CodeMirror 6 runs cleanly under `script-src 'self'` (no eval, no script
workers), is 25–100× smaller, has no cross-instance global-state conflict (the Sourcegraph
Monaco→CM6 migration pain), and themes via plain CSS (drops into our `index.css` tokens). The only
CM6 CSP wrinkle is **`style-src`** (it injects `<style>`) — handle with nonce/hash *if/when* we
harden `style-src`; it does **not** force any `script-src` relaxation.

**Editor packages:** `codemirror` + `@codemirror/*` (state/view/lang-*), wrapper
`@uiw/react-codemirror` (actively maintained) OR a thin `useEffect` mount of `EditorView` directly.
No worker wiring, no `MonacoEnvironment`, no `?worker` — "it just bundles."

**The canvas-transform blur (affects ANY editor).** React Flow applies a **non-integer** transform
to `.react-flow__viewport`, blurring overflow-heavy nodes on non-retina displays
([xyflow #3282](https://github.com/xyflow/xyflow/issues/3282)); and **no DOM editor hit-tests
correctly under live `transform: scale`** — it's a browser `getClientRects` limitation, stated
plainly by CM6's maintainer ([discuss.codemirror.net](https://discuss.codemirror.net/t/apply-scale-to-codemirror/942))
and open in Monaco ([#4468](https://github.com/microsoft/monaco-editor/issues/4468)). So the fix is
**architectural, editor-agnostic**:
1. **Read/zoomed-out state = static highlighted snapshot** (CM6 Lezer highlighter → static HTML, no
   live `EditorView`). Crisp at any zoom, zero hit-testing.
2. **Edit-intent (focus) = mount a live editor counter-scaled to 1×** inside the node (apply the
   inverse of RF zoom to the editor wrapper) so the browser never hit-tests through a non-integer
   scale.
3. **Frame crispness** = the #3282 integer-snap on the RF viewport translate (ties into the existing
   2026-06-15 "device-pixel-snap RF viewport translate" crispness item — coordinate, don't duplicate).

> If you reject the switch, the alternative is relaxing the CSP for Monaco — which breaks a locked
> invariant. The recommendation is **CodeMirror 6**.

---

## 4. Security core — project-root containment (the highest-risk piece)

Two layers, both required (skipping either has produced real CVEs: node-static CVE-2023-26111 for
the lexical layer; @tinacms/graphql CVE-2026-34604 + MCP-filesystem CVE-2025-53109 for the symlink
layer):

1. **Lexical** — treat renderer input as **relative-only**; reject absolute/drive-relative/UNC/device
   forms up front; `path.resolve(root, rel)` then a **boundary predicate** (`=== root` OR
   `startsWith(root + path.sep)`; `path.relative`-based equivalent preferred on Windows).
2. **Physical** — `fs.realpath` the result (root realpath'd once at startup) and re-assert the
   boundary, to defeat **symlinks/junctions**. For writes, realpath the **parent** (target may not
   exist yet). `readdir` must **not** follow symlinked subdirs (Node recursive readdir does —
   [nodejs/node#51858](https://github.com/nodejs/node/issues/51858)).

**Windows-specific rejects** (primary OS; root `Z:\Canvas ADE` has a space — spaces are fine, not a
threat): drive-letter (`C:\`), **drive-relative `C:foo` — `path.isAbsolute` returns FALSE for it, so
an explicit `/^[A-Za-z]:/` regex is mandatory**, UNC (`\\srv\share`), extended/device (`\\?\`,
`\\.\` — these *disable* OS path parsing), 8.3 short names (realpath collapses them), reserved device
names (`CON/NUL/COM1/LPT1…`, incl. `NUL.txt`), alternate data streams (any `:` in a component),
trailing dot/space (Windows strips them). Plus: NUL byte → reject; `%` (expect already-decoded
input) → reject.

**Helper to implement** (`src/main/pathSafe.ts`), per the research (drop the buggy placeholder line
from the agent's draft — the load-bearing order is: NUL/encoding → absolute/drive/UNC/device →
per-component reserved/ADS/trailing → lexical boundary → realpath boundary):

```ts
export function resolveWithinRoot(rootAbs: string, userPath: string): string   // throws on escape (lexical)
export async function realResolveWithinRoot(rootAbs: string, userPath: string): Promise<string>  // + realpath layer
```

Each `file:*` MAIN handler: `ipcGuard.checkSender` → `await realResolveWithinRoot(root, rel)` → one
`fs` op (renderer never picks the op or passes flags). Writes via `write-file-atomic` (note:
emits a delete/recreate the watcher must tolerate — see §5).

**Residual TOCTOU** (check-then-use symlink swap) is **acceptable for this single-user desktop threat
model** — there's no portable `openat`/per-component `O_NOFOLLOW` in Node. Document it; `O_NOFOLLOW`
the final write open on POSIX to shrink the window.

**Unit-test checklist** (drive `pathSafe.test.ts`):
- REJECT: `../etc/passwd`, `a/../../b`, `/etc/passwd`, `C:\Windows\win.ini`, **`C:foo`**, `\\srv\x`,
  `\\?\C:\x`, `foo\0.txt`, `%2e%2e/x`, `CON`, `nul.txt`, `secret.txt:ads`, `secret.txt.`, a
  prefix-collision sibling (`Z:\Canvas ADE-evil\x`), and an in-root symlink/junction → outside.
- ACCEPT: `notes.md`, `src/index.ts`, `` and `.` (= root), `a/b/../c.txt`, `My File.txt` (spaces),
  mixed slashes `src/sub\file.txt`, case variants of a real in-root path on Windows.

---

## 5. File watching

**chokidar v4** (native-dep-free → no rebuild pain on the spaced path; actively maintained). Watch
the project root; emit `add`/`change`/`unlink` to the renderer over `file:treeEvent`. **Must set:**
- `awaitWriteFinish` — don't fire mid-save.
- `atomic: true` — collapse the delete/recreate that **our own `write-file-atomic` produces** into a
  single `change` (else every save flickers as unlink+add).
- ignore: `.git/`, `node_modules/`, `canvas.json.bak`, large/binary as needed.

Debounce tree refreshes in the renderer; the tree reads via `file:listDir` lazily per expanded
folder (don't eager-walk a huge repo).

---

## 6. Schema changes (v11 → v12, breaking)

Two new persisted kinds → **breaking** bump: `SCHEMA_VERSION 11→12` **and**
`MIN_READER_VERSION 11→12` (lock-step in both `src/renderer/src/lib/boardSchemaVersion.ts` and
`src/main/projectStore.ts`).

- **New board type** `'file'`: `BoardType` union + `Board` union (`boardSchema.ts:70,238`),
  `DEFAULT_BOARD_SIZE`/`DEFAULT_TITLE`, `createBoard()` (`:382`), `assertBoard()` (`:707`),
  `PATCHABLE_KEYS.file` (`canvasStore.ts`). `FileBoard` fields: `{ path: string (relative),
  readOnly?: boolean, ... }` — content is NOT persisted (read live from disk; respect scene/session
  split).
- **New Planning element kind** `'fileref'`: `FileRefElement` interface alongside the other element
  kinds (`boardSchema.ts:135–232`), `PlanningElement` union, `assertPlanningElement()` case,
  `makeFileRef()` factory (`elements.ts`). Fields: `{ kind:'fileref', id, x, y, path (relative),
  label, ... }`.
- **Migration v11→v12**: identity (no existing docs have file boards/refs). Mirror the v10→v11
  diagram precedent (`boardSchema.ts:464–497`).

> **Bump coordination (parallel-session hazard):** the **foundation slice S1 owns the ENTIRE v12
> schema** — it adds *both* the `'file'` board type *and* the `'fileref'` planning element kind
> (types, validators, migration, PATCHABLE_KEYS) up front, even though their UI lands later in S3/S4.
> S2–S5 then add **zero schema** and build against a stable v12. This removes the "who bumps the
> version" race entirely (cf. the planning epic "schema v6 now TAKEN → rebase to v7" gotcha).

---

## 7. Wireframes

**Side panel + File board** (tree is docked chrome; opening spawns a board on the canvas):
```
┌─────┬──────────────────────── canvas (React Flow) ─────────────────────────┐
│Files│                                                                        │
│ ▾ src/      ┌─ src/auth.ts ─────────── File ─┐   ┌─ Planning ────────────┐  │
│   auth.ts   │ 1  export function login(){    │   │  note   ◇─arrow─◇      │  │
│   app.tsx   │ 2    ...                        │   │  ┌──────────────────┐ │  │
│ ▸ docs/     │ 3  }                            │   │  │ 📄 auth.ts        │ │  │
│   readme.md │     [● unsaved]  ⌘S save        │   │  │ src/auth.ts       │ │  │
│             └────────────────────────────────┘   │  └──────────────────┘ │  │
│ (auto-hide, ← drag a tree row onto Planning →     └───────────────────────┘  │
│  like Dock)   to drop a file-reference chip)                                  │
└─────┴───────────────────────────────────────────────────────────────────────┘
```

**File board states:** (a) read-only / zoomed-out → static highlighted snapshot (crisp at any zoom);
(b) focused/editing → live CodeMirror at 1× (counter-scaled), dirty dot + ⌘S; (c) image file → render
`<img>`, not the editor; (d) too-large file → "open externally" affordance.

**File-reference chip (Planning element):** icon (by extension) + filename (bold) + relative path
(muted). Click → open File board. ⋯-menu / drag handle like other planning elements. Selected/erase
behavior via `usePlanningPointer` hit-testing.

---

## 8. Build sequence — 5 file-disjoint slices

| Slice | Title | Depends on | Owns (primary files) |
|---|---|---|---|
| **S1** | **Foundation: containment + fs IPC + v12 schema + contracts** | — | `src/main/pathSafe.ts`(+`.test.ts`), `src/main/fileIpc.ts`, `src/preload/index.ts`+`index.d.ts` (full `api.file.*` incl. `onTreeEvent`), schema v12 in `boardSchema.ts`/`boardSchemaVersion.ts`/`projectStore.ts` (file board **and** fileref element), `canvasStore.ts` (`openFileBoard` action + PATCHABLE_KEYS), **placeholder** `FileBoard.tsx` + fileref render + `BoardNode.tsx` dispatch |
| **S2** | **Docked tree panel + live watch + drag-source** | S1 | `src/renderer/.../canvas/SidePanel.tsx`, `FileTree` (virtualized — react-arborist or react-window), `src/main/fileWatch.ts` (chokidar v4 emits `file:treeEvent`), wire into `Canvas.tsx`/`AppChrome.tsx`; tree rows draggable + click calls `openFileBoard` |
| **S3** | **File board — CodeMirror 6 viewer/editor** | S1 | replace placeholder `FileBoard.tsx` with CM6 (static snapshot vs counter-scaled live editor, dirty+save, image/large-file handling, token theme); editor deps in `package.json` |
| **S4** | **Planning file-ref element + DnD drop** | S1, S3 | **new** `FileRefCard.tsx`, `elements.ts` (`makeFileRef`), planning drop handler (mirror `usePlanningImageIO`, MIME `application/x-canvas-ade-fileref`, `screenToFlowPosition`), click chip calls `openFileBoard` |
| **S5** | **Agent-context wiring (MCP)** | S3, S4 | `src/main/boardRegistry.ts`, `src/main/mcp.ts` — expose file boards + fileref elements as agent context (prefer an MCP **resource** the agent reads, not PTY injection); preserve the **PTY-write invariant** |

**Develop in parallel, eyeball/merge in order.** S1 lands first (it defines every contract). Then
**S2 + S3** can be built simultaneously (disjoint files, both depend only on S1's contracts); **S4**
after S3; **S5** last. The umbrella is the serialization point — later slices rebase onto it as
earlier ones merge. Each slice ends runnable + gate-green; per-slice manual dev check
(`CANVAS_DEV_TITLE='PR#NNN file-tree Sx'`). Full e2e matrix runs once at the umbrella → main PR.

---

## 9. React Flow / DnD implementation notes (from research)

- **File board = plain React component** in `nodeTypes` (dispatched inside `BoardNode.tsx`). Apply
  **`nowheel`** on the editor scroll container and **`nodrag`** on the editor; verify `panOnScroll`
  is off (it overrides `nowheel`); in v12 `nodrag` no longer blocks selection → add **`nopan`** if
  needed. Sources: [RF utility classes](https://reactflow.dev/learn/customization/utility-classes),
  [custom nodes](https://reactflow.dev/learn/customization/custom-nodes).
- **Drag tree → canvas:** native HTML5 DnD. `onDragStart` → `dataTransfer.setData('application/x-canvas-ade-fileref', JSON.stringify(payload))`
  (**setData is string-only** — an object becomes `"[object Object]"`); drop target needs
  `onDragOver` (`preventDefault` + `dropEffect='move'`) and `onDrop` (`preventDefault`, parse,
  create). Map the point with **`screenToFlowPosition({x:clientX,y:clientY})`** (v12; replaces v11
  `project()`, no `getBoundingClientRect` subtraction). Sources:
  [RF DnD example](https://reactflow.dev/examples/interaction/drag-and-drop),
  [MDN setData](https://developer.mozilla.org/en-US/docs/Web/API/DataTransfer/setData).
- **File-ref-as-context** precedent: VS Code Copilot drag-to-chat + `#`-mentions
  ([docs](https://code.visualstudio.com/docs/copilot/chat/copilot-chat-context)) — validates the UX;
  the wiring into our PTY/MCP is ours (S5).

---

## 10. Open questions / risks

1. **CSP `worker-src`** — CM6 needs no script workers, so `script-src 'self'` suffices; confirm no
   `worker-src` directive is needed. (Moot if we never add language workers.) `style-src`: CM6
   injects `<style>` — fine under current CSP; revisit if `style-src` is hardened.
2. **TOCTOU residual** (§4) — accepted for single-user model; document in the ADR.
3. **Counter-scale wrapper** (§3) is the one non-trivial integration piece — prototype it early in S3.
4. **"File ref → agent" transport** (S5): literal path injected into the PTY write line vs. an MCP
   resource/tool the agent reads. Prefer the **MCP-resource** path (cleaner, keeps the PTY channel
   for user keystrokes; aligns with the Context subsystem). Decide in S5.
5. **Tree virtualization library** — react-arborist (tree+virtualize+DnD built-in) vs react-window
   (hand-rolled tree). Pick in S2; arborist is the faster path.

**Recommend an ADR** (`docs/decisions/`) covering: the root-containment algorithm + Windows rejects +
accepted TOCTOU (the security contract), and the Monaco→CM6 decision (CSP rationale).

---

## Appendix — full research

- Deep-research report (5 angles, 24 verified claims): chat 2026-06-16 + memory `file-tree-feature-research.md`.
- Follow-up A (path-traversal containment): concrete helper + CVEs + Windows table.
- Follow-up B (Monaco vs CM6): CSP wall + transform-blur + multi-instance — recommend CM6.
- Codebase seams: §6/§8 file paths verified against current tree (schema currently **v11**).

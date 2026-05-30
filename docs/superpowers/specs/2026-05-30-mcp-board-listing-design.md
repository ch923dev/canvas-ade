# Design — MCP Phase-2 Slice 1: all-board-types `listBoards`

**Date:** 2026-05-30
**Status:** Approved (brainstorming)
**Branch:** `feat/mcp-board-listing` (worktree off `feat/mcp-main-wiring` — **stacked PR**, merges after #7)

## Purpose

Today the MCP `Orchestrator.listBoards()` returns **terminal boards only**, with `type` hardcoded
`'terminal'`. That is all MAIN can see: the complete board list (terminal/browser/planning) lives in
the renderer's Zustand store; MAIN owns only the PTY session map (and live preview views, which are
an incomplete, liveness-biased subset). This slice gives the MCP **every board, of every type**, with
a coarse status — the first MCP Phase-2 (observation) capability, and the foundation the orchestration
layer needs to reason about the whole canvas.

## Findings (the data reality)

- **Renderer Zustand (`canvasStore.ts`)** is the only complete, live board list — all types + per-type
  data. Renderer-only.
- **MAIN PTY map (`pty.ts`)** — terminal boards with a live shell. Liveness-biased.
- **MAIN PreviewManager (`preview.ts`)** — browser boards with a *live* `WebContentsView` (cap ~4);
  detached/snapshot browsers are absent. Incomplete.
- **`canvas.json` (`projectStore.ts`)** — would list all boards from disk, but it is **not on `main`**
  (unmerged `phase-3-persistence`) and lags live edits. Rejected as a source.
- **No unified board status exists.** Terminal liveness = PTY state; browser liveness = view load
  state; planning has none. The roadmap's Phase-2 buckets (idle/awaiting-review/blocked/failed) do not
  exist yet and are deferred to the Phase-5 attention slice.

Conclusion: listing all types requires a **renderer→MAIN control-plane bridge** — a minimal board
snapshot pushed into a MAIN registry the adapter reads.

## Architecture

```
useCanvasStore change → (debounced) window.api.mcp.publishBoards([{ id, type, title }])
  → preload ipcRenderer.send('mcp:boards', snapshot)
  → MAIN ipc handler (isForeignSender guard) → boardRegistry stores snapshot
  → [on MCP call] adapter reads mirror + overlays PTY status → BoardSummary[] → agent
```

The mirror is the **source of board existence**; PTY status is an **overlay** for terminal boards.

## Components

### `src/main/boardRegistry.ts` (new, MAIN)
Holds the last pushed snapshot and exposes a read accessor. Pure-testable apart from the IPC handler.
```ts
export interface BoardMirror { id: string; type: string; title: string }

/** Register the renderer→MAIN board-snapshot channel. Sender-guarded (Bug #33 pattern). */
export function registerBoardRegistryHandler(
  ipcMain: IpcMain,
  getWin: () => BrowserWindow | null
): void
/** Last snapshot the renderer pushed (empty until the renderer mounts). */
export function listBoardMirror(): BoardMirror[]
```
- `ipcMain.on('mcp:boards', (e, boards) => { if (foreign) return; validate+store })`.
- Validates each entry is `{id:string, type:string, title:string}`; drops malformed ones.

### `src/main/mcpOrchestrator.ts` (modify)
Generalize the adapter from PTY-only to mirror-backed:
```ts
export interface BoardRegistry {
  listBoards(): Array<{ id: string; type: string; title: string }>
  listSessions(): Array<{ id: string; status: string }>
}
export function buildOrchestrator(registry: BoardRegistry): Orchestrator
```
- `listBoards()` → for each mirror board, `{ id, type, title, status: deriveStatus(board, sessions) }`.
- `boardStatus(id)` → the derived status, or throws `board not found` if absent from the mirror.
- `spawnBoard`/`dispatchPrompt`/`gitDiff` remain phase-gated throws.
- Status derivation (coarse, v1):
  - `terminal` → PTY status from `listSessions` (`running`/`exited`) else `'no-session'`
  - `browser` → `'open'`
  - `planning` → `'static'`

### `src/main/mcp.ts` (modify)
Inject both sources: `buildOrchestrator({ listBoards: listBoardMirror, listSessions: listPtySessions })`.

### `src/main/index.ts` (modify)
`registerBoardRegistryHandler(ipcMain, () => mainWindow)` in `app.whenReady`.

### `src/preload/index.ts` + `index.d.ts` (modify)
Add `mcp.publishBoards(boards)` to the contextBridge `api`, sending on the single `mcp:boards`
channel. Type the arg as `Array<{ id: string; type: string; title: string }>`.

### `src/renderer/src/store/useMcpPublish.ts` (new)
A hook (mounted once in `App`) that subscribes to `useCanvasStore`'s `boards`, debounces (~150ms), maps
to `{ id, type, title }`, and calls `window.api.mcp.publishBoards`. Pushes on mount and on every change
(including an empty array when the canvas is cleared).

### `@ch923dev/canvas-ade-mcp` (package)
Extend `BoardSummary` with `title: string`. Bump `0.1.0 → 0.2.0`, republish via the `publish.yml`
flow (tag `v0.2.0`). Consumer dep → `^0.2.0`; regenerate the lockfile.

## Data shapes

```ts
// package BoardSummary (after bump)
interface BoardSummary { id: string; type: string; title: string; status: string }
```

## Error handling

- Renderer not yet mounted / no push → mirror `[]` → `listBoards` `[]` (graceful, matches a fresh boot).
- Foreign sender on `mcp:boards` → ignored (the PTY `isForeignSender` guard).
- A terminal board in the mirror with no live PTY (e.g. a restored idle terminal) → status
  `'no-session'` (honest, not a crash).
- Malformed snapshot entry → dropped during validation; the rest still register.

## Security

- Snapshot carries **only `id`/`type`/`title`** — never browser page content or planning element
  text. Keeps the MCP output cap small and does **not** widen the prompt-injection surface. Board
  titles are trusted-user content (like terminal input), consistent with "browser content never
  leaves its view" and the loopback/token model.
- The channel is renderer→MAIN `send` only, sender-guarded; no new capability is exposed to preview
  WebContentsViews (which have no preload).

## Testing (two-layer)

- **Contract** (`boardRegistry.test.ts`, `mcpOrchestrator.test.ts`): registry stores/returns + drops
  malformed entries; `buildOrchestrator` maps all three types and derives status, including the
  terminal `no-session` edge and the unknown-board `boardStatus` throw. Pure, no node-pty.
- **Live** (`CANVAS_SMOKE=mcp`): seed one terminal + one browser + one planning board on the real
  canvas (reuse the e2e seeding path), wait for the mirror to populate, then assert `listBoards`
  returns all three with the correct `type` and a sane `status`.

## Out of scope (this slice)

- Rich status buckets (idle / awaiting-review / blocked / failed) — Phase-5 attention slice.
- The `canvas://boards` MCP **resource** shape + the other Phase-2 read resources (status / output /
  result / attention) — Slice 2.
- Per-type detail fields and the board **description / summary** enrichment below.

---

## Future enrichment — board task-context & cross-board linkage (NOTED, not in this slice)

> Captured at the user's request (2026-05-30). This is the bridge from "the orchestrator can *list*
> boards" to "the orchestrator understands what each board is *for* and how they *relate*" — the
> connective tissue of the upcoming orchestration / swarm feature. **Not implemented now**; the v1
> slice above stays minimal (`id`/`type`/`title`).

Each board should eventually carry a **description of the task it is handling**, surfaced to the MCP
so every board becomes a connected node in the orchestration graph:

- **Terminal** — the task / agent it is running (partly implicit today via `title` / `launchCommand`).
- **Browser** — a description of *what it is doing* and its **linkage**: e.g. "previewing the dev
  server that terminal `<id>` is building," or "linked to board `<id>`." This lets the orchestrator
  reason about producer→preview relationships rather than seeing an isolated URL.
- **Planning** — a **separate future feature**: summarize the planning board's contents (notes,
  checklists, arrows, freehand) into a **machine-readable artifact** — e.g. a Mermaid diagram or a
  markdown document — that can be **handed off to another agent or read via the MCP**. This turns the
  whiteboard from human-only pixels into shared, queryable context the swarm can act on.

Likely shape when built: a richer snapshot field (or a dedicated resource such as
`canvas://board/{id}/description` and `canvas://board/{id}/summary`), with descriptions either
user-authored or agent-derived. Belongs with the broader Phase-2 observation resources and the
Phase-9 coordination layer (shared task graph, board↔board messaging). Tracked as a forward note in
the MCP `docs/roadmap.md` (Phase 2).

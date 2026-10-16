# Spatial Awareness — context grouping + screen-fit tidy · SPEC (contract)

**Ask (user, 2026-10-16):** give the `canvas-ade` MCP spatial awareness — group boards into the
contexts they belong to, and know the user's screen size so "tidy up" arranges the boards to fit
the screen.

This file is the **Wave-0 contract**. Every lane (L5–L11, I1–I2) builds against the types and rules
below, so the pure libraries and the package wire can be written **in parallel**. Change a contract
here first (one commit on `feat/spatial-awareness`), then tell the affected lanes.

- Plan board (Kanban, one column per wave): canvas id `b8b4c254-1a51-4709-87a1-e5e02220a8ca`
- Design artifact (wireframes, sign-off required before UI code): [`./DESIGN.md`](./DESIGN.md)
- Role-aware tidy (`mode:'roles'`) scenario catalog + wireframes (design artifact for C9/C10): [`./ROLE-LAYOUT.md`](./ROLE-LAYOUT.md)
- Baseline: desktop `main` `6138cd7b` (v0.47.6) · `@expanse-ade/mcp` `origin/main` `0212fa5` (0.25.0)
- **Wave 2 baseline** (after Wave 1 merged 2026-10-16): desktop `main` `0236048b` (v0.47.9) · `@expanse-ade/mcp` `main` `a42eac2d` (0.26.0, which adds structured error codes, exported caps and PR CI)

---

## 1. Current state (verified 2026-10-16)

| # | Gap | Evidence |
|---|---|---|
| G1 | Agent tidy sends **no screen info** — the MCP applier calls `tidyBoards(mode)` with no aspect (the UI button passes the pane aspect). | `src/renderer/src/store/useMcpCommands.ts:463` vs `src/renderer/src/canvas/hooks/useTidyTile.ts:113` |
| G2 | `smart` / `by-type` **ignore aspect** (only `grid` reads it). `smart` puts **every terminal in ONE row**, so N terminals = one ultra-wide strip. | `src/renderer/src/lib/tidyLayout.ts:156,257-265` |
| G3 | Tidy is **group-blind** — it buckets by type canvas-wide, so a Named Group's members land in different rows and group outlines balloon + overlap. | `tidyLayout.ts:128-160`, `src/renderer/src/lib/groupBoxes.ts` (`computeGroupBoxes`) |
| G4 | **No camera refit** after an agent tidy (the UI path calls `fitToBoards`; the MCP applier does not). | `useMcpCommands.ts:451-470` vs `useTidyTile.ts:114` |
| G5 | The tile presets (the only pane-aware, resize-to-fill layouts) are **UI-only**; the wire enum is `smart|by-type|grid`. | `src/renderer/src/lib/layoutPresets.ts`, pkg `src/constants.ts:301` |
| G6 | **Zero viewport/screen data** reaches MAIN — the `mcp:boards` payload carries boards/connectors/groups only. | `src/preload/mcpApi.ts:60`, `src/main/boardRegistry.ts:836` |
| G7 | **No tool groups EXISTING boards** — `spawn_group` only groups boards it creates. The store already has the full group API. | pkg `src/server/tools/spawnGroup.ts`, `src/renderer/src/store/canvasStore.ts:263-282` |
| G8 | The layout digest reports only a board's **first** group (multi-membership is allowed). | `src/main/layoutModel.ts` › `groupOf` |
| G9 | The MAIN mirror carries **no context signals** — no `cwd`, no `previewSourceId`, no `dockedIn`; preview links are folded into `previewSourceId` and never mirrored as connectors. | `src/main/boardRegistry.ts` `BoardMirror`; `canvasStore.ts:93-95` |
| G10 | **Tier gap:** `tidy_canvas`, `focus_viewport`, `canvas://layout` are orchestrator-tier only. The **connected** terminal the user talks to (and the **lead** tier) cannot tidy or read layout at all. | pkg `src/server/factory.ts` (lead block comment: "Deliberately OMITTED: … tidy_canvas/focus_viewport/app-model") |
| G11 | Agent-supplied group names are only whitespace-collapsed — no control-char / bidi strip. | `src/main/mcpLifecycle.ts:343-346` |

Anchors the design leans on: `LOD_ZOOM = 0.4` (below it boards render as placeholders,
`src/renderer/src/lib/canvasView.ts:45`) · `FIT_FRAME = { padding: '64px', maxZoom: 2 }` (`:38`) ·
`Z_MIN 0.1` / `Z_MAX 2.5` (`:14-15`) · `TIDY_GAP 28` · `MIN_BOARD_SIZE` (`boardSchema.ts`) ·
`ConfirmBatchRequest {title, items[], blurb?, disclose?}` → per-row decisions
(`src/main/mcpConfirm.ts:96`, rendered by `BatchConfirmModal.tsx`).

**No schema bump.** Groups already persist (v6). Screen/camera data is session state and is never
persisted (scene/session split).

---

## 2. Decisions

D1–D4 **decided by the user 2026-10-16** (all four recommendations accepted). D5–D6 are
coordinator calls recorded here; change them only through this file. **D7–D10 (role-aware tidy)
decided by the user 2026-10-16 (all four recommendations accepted), together with sign-off on
ROLE-LAYOUT.md §7 (S1–S15) and DESIGN.md W6/W7.** L10 may freeze its goldens; L11 builds the D10
observer. D8 (a) supersedes D3's *default* only: `fit` stays, as the fallback and the 2nd preset.

| ID | Question | Recommendation | Status |
|---|---|---|---|
| D1 | Which tiers get spatial tools? (G10) | `canvas://layout` + `canvas://contexts` → **orchestrator + lead + connected** (read-only). `tidy_canvas` + `focus_viewport` + `group_boards` + `edit_groups` → orchestrator **un-gated** for tidy/focus (today's behaviour); **lead + connected** get them **human-confirmed** (one approve/deny for tidy/focus; batch confirm for groups). Worker: none. | **DECIDED** 2026-10-16 |
| D2 | Are group writes confirm-gated? | **Yes, always** (all tiers): groups are the user's own persisted structure. One `BatchConfirmModal`, one row per proposed group, approved rows apply as **one undo step**. | **DECIDED** 2026-10-16 |
| D3 | Default tidy mode. | Agents: `tidy_canvas` default becomes **`fit`**. UI: add **"Fit to screen"** as the FIRST preset and bind `t` to it; Smart stays one click away. | **DECIDED** 2026-10-16 · default **superseded by D8 (a)**: "By role" is first + `t`, Fit to screen is 2nd |
| D4 | When everything can't be readable on one screen. | Default overflow **`report`** (arrange, refit, return `readable:false` + a hint to focus a group). `pages` / `shrink` are opt-in per call. Fit never resizes boards unless `overflow:'shrink'`. | **DECIDED** 2026-10-16 |
| D5 | Where context derivation runs. | **MAIN**, as a pure shared module over the extended mirror (the `buildLayoutDigest` pattern), so `canvas://contexts` needs no renderer round-trip. The renderer imports the same module for `fit` packing. | proposed |
| D6 | Tool surface for group edits. | **Two** tools, not four: `group_boards` (create, batch) + `edit_groups` (rename / add / remove / ungroup ops, batch). Fewer tools = clearer agent choice. | proposed (changes the plan board's "4 tools") |
| D7 | May `roles` resize boards? | **Yes, by class** (ROLE-LAYOUT §5). Flexible boards (terminal, swarm, command, dataflow) take the slot size, ≥ their role minimum. Previews keep their device aspect. Planning, kanban and file boards are **rigid and never resized**. `resize:false` keeps the role ORDER only, with positions from C4. `fit` stays position-only (D4 unchanged). | **DECIDED** 2026-10-16 (yes, by class) |
| D8 | What does "tidy up" (the agents' default and the `t` key) mean once `roles` exists? | Either (a) **`roles` becomes the default**, falling back to `fit` (position-only) when a unit has no role signal beyond plain shells; or (b) keep `fit` as the default (D3) and offer "Arrange by role" as the 2nd preset plus an explicit agent mode. Recommend **(a)**, because it is what the user asked for. | **DECIDED** 2026-10-16: **(a)**. Mechanics: an omitted `mode` (agent) or the `t` key is an **implicit** `roles` (`implicit:true`, C5/C10). Under it, a unit whose boards are all `shell` keeps its sizes (position-only, C4 in-unit packing) instead of the `peers` grid. An explicit `mode:'roles'` never falls back. The package must NOT fill a default `mode` (C6), or the host could not tell implicit from explicit |
| D9 | What role data reaches MAIN? | **Classifications only**: `agent:boolean`, port numbers and `lastFocusedAt`. Never the raw launch line, which can carry env-prefixed secrets. | **DECIDED** 2026-10-16 (yes) |
| D10 | How does an api terminal link to the browser that calls it? | Add a **loopback origin-port observer** on each preview's OSR session. It records ONLY the port of requests to `localhost`/`127.0.0.1`/`[::1]`: no paths, no bodies, no headers. It is ephemeral, never persisted, and independent of the Data-Flow capture opt-in. When it is absent, the fallbacks are Named Group > same cwd > sibling-folder heuristic (`apps/api` ↔ `apps/web`). | **DECIDED** 2026-10-16 (yes, always on) |

---

## 3. Contracts

### C1 — Mirror extension (renderer → MAIN, `mcp:boards`)  · owner L5

New single-source module **`src/shared/spatialTypes.ts`** (imported by MAIN, preload and renderer —
the `src/shared/mcpTypes.ts` precedent):

```ts
// Rect is DEFINED in spatialGeometry.ts (L7, which merges first) and re-exported here.
export type { Rect } from './spatialGeometry'

/** The user's live view of the canvas. Session state — NEVER persisted. */
export interface CanvasView {
  /** Visible canvas pane in CSS px (the React Flow pane element, not the window). */
  pane: { w: number; h: number }
  /** window.devicePixelRatio */
  dpr: number
  /** React Flow transform: world→screen is (p * zoom + {x,y}). */
  camera: { x: number; y: number; zoom: number }
  /** The world-space rect currently on screen (derived from pane + camera). */
  visibleWorld: Rect
}

/** MAIN-only enrichment from Electron's `screen` API (never sent by the renderer). */
export interface DisplayInfo {
  workArea: Rect          // the display holding the window (screen.getDisplayMatching)
  scaleFactor: number
  maximized: boolean
  fullscreen: boolean
}

/** Context signals added to each board in the snapshot (all optional, all sanitized in MAIN). */
export interface BoardContextFields {
  cwd?: string             // terminal boards only
  previewSourceId?: string // browser boards only (the terminal that drives it)
  dockedIn?: string        // a worker terminal docked in a swarm board — not canvas geometry
}
```

- Payload becomes `{ boards, connectors, groups, view? }`; each board summary may carry
  `BoardContextFields`. Legacy shapes keep working (`boardRegistry.ts` already accepts old payloads).
- **Publish cadence:** `view` rides the existing 150 ms debounce in `useMcpPublish.ts`, re-published
  on camera **settle** (React Flow `onMoveEnd`) and on pane `ResizeObserver` — never per frame.
- **MAIN sanitizes** (`boardRegistry.ts`, alongside `sanitizeGroups`): finite numbers only; `pane.w/h`
  clamped `[1, 16384]`; `zoom` clamped `[Z_MIN, Z_MAX]`; `dpr` `(0, 8]`; strings clamped
  (`cwd` ≤ 1024, ids ≤ 200). A bad `view` is dropped whole, never partially trusted.
- MAIN computes `DisplayInfo` lazily at read time (`src/main/screenInfo.ts`, new) from the main
  window. No IPC needed.

### C2 — `canvas://layout` v2  · owner L5 (host-only — no package change, the resource is `unknown`-typed)

`buildLayoutDigest` gains the view + groups and returns **version 2** (additive; every v1 field stays):

```ts
export interface LayoutDigestV2 {
  version: 2
  count: number
  bbox: Rect | null
  boards: Array<{
    id: string; type: string; x: number; y: number; w: number; h: number
    groupId?: string          // v1 field kept: FIRST group (back-compat)
    groupIds: string[]        // NEW: every group the board belongs to (G8)
    onScreen: boolean         // NEW: intersects screen.visibleWorld (false when screen is null)
  }>
  overlaps: Array<{ a: string; b: string }>
  arrangement: 'empty' | 'single' | 'row' | 'column' | 'grid' | 'scattered'
  groups: Array<{ id: string; name: string; boardIds: string[]; bbox: Rect | null }>  // NEW
  screen: (CanvasView & { display?: DisplayInfo }) | null                           // NEW
  fit: {                                                                              // NEW
    /** Zoom at which ALL placed boards fit the pane (FIT_FRAME rules); null without a view. */
    zoomToFitAll: number | null
    /** zoomToFitAll >= READABLE_ZOOM */
    readable: boolean
    readableZoom: number      // READABLE_ZOOM (= LOD_ZOOM 0.4)
  }
}
```

Shared geometry (**`src/shared/spatialGeometry.ts`**, new — used by MAIN digest AND the renderer
packer so both agree on "fits"):

```ts
export interface Rect { x: number; y: number; w: number; h: number }
export const READABLE_ZOOM = 0.4          // must equal canvasView.LOD_ZOOM (parity unit test)
export const FIT_PADDING_PX = 64          // must equal FIT_FRAME.padding (parity unit test)
export const FIT_MAX_ZOOM = 2             // must equal FIT_FRAME.maxZoom (parity unit test)
export function fitZoom(bbox: Rect, pane: { w: number; h: number }): number
// = clamp(min((pane.w - 2*FIT_PADDING_PX) / bbox.w, (pane.h - 2*FIT_PADDING_PX) / bbox.h), Z_MIN, FIT_MAX_ZOOM)
export function visibleWorld(pane: { w: number; h: number }, camera: { x: number; y: number; zoom: number }): Rect
export function rectsIntersect(a: Rect, b: Rect): boolean
```

### C3 — `deriveContexts()`  · owner L6 (pure, new file, zero shared files)

**`src/shared/deriveContexts.ts`**

```ts
export interface ContextBoardInput {
  id: string; type: string; title: string
  cwd?: string; previewSourceId?: string; dockedIn?: string
  path?: string                          // file boards
  fileRefs?: Array<{ path: string }>     // planning boards
  ports?: number[]                       // terminal: detected loopback listening ports (C9 signal, L11)
  callsPorts?: number[]                  // browser: loopback ports its page requested (D10, L11)
  sourceBoardId?: string                 // dataflow: the browser it inspects (amended 2026-10-16)
}
export interface ContextConnectorInput { sourceId: string; targetId: string; kind: 'preview' | 'orchestration' }
export interface ContextGroupInput { id: string; name: string; boardIds: string[] }
export type ContextSignal = 'group' | 'preview' | 'orchestration' | 'port' | 'dataflow' | 'cwd' | 'fileRef' | 'title'

export interface DerivedContext {
  key: string                    // stable: hash of the sorted boardIds
  suggestedName: string          // ≤ GROUP_NAME_MAX (80), sanitized
  boardIds: string[]             // sorted
  signals: ContextSignal[]       // why these belong together (no raw paths)
  confidence: 'high' | 'medium' | 'low'
  existingGroupId?: string       // set when this context IS / extends an existing Named Group
  addBoardIds?: string[]         // ungrouped boards proposed to join `existingGroupId`
}

export interface DeriveOptions {
  projectRoot?: string           // cwd equal to this carries NO signal (it's the default)
  titleSignal?: boolean          // default false (opt-in, low confidence)
  pathCase?: 'insensitive' | 'sensitive' // default 'insensitive'; MAIN sets it from the platform
}

export const MAX_CONTEXTS = 50
export function deriveContexts(
  boards: readonly ContextBoardInput[],
  connectors: readonly ContextConnectorInput[],
  groups: readonly ContextGroupInput[],
  opts?: DeriveOptions
): DerivedContext[]
```

Rules (each one gets a unit test):
1. **Docked terminals are excluded** (`dockedIn` set) — they are not canvas geometry.
2. **Existing Named Groups are authoritative.** Each is emitted as a context with `existingGroupId`,
   `signals:['group']`, `confidence:'high'`. Signals never split or merge an existing group.
3. **Absorb** (amended 2026-10-16): the **strong** edges are preview, non-hub orchestration, port
   and dataflow. Take the components of UNGROUPED boards joined by strong edges. A component whose
   strong edges reach members of exactly ONE group is proposed **whole** via that group's
   `addBoardIds` (a worker's browser rides along with the worker). Reaching two groups ⇒ ambiguous ⇒
   left out (it still clusters under rule 4).
4. Remaining ungrouped boards cluster by union-find over edges:
   - **preview** — `previewSourceId` browser→terminal (also any `kind:'preview'` connector) · high
   - **orchestration** — cable source→target, **except from a hub**: a source with ≥ 3 outgoing
     orchestration cables (a lead/command board) contributes no edges, so one lead never fuses all
     its workers into one blob · high
   - **port** — a browser's `callsPorts` intersects a terminal's `ports` (D10) · high
   - **dataflow** — a data-flow board's `sourceBoardId` browser · high (amended 2026-10-16)
   - **cwd** — same normalized cwd (case-insensitive on win32, separators normalized, trailing
     slash stripped). A cwd equal to `projectRoot` or empty carries **no** signal · medium
   - **fileRef** — a planning board's `fileRefs[].path` equals a file board's `path`, or two planning
     boards share a ref · medium
   - **title** — only when `titleSignal`; token Jaccard ≥ 0.5 with ≥ 1 non-stopword · low
5. **Singletons are never emitted.**
6. **confidence** = high if any group/preview/orchestration/port/dataflow edge; else medium if
   cwd/fileRef; else low.
7. **suggestedName** priority: planning board title in the cluster → terminal title → common cwd
   basename → `Context N`. Sanitized with `sanitizeGroupName` (C7; it lives in the shared
   `src/shared/groupName.ts`, which L6 creates, so this shared module can call it).
8. **Deterministic:** sorted ids, sorted output (by first boardId), no randomness. Cap `MAX_CONTEXTS`.
9. **Signals by board type only** (amended 2026-10-16, defence in depth behind MAIN's sanitizer):
   `cwd`/`ports` from terminals, `previewSourceId`/`callsPorts` from browsers, `path` from file
   boards, `fileRefs` from planning boards, `sourceBoardId` from data-flow boards. A field on any
   other type is ignored.

### C4 — `fitLayout()`  · owner L7 (pure, new file, zero shared files)

**`src/renderer/src/lib/fitLayout.ts`** (reuses `tidyLayout`'s `TidyBoard` and `smart` packer for
in-unit layout; imports `spatialGeometry` from C2)

```ts
export type FitOverflow = 'report' | 'pages' | 'shrink'
export interface FitUnit { id: string; boardIds: string[] }   // groups and/or derived contexts

export interface FitOptions {
  pane: { w: number; h: number }      // REQUIRED — the whole point
  units?: FitUnit[]                   // default: none (every board is its own unit)
  gap?: number                        // in-unit gap, default TIDY_GAP (28)
  unitGap?: number                    // between units, default 96 (> group-box pad, so outlines never touch)
  overflow?: FitOverflow              // default 'report' (D4)
  readableZoom?: number               // default READABLE_ZOOM (0.4)
}

export interface FitResult {
  placements: Array<{ id: string; x: number; y: number; w?: number; h?: number }> // w/h only under 'shrink'
  bbox: Rect
  fitZoom: number                     // fitZoom(bbox, pane) of the result (page 0 under 'pages')
  readable: boolean                   // fitZoom >= readableZoom
  pages?: Array<{ index: number; boardIds: string[]; bbox: Rect }>
}

export function fitLayout(boards: readonly TidyBoard[], opts: FitOptions): FitResult
```

Algorithm:
1. **Assign** each board to at most one unit: a board in several units goes to the **smallest**
   (fewest members, id tie-break). Boards in no unit become single-board units.
2. **Pack inside each unit** with the existing `smart` layout → one rect per unit.
3. **Order units** by their current top-left in reading order (y, then x, then id) so the user's
   mental map survives.
4. **Shelf-pack units toward the pane aspect:** try candidate row widths
   `sqrt(totalUnitArea × paneAspect) × {0.6, 0.7, …, 1.6}` plus "one row" and "one column"; score
   each by `fitZoom(bbox, pane)`; keep the max (tie ⇒ fewer rows ⇒ smaller candidate index).
5. **Anchor** at the current cluster top-left (tidy's "nudge, don't teleport" rule).
6. If `fitZoom < readableZoom`:
   - `report` — keep step 4's result; `readable:false`.
   - `pages` — greedily cut the ordered units into pages where each page alone fits at
     ≥ `readableZoom`; lay pages left→right, `2 × unitGap` apart; a unit too big for any page gets
     its own page (that page may still be unreadable). `fitZoom` describes page 0.
   - `shrink` — scale every board's w/h by one factor toward `MIN_BOARD_SIZE` until the packing is
     readable (or the floor is hit), then re-pack. The only mode that sets w/h.
7. Fewer than 2 boards ⇒ positions unchanged, `readable` computed honestly.

**Property tests (must hold for random inputs):** no two boards overlap · for units A ≠ B the
padded bbox of A contains no board of B · deterministic for any input order · w/h untouched unless
`shrink` · every input board gets exactly one placement.

Docked terminals are filtered by the caller (`tidyApply` precedent), never passed in.

### C5 — `McpCommand` additions (`src/shared/mcpTypes.ts`)  · owners I1 / I2

```ts
export type TidyMode = 'fit' | 'roles' | 'smart' | 'by-type' | 'grid' | 'tile'
export type TidyScope = 'all' | 'visible' | { groupId: string }
export type GroupEditOp =
  | { op: 'rename'; groupId: string; name: string }
  | { op: 'add'; groupId: string; boardIds: string[] }
  | { op: 'remove'; groupId: string; boardIds: string[] }
  | { op: 'ungroup'; groupId: string }

// WIDENED (I2): existing variant, new optional fields — old MAIN builds send a subset.
| { type: 'tidyBoards'; mode?: TidyMode; template?: TileTemplate; scope?: TidyScope;
    overflow?: FitOverflow; fit?: boolean;
    primary?: string; resize?: boolean;   // roles only (D7)
    implicit?: boolean }                  // D8 (a): MAIN sets it when the agent omitted `mode`
// NEW (I1): applied AFTER MAIN's batch confirm — only the approved rows arrive here.
| { type: 'applyGroups'; create: Array<{ name: string; boardIds: string[] }>; edits: GroupEditOp[] }

// Ack (widened):
| { ok: true; type: string; moved?: number; rendered?: boolean;
    fitZoom?: number; readable?: boolean; pages?: number; groupIds?: string[] }
```

- The renderer applier **re-validates** everything (mode enum, ids against the live store, docked
  terminals rejected) — the existing defence-in-depth rule.
- `tidyBoards` ⇒ ONE undo step (already true). `fit !== false` ⇒ the applier frames the camera on
  the result (G4) through the same camera path `focusCamera` uses.
- `applyGroups` ⇒ ONE undo step for every approved row — needs a new `groupSlice` action
  `applyGroupOps(create, edits)` built on one `trackedChange`.
- **Pre-split (L5):** move the `tidyBoards` / `focusCamera` / `spawnGroup` cases out of
  `useMcpCommands.ts` into **`src/renderer/src/store/spatialMcpApply.ts`** (the `kanbanMcpApply.ts`
  pattern) so I1 and I2 edit different files.

### C6 — MCP wire (`@expanse-ade/mcp` 0.27.0)  · owner L8

New / widened constants (exported from the package root so the host parity test can pin them):

```ts
export const TIDY_MODES = ['fit', 'roles', 'smart', 'by-type', 'grid', 'tile'] as const   // 'fit' + 'roles' + 'tile' added
export const TILE_TEMPLATES = ['cols-2', 'cols-3', 'cols-4', 'main-sidebar', 'grid'] as const
export const TIDY_OVERFLOW = ['report', 'pages', 'shrink'] as const
export const TOOL_GROUP_BOARDS = 'group_boards'
export const TOOL_EDIT_GROUPS = 'edit_groups'
export const MAX_GROUP_BATCH = 10          // rows per group_boards / edit_groups call
export const MAX_GROUP_MEMBERS = 50
export const GROUP_NAME_MAX = 80           // = host SPAWN_GROUP_MAX_NAME
export const MAX_CONTEXTS = 50
```

| Surface | Input | Output | Gate (per D1/D2) |
|---|---|---|---|
| `tidy_canvas` (widened) | `{ mode?: TidyMode (omitted ⇒ host resolves an implicit `roles`, D8 a — the schema must NOT `.default()` it; say the default in the description), template? (required iff mode 'tile'), scope?: 'all'\|'visible'\|{groupId}, overflow?, fit?: boolean (default true), primary?: boardId (roles only; forces the hero), resize?: boolean (roles only, default true, D7) }` | `{ moved, fitZoom, readable, pages?, units?: [{ scene, heroIds, why }] }` (`units` for roles) | orchestrator un-gated; lead/connected confirm |
| `group_boards` (new) | `{ groups: [{ name, boardIds }] }` (1..MAX_GROUP_BATCH) | per row `{ status: 'created'\|'denied'\|'rejected', groupId?, detail? }` | batch confirm, all tiers except worker |
| `edit_groups` (new) | `{ ops: GroupEditOp[] }` (1..MAX_GROUP_BATCH) | per row `{ status: 'applied'\|'denied'\|'rejected', detail? }` | batch confirm |
| `canvas://contexts` (new resource) | — | `{ version: 1, contexts: DerivedContext[], ungrouped: string[] }` | read-only, orchestrator/lead/connected |
| `canvas://layout` | — | v2 (C2), host-owned | widen to lead/connected (D1) |

`Orchestrator` interface additions — **optional** methods (old hosts still compile):

```ts
describeContexts?(): Promise<unknown>
groupBoards?(input: { groups: Array<{ name: string; boardIds: string[] }>; sourceBoardId?: string }): Promise<unknown>
editGroups?(input: { ops: GroupEditOp[]; sourceBoardId?: string }): Promise<unknown>
tidyCanvas(input: { mode?: string; template?: string; scope?: unknown; overflow?: string; fit?: boolean; sourceBoardId?: string }): Promise<unknown>
```

🔒 **Lesson from `publish_findings` (P1, 2026-10-16):** an optional method that the host forgets
to forward makes its tool silently vanish. So: (a) the package logs one `console.warn` when a
spatial tool is skipped for a missing method, and (b) the host adds a **`tools/list` membership
test** per tier that asserts every spatial tool is present (L2 builds the harness).

Tool descriptions must say: what moves (positions only, unless `shrink`/`tile`), that it is one
undo, the return shape, and *when to call* (`canvas://layout` → `fit.readable` false ⇒ tidy with
`fit`, or `focus_viewport` a group).

### C7 — Host methods  · owners I1 / I2

- **`src/main/mcpGroups.ts`** (new; spread into `buildOrchestrator` — `mcpOrchestrator.ts` is at its
  max-lines cap): `describeContexts`, `groupBoards`, `editGroups`. Each validates ids against the
  live mirror (unknown / docked ⇒ row `rejected`), sanitizes names, builds ONE
  `ConfirmBatchRequest` (rows = proposed groups, `blurb` per DESIGN.md), sends ONE `applyGroups`
  with only the approved rows, audits every row.
- **`ConfirmBatchItem.preselected?: boolean`** (new, optional, default `true` — `mcpConfirm.ts:84`,
  honoured at `BatchConfirmModal.tsx:81`): low-confidence group rows start unchecked (DESIGN W1).
  Additive — existing batch callers are unchanged.
- **`sanitizeGroupName(raw)`** (new, pure, **`src/shared/groupName.ts`**, built by L6 because C3
  needs it and a shared module cannot import from `src/main`; it also exports `GROUP_NAME_MAX = 80`):
  whitespace collapse + C0/C1/DEL + bidi/zero-width strip + clamp `GROUP_NAME_MAX`. I1 calls it from MAIN. **`spawn_group` adopts it too** (G11).
- **`src/main/mcpTidy.ts`** (widened): forwards the new args; for lead/connected callers raises a
  single `ConfirmRequest` first (D1).
- **Jarvis:** `jarvisTools.ts:429` omits `mode` so "tidy up" is the implicit `roles` default (D8 a)
  and screen-aware.

### C8 — UI  · owner I2 (after DESIGN.md sign-off)

- `LAYOUT_PRESETS` (D8 a, DESIGN W6): new first preset `{ id: 'roles', kind: 'tidy', tidyMode:
  'roles', label: 'By role', hint: 'Lead / browser gets the big slot; linked boards sit beside it' }`
  bound to `t` (an implicit `roles`), then `{ id: 'fit', kind: 'tidy', tidyMode: 'fit', label: 'Fit
  to screen', hint: 'Keep groups together, fit the window' }`, then Smart.
- After a `roles` tidy with units off-stage, the W7 `info` toast (Show all · Undo).
- After any `fit` tidy that ends `readable:false`, one `info` toast with a **Focus group** action
  (the existing toast-action pattern).

### C9 — Role model (`roles` input)  · owner L9 (pure, new file) · signal producers L11

**`src/shared/boardRoles.ts`** is pure. MAIN imports it for `canvas://layout` and the renderer imports
it for C10. The rules are in [`ROLE-LAYOUT.md`](./ROLE-LAYOUT.md) §1–§3, and each rule gets a unit test.

```ts
export type BoardRole =
  | 'lead' | 'swarm' | 'command' | 'agent' | 'preview'
  | 'plan' | 'tracker' | 'dataflow' | 'file' | 'server' | 'shell'
export const ROLE_WEIGHT: Readonly<Record<BoardRole, number>> // lead 100 … shell 10 (ROLE-LAYOUT §2)
export type Scene = 'lead' | 'hub' | 'pair' | 'stack' | 'peers' | 'docs' | 'single'

export interface RoleBoardInput {
  id: string; type: string; x: number; y: number; w: number; h: number
  previewSourceId?: string; dockedIn?: string; sourceBoardId?: string // dataflow → browser
  agent?: boolean; ports?: number[]; callsPorts?: number[]; lastFocusedAt?: number
}
export interface BoardRoleInfo { id: string; role: BoardRole; weight: number; links: string[]; why: string }
export interface RoleUnit {
  key: string; boardIds: string[]; source: 'group' | 'context' | 'team' | 'single'
  scene: Scene; heroIds: string[]
}
export function deriveRoles(
  boards: readonly RoleBoardInput[], connectors: readonly ContextConnectorInput[],
  opts: { leadBoardId?: string | null }
): Map<string, BoardRoleInfo>
/** Units = Named Groups ∪ C3 contexts ∪ TEAM units ∪ singles. A team unit is a lead/command/swarm
 *  board plus its direct cable targets that are not already grouped (C3's hub rule drops those
 *  edges on purpose). Deterministic. */
export function buildRoleUnits(
  boards: readonly RoleBoardInput[], connectors: readonly ContextConnectorInput[],
  groups: readonly ContextGroupInput[], contexts: readonly DerivedContext[],
  roles: ReadonlyMap<string, BoardRoleInfo>
): RoleUnit[]
```

**Mirror additions to C1.** L5 owns the shape and the sanitizer; L11 owns the producers.
`BoardContextFields` gains `agent?: boolean` · `ports?: number[]` (≤ 8, 1..65535) ·
`callsPorts?: number[]` (≤ 8) · `lastFocusedAt?: number` · `sourceBoardId?: string`. All of them are
ephemeral and never persisted (D9). MAIN reads the lead from `leadAuthority`, which is its own source of
truth, and does not take it from the renderer. Boards in `canvas://layout` (C2) gain `role: BoardRole`
(added by **L11**, the first lane that has both L5's digest and L9's `boardRoles.ts` on main).

The producers (L11):
- `agentClassify.ts` turns `agentKind`, or a launch line that matches a known agent CLI, into a boolean.
- `roleSignalsStore.ts` holds each terminal's `ports` (fed by the existing detect poll) and
  `lastFocusedAt`. Ephemeral.
- `previewOriginPorts.ts` in MAIN is the D10 observer on each preview's OSR session. Loopback only.

### C10 — `roleLayout()`  · owner L10 (pure, new files)

**`src/renderer/src/lib/roleLayout.ts`** plus **`roleTemplates.ts`**, which holds the template constants
and exports them for the golden tests. The algorithm, templates, sizing classes and overflow rules
are in ROLE-LAYOUT §1 and §4–§6.

```ts
export interface RoleLayoutOptions {
  pane: { w: number; h: number }          // screen px (C1 view)
  primary?: string                        // force the hero (S14)
  scope?: 'all' | { boardIds: string[] }  // selection scope (S12)
  overflow?: FitOverflow                  // D4 semantics
  resize?: boolean                        // default true (D7); false ⇒ role ORDER only, positions via C4
  readableZoom?: number                   // READABLE_ZOOM
  /** D8 (a): true when `roles` was chosen implicitly (agent omitted `mode`, or the `t` key). A unit
   *  whose boards are all `shell` then keeps its sizes (position-only, C4 in-unit packing) instead
   *  of the `peers` grid. Explicit `mode:'roles'` leaves it false. Default false. */
  implicit?: boolean
}
export interface RoleLayoutResult {
  placements: Array<{ id: string; x: number; y: number; w?: number; h?: number }> // w/h only flexible/aspect-locked
  stageKey: string; targetZoom: number; readable: boolean
  camera: { x: number; y: number; zoom: number } // frames the stage unit
  units: Array<{ key: string; scene: Scene; heroIds: string[]; template: string; why: string }>
}
export function roleLayout(
  boards: readonly RoleBoardInput[], roles: ReadonlyMap<string, BoardRoleInfo>,
  units: readonly RoleUnit[], opts: RoleLayoutOptions
): RoleLayoutResult
```

Fixtures S1–S15 (ROLE-LAYOUT §7) are the golden tests, and ROLE-LAYOUT §8 gives the property tests.
Multi-unit placement reuses C4's shelf packer: the stage fills the pane and the other units sit
beside it.

---

## 4. Non-goals

Auto-grouping without a confirm · persisting screen/camera data · multi-window layouts · LLM-based
naming · resizing boards in `fit` (except `overflow:'shrink'`) · changing the persisted group
shape · resizing RIGID boards (planning/kanban/file) in `roles` · persisting any role signal ·
LLM-chosen layouts (agents state the intent through mode, primary and scope; the engine does the
geometry).

## 5. Test plan

- **Unit (pure, L9/L10):** every C9 role, scene and unit rule; the C10 golden fixtures S1–S15; and the
  ROLE-LAYOUT §8 property tests (rigid w/h untouched, preview aspect ±1px, minimums, determinism).
- **Unit (pure, L6/L7):** every C3 rule (including the `port` edge); C4 property tests; `spatialGeometry` parity with
  `canvasView` (`READABLE_ZOOM`, `FIT_PADDING_PX`, `FIT_MAX_ZOOM`).
- **Unit (host):** mirror sanitizer rejects bad `view`; digest v2 fields; `mcpGroups` row
  validation + one-confirm + one-command; tier membership (`tools/list`) per D1.
- **Contract (package, L8):** schema caps, enum widening, optional-method registration + warn.
- **Integration:** `applyGroupOps` is one undo step; `tidyBoards` `fit` reframes the camera.
- **e2e (new `e2e/spatial.e2e.ts`, NOT `mcp.e2e.ts`):** the same seeded canvas tidied at two window
  sizes yields different arrangements, both `readable` at ≥ 0.4, no overlaps, groups contiguous; a
  `group_boards` batch with one denied row creates only the approved groups.
- **Cross-repo parity:** extend `mcpPlanningCapsParity.test.ts`'s pattern to the C6 caps.

## 6. Lane map (who owns what)

| Lane | Contract pieces | Files it owns |
|---|---|---|
| L5 | S0 (G1 aspect, G4 refit, G8 all groups) → C5 pre-split → C1 + C2 | `useMcpCommands.ts`, new `spatialMcpApply.ts`, `layoutModel.ts`, `preload/mcpApi.ts`, `useMcpPublish.ts`, `boardRegistry.ts` (mcp:boards), new `screenInfo.ts`, new `src/shared/spatialTypes.ts` (imports C2 geometry from L7; until L7 merges, a temp verbatim copy the coordinator drops at rebase) |
| L6 | C3 | new `src/shared/deriveContexts.ts` + new `src/shared/groupName.ts` (`sanitizeGroupName`, C7) (+ tests) |
| L7 | C4 + C2 geometry | new `src/renderer/src/lib/fitLayout.ts` + new `src/shared/spatialGeometry.ts` (owns `Rect` + the parity tests) (+ tests) — ownership moved from L5 2026-10-16 because L7 merges first |
| L8 | C6 | `canvas-ade-mcp`: `constants.ts`, `index.ts`, `factory.ts`, `Orchestrator.ts`, `mock.ts`, new tool + resource files, contract tests |
| I1 | C5 `applyGroups`, C7 groups | new `mcpGroups.ts`, `groupSlice.ts`, `spatialMcpApply.ts` (groups case), `mcpLifecycle.ts` (`spawn_group` adopts the shared `sanitizeGroupName`), `mcpConfirm.ts` (`preselected`), `BatchConfirmModal.tsx` |
| L9 | C9 (pure) | new `src/shared/boardRoles.ts` (+ test). Imports C3 types; stub them until L6 lands |
| L10 | C10 | new `src/renderer/src/lib/roleLayout.ts` + `roleTemplates.ts` (+ golden S1–S15 + property tests). Stubs the C2/C4/C9 imports until they land |
| L11 | C9 producers | new `src/renderer/src/lib/agentClassify.ts`, new `src/renderer/src/store/roleSignalsStore.ts`, new `src/main/previewOriginPorts.ts` (D10), plus ONE wiring line in `useMcpPublish.ts` **after L5 merges**, plus `role` on `canvas://layout` boards (C9, needs L5 + L9 on main) |
| I2 | C5 `tidyBoards` widening, C7 tidy/Jarvis, C8, **`roles` wiring** | `fitLayout` + `roleLayout` wiring in `canvasStore.ts`/`tidyLayout.ts`, `spatialMcpApply.ts` (tidy case), `mcpTidy.ts`, `jarvisTools.ts` ("tidy up" per D8), `layoutPresets.ts` (DESIGN W6), new `e2e/spatial.e2e.ts` (scenarios S3/S4 at two window sizes) |

Shared-but-tiny: both I1 and I2 add variants to `src/shared/mcpTypes.ts` — whichever merges second
rebases (union edits only).

**Waves:** Wave 2 = L5 · L6 · L7 · L8 · **L9 · L10 · L11**. The pure lanes run in parallel; the cap is
~4 live worktrees. Wave 3 = pin bump → I1 ∥ I2.

Serial edges: **L9 → L10** (types; stubbing them is fine) · **L5 → L11's wiring line** · **L10 freezes its
goldens only after D7–D10 are answered and ROLE-LAYOUT.md is signed off** · L4 → L8 in the package repo · package publish → app pin bump (one PR, lockfile in a
scratch dir) → I1 ∥ I2 · L1 (e2e gate) merges before anything touches `e2e/`.

# Named Board Groups — Design Spec

**Date:** 2026-06-06
**Branch:** `feat/named-board-groups` (worktree `Z:\canvas-ade-named-board-groups`)
**Status:** Design approved — pending implementation plan.

A trimmed-down first slice of the deferred **Feature Workspaces** vision (FW-1 / M6). This ships the
*grouping primitive* — select boards, name them, navigate to them — **without** the worktree/branch
backing, process isolation, or MCP swarm routing that the full vision adds later.

---

## 1. Problem / intent

A project canvas accumulates many boards (terminal + browser + planning). The user wants to cluster
related boards into a named **group** ("Auth feature", "API", …) and quickly camera-focus a whole
group. When more than one group exists, the focus action asks *which* group first.

This is the on-ramp to Feature Workspaces: the same `groups[]` record is forward-compatible with M6
later adding a `worktreePath` field (no breaking migration).

### In scope vs out of scope

| | In scope (this feature) | Out of scope (full FW-1 / M6) |
|---|---|---|
| Data | `groups[]` on the canvas doc (`{id, name, boardIds[]}`) | `worktreePath` bound to a group |
| Nav | camera-fit to a group's boards | per-zone terminal `cwd` injection |
| UI | create/name, visible box, "which group?" focus picker, manage | dirty-worktree prompt on delete |
| Process | **pure renderer + persistence** | `simple-git`/worktree IPC in MAIN, MCP zone orchestration, agent-to-zone assignment, branch merge |

---

## 2. Locked decisions

1. **Multi-membership** — a board may belong to multiple groups (`boardIds[]` per group permits it).
2. **Dedicated focus trigger** — a new focus action (key `F` gated on canvas focus + a camera-cluster
   button), *separate* from the existing double-click single-board focus. Tab double-click also focuses.
3. **Visible selection box** — an outline box is drawn around a group's member bounding-box with a
   **name tab** at the top-left. Box auto-fits as members move.
4. **Keep named-empty groups** — when a group's last board is deleted, the (now empty) named group
   survives; the user can re-add boards. Never auto-delete a group.
5. **Overlap = nested insets** — when a board is in 2+ groups, boxes draw concentric (each group inset
   more by overlap depth), largest-outer. One-accent design system → no per-group colour-coding.
6. **Tracked undo** — group create/rename/delete/membership ride the undo rail.
7. **Storage shape** — top-level `groups: NamedGroup[]` on the canvas doc, **not** a `groupId` on
   `Board` (`groupId` already exists on planning *elements*, `boardSchema.ts:70`; reusing the name on
   boards would conflate two unrelated concepts).
8. **Create trigger** — selection of **≥2** boards → `Ctrl/Cmd+G` *or* a floating "Group" button near
   the selection. `<2` selected = no-op. Group requires a minimum of 2 boards (a group of 1 is
   pointless — double-click already focuses a single board).
9. **Name tab = full handle** — single-click = select all members; double-click = focus group;
   double-click the name text = rename inline; right-click = context menu (Rename / Focus / Add
   selected / Remove group). Box outline + interior are click-through.

---

## 3. Architecture

Three concerns, each isolated:

- **Data/persistence** (`boardSchema.ts` + `canvasStore.ts`) — the `NamedGroup` type, the `groups`
  store slice + CRUD, schema migration, validation, dangling-id reconciliation, undo integration,
  serialize/deserialize threading.
- **Render** (new `GroupBoxLayer` component + a pure geometry/nesting module) — draws the outline
  boxes + name tabs, recomputed from member geometry, riding the React Flow viewport transform.
- **Interaction** (focus action + create flow + tab handle + picker) — wires keybindings, the floating
  create button, the "which group?" picker (a TidyMenu-style popover clone), and the tab menu.

No MAIN-process or MCP changes. The whole feature is renderer + the existing project persistence path.

### 3.1 Data model

```ts
// boardSchema.ts — model on Connector (boardSchema.ts:146-151)
export interface NamedGroup {
  id: string
  name: string
  boardIds: string[]
}

// CanvasDoc gains (boardSchema.ts:161-171)
groups?: NamedGroup[]   // optional so pre-migration v5 docs still parse
```

- **`canvasStore`** gains `groups: NamedGroup[]` (seeded `[]`), plus actions:
  `addGroup(name, boardIds): string`, `removeGroup(id)`, `renameGroup(id, name)`,
  `addBoardsToGroup(id, boardIds)`, `removeBoardFromGroup(id, boardId)`. Ids minted via `newId()`
  (`canvasStore.ts:158`).
- **`removeBoard`** (`canvasStore.ts:356-382`) sweeps the deleted id out of every group's `boardIds`
  in the same update (live-session consistency).

### 3.2 Schema migration (v5 → v6)

- Bump `SCHEMA_VERSION` 5 → **6** (`boardSchema.ts:21`) and update the SCHEMA-VERSION CLAIM comment
  (`boardSchema.ts:17-19`) to document **v6 = board groups**.
- Add migration at key `5` in `MIGRATIONS` (`boardSchema.ts:285-302`):
  `5: (doc) => ({ ...doc, schemaVersion: 6, groups: [] })` — backfills absent groups, zero data loss
  (direct precedent: the v4→v5 connector step at `boardSchema.ts:301`).
- `assertGroup(g)` validator (model on `assertConnector`, `boardSchema.ts:483-491`): isRecord, string
  `id`, string `name`, `boardIds` is a `string[]` (reject numbers/nulls). Called in `fromObject` after
  `migrate`. **Strict** — a malformed `boardIds` throws → the open falls back to `.bak`.
- Dangling-`boardId` sweep in `fromObject` after `assertGroup` (model on `reconcileConnectors`,
  `boardSchema.ts:500-517`): filter each group's `boardIds` to ids present in the live boards Set.
- `toObject` (`boardSchema.ts:272-283`): add a `groups` param parallel to `connectors` and
  `groups: structuredClone(groups)` in the returned doc. Thread through the store bridges:
  `toObject()` passes `get().groups` (`canvasStore.ts:633`); `loadObject()` / `applyOpenResult()`
  read `d.groups` into state (`canvasStore.ts:638, :668`).
- **Leave** `createProject` fresh-doc seed at `schemaVersion: 2` (`projectStore.ts:125`) — the
  migration pipeline backfills `groups:[]` on first open. (If ever bumped to 6 it must also seed
  `connectors:[]` + `groups:[]` or the strict validators reject it.)

### 3.3 Undo integration

- Widen `CanvasSnapshot` (`canvasStore.ts:61-64`) from `{boards, connectors}` to
  `{boards, connectors, groups}`.
- `sameSnapshot` **must** also compare `groups` refs, and the module-level `lastRecorded` must sync —
  otherwise a no-op group gesture pushes a phantom undo step (the documented `#BUG M3` class; memory
  `undo-lastRecorded-phantom`).

### 3.4 Group box render

- New **`GroupBoxLayer`** mounted inside the React Flow surface, **behind the board nodes, above the
  canvas background** (z-order between background and nodes). It rides the viewport transform like
  other in-canvas chrome — it must not be a React-re-render-driven sync.
- Per group: bounding box over member boards via `boardsBounds` (`lib/boardGeometry.ts:46-59`), then an
  **inset proportional to overlap depth** so nested groups draw concentric (largest-outer ordering).
- Visual: **outline only** (transparent fill), low-opacity accent (`#4f8cff`) border, rounded corners;
  name tab top-left using `--text-2`/`--text-3` + calm tokens. A pure module (e.g.
  `lib/groupBoxes.ts`) computes `{group, rect, depth}` for every group; the layer just renders.
- **Occlusion is accepted (ADR 0002).** The box is HTML/SVG; a live Browser board's native
  `WebContentsView` paints above it, so box segments overlapping a live Browser board are hidden at
  rest. During pan/zoom the Browser detaches to a snapshot (HTML) so the box shows. The box must
  **never** be a clipping/background frame the boards sit "inside" — it is decoration drawn around the
  member bounding-box. (The box itself needs no `setMenuOpen`; the inline name-edit input and the
  focus picker **do** call `setMenuOpen` per the ADR-0002 popover discipline.)

### 3.5 Create + name flow

- When **≥2** boards are selected, a floating "Group" button renders near the selection bounding-box;
  `Ctrl/Cmd+G` triggers the same action. `<2` selected → no-op.
- On trigger: read the selection imperatively — `rf.getNodes().filter(n => n.selected).map(n => n.id)`
  — **at commit time** (never persist the transient selection). Call `addGroup("Group N", ids)` to
  mint, then put the name tab into inline edit (the TerminalConfig inline-popover pattern,
  `boards/TerminalConfig.tsx:153-208`: controlled input, ringOn/ringOff focus, Enter commits, Esc keeps
  the auto-name, `stopPropagation` on keydown).
- Auto-name default: `"Group N"` (N = next ordinal).

### 3.6 Focus flow

- Entry points: the new focus key (`F`, canvas-focused only — must not fire while a terminal/input has
  focus), a camera-cluster button (`AppChrome.tsx:177-219`), and tab double-click. Add a `focusGroup`
  kind to `resolveCanvasKeyAction` (`hooks/useCanvasKeybindings.ts:46-63`).
- Branch by group count:
  - **0 groups** → button disabled / key no-op.
  - **1 group** → fit directly:
    `rf.fitView(cameraAnim({ ...FOCUS_OPTIONS, maxZoom, nodes: group.boardIds.map(id => ({id})) }))`.
  - **>1 group** → show the "which group?" picker (TidyMenu clone, `AppChrome.tsx:264-347`), then fit
    the chosen group.
- **Raster zoom cap:** generalize the single-board crispness rule (`Canvas.tsx:448-449`) — apply
  `maxZoom: 1` if **any** member is a terminal/browser board, else focused raster text blurs.
- Use `fitToBoards` (`hooks/useTidyTile.ts:65-86`) as the race-free fallback when controlled nodes
  haven't synced to RF. Save/restore prior viewport via `priorViewportRef` (`hooks/useFullView.ts:85`)
  so Esc returns the camera.

### 3.7 Tab interactions + manage

- Name tab: **click** = select all members (set RF selection) · **double-click** = focus group ·
  **double-click name text** = rename inline · **right-click** = context menu.
- Context menu: **Rename**, **Focus**, **Add selected boards** (adds the current canvas selection to
  this group), **Remove group**.
- **Remove group** deletes only the group record; boards are untouched. Member removal via the menu /
  `removeBoardFromGroup`.

---

## 4. Slice plan

Each slice ends runnable + committed. Built on this worktree; promoted to `main` via the sequential
merge gate once green.

- **S1 — Data + store + migration + undo (no UI).** `NamedGroup`, `CanvasDoc.groups?`, `SCHEMA_VERSION`
  5→6 + claim comment, migration `5→6`, `assertGroup`, dangling-id sweep, `structuredClone` in
  `toObject`, store slice + CRUD + `removeBoard` consistency, widened `CanvasSnapshot` + `sameSnapshot`
  + `lastRecorded` sync. Tests: migration backfill, validator reject, prune, undo snapshot incl
  groups, round-trip. **Checkpoint:** groups persist + survive reload; no user surface yet.
- **S2 — Group box render.** `GroupBoxLayer` + pure `groupBoxes` geometry/nesting module; outline +
  name tab; recompute on member move; nested-inset overlap. Against seeded groups. **Checkpoint:**
  seeded groups render correctly, boxes track moving members, overlaps nest.
- **S3 — Create + name.** Floating "Group" button (≥2 selected) + `Ctrl/Cmd+G`; reads selection at
  commit; inline tab rename. **Checkpoint:** end-to-end create-then-see-box from the canvas.
- **S4 — Focus.** `focusGroup` key + camera-cluster button + 0/1/>1 branch + "which group?" picker +
  raster cap + Esc-restore. **Checkpoint:** focus fits the chosen group; picker only when >1.
- **S5 — Tab interactions + manage.** Tab click/double-click/right-click menu (select / focus /
  rename / add-selected / remove group) + member edit. **Checkpoint:** full CRUD + navigation from the
  canvas.

S1 + S2 are independently shippable (S2 against seeded data). S3 depends on S1. S4 needs S1.

---

## 5. Testing

- **Unit:** v5→v6 migration backfill; `assertGroup` rejects malformed groups; dangling id pruned;
  `toObject`/`fromObject` round-trip verbatim; undo snapshot includes `groups`; `groupBoxes`
  nesting-inset math; auto-name ordinal generation; focus-count branch (0/1/>1) selection.
- **Integration:** serialize → reload preserves groups; deleting a board prunes it from groups
  (`persistence.integration.test.ts`).
- **E2E (thin):** create a group via real `Ctrl+G`, then focus → picker → camera fits. Drive **real OS
  input** via `webContents.sendInputEvent` for anything behind the React Flow `scale(z)` transform
  (synthetic `dispatchEvent` false-greens transformed hit-testing — memories
  `e2e-sendinputevent-vs-dispatchevent`, `e2e-modifier-keys-synthetic`). Modifier-gesture probes use
  synthetic `PointerEvent` flags.

---

## 6. Risks & gotchas

- **Schema v6 collision.** v5 is claimed by MCP M2 spatial connectors; the comment at
  `boardSchema.ts:17-19` warns the next track takes v6. The **Diagram element (PR #72 research) also
  targets v6.** Groups and Diagram must be **sequenced** — whichever lands first takes v6, the other
  rebases to v7. Do not both silently claim v6. Skipping the bump/migration corrupts older project
  files.
- **Never serialize the selection.** The multi-selection is RF-internal ephemeral state (scene/session
  split). A named group is durable data → the canvas doc; the transient selection must never be
  persisted. Read it only at name-commit time.
- **Undo phantom-step.** If `groups` join the snapshot, `sameSnapshot` + module `lastRecorded` must
  include `groups` or no-op gestures push phantom undo steps (`#BUG M3`).
- **Delete consistency, two layers.** (1) live: `removeBoard` sweeps groups in the same update;
  (2) on-disk/external-edit: `fromObject` sweeps after `assertGroup`. `assertGroup` runs **before** the
  sweep, so it must be strict about `boardIds: string[]`.
- **Raster zoom cap on mixed groups.** Apply `maxZoom:1` if any member is terminal/browser.
- **WebContentsView occlusion (ADR 0002).** Box edges over a live Browser board are hidden at rest
  (accepted). The name-edit input + picker must call `setMenuOpen(token, open)`. No clipping frames.
- **LOD-detached members.** Fit math must use the node's persisted geometry, not a detached Browser
  view's stale live bounds.
- **MCP / memory "silent stale mirror".** The trimmed feature is renderer+persistence-only with **zero
  MCP touch** — fine for navigation. But groups are then **not** visible to MCP agents, so a future FW
  MCP tool that targets a zone by name sees nothing. **Document this gap** (ADR/roadmap note) so a
  future FW dev doesn't assume groups are MCP-visible. Surfacing membership later (`groupId?` on the
  published `BoardSummary`) is a package semver bump + app-adopt PR — explicitly out of scope now.
- **`deleteKeyCode` with real multi-select.** RF deletes all selected nodes on Backspace/Delete; today
  the store collapses multi-select to one id. The trimmed feature reads RF selection only at create
  time and **does not widen the store** to true multi-select, so this stays masked. If a future slice
  widens it, the park-terminal-before-remove path (`Canvas.tsx:403`) must loop over every selected
  node.

---

## 7. Defaults (assumed unless revised)

- Focus key = `F` (canvas-focused only).
- Auto-name = `"Group N"`.
- "Which group?" picker = TidyMenu-style popover.

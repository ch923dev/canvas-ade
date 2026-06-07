# Named Board Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user multi-select boards, name them as a persisted group, see an outline "box" around each group with its name, and camera-focus a group (picker when more than one exists).

**Architecture:** Four isolated concerns. (1) Selection — add real multi-select to the Zustand store. (2) Data — a `NamedGroup` record persisted on the canvas doc behind a schema migration, riding the undo rail. (3) Render — a pure geometry module + a `GroupBoxLayer` that draws outline boxes inside the React Flow surface. (4) Interaction — create (Ctrl+G), focus (key `f` + picker + camera-cluster button), and a name-tab handle. No MAIN-process or MCP changes.

**Tech Stack:** Electron + React 18 + TypeScript (strict), Zustand store, `@xyflow/react` (React Flow v12) canvas, Vitest (unit + integration), Playwright `_electron` (e2e). Pure logic lives in `lib/*.ts` and is unit-tested without React.

**Spec:** `docs/superpowers/specs/2026-06-06-named-board-groups-design.md`

---

## Conventions for every task

- **Run the gate after each task before committing:** `pnpm typecheck && pnpm lint && pnpm test`. The plan shows the focused test command per step; the full gate is the commit guard.
- **Worktree:** all work happens in `Z:\canvas-ade-named-board-groups` (branch `feat/named-board-groups`).
- **Commits:** use a quoted heredoc (`git commit -F -`), never `-m` with backticks (memory `bash-tool-commit-backticks`). The pre-commit hook skips the e2e matrix for non-e2e commits and runs it when test files change — let it run.
- **Names used across tasks (do not rename):** `NamedGroup`, `SCHEMA_VERSION = 6`, store fields `groups` / `selectedIds` / `selectedId`, actions `addGroup` / `removeGroup` / `renameGroup` / `addBoardsToGroup` / `removeBoardFromGroup` / `toggleSelect` / `setSelection`, pure module `lib/groupBoxes.ts` (`computeGroupBoxes`, `GroupBox`), components `GroupBoxLayer` / `GroupNamePopover` / `GroupFocusPicker`, key actions `{ kind: 'group' }` / `{ kind: 'focusGroup' }`, helper `nextGroupName`.

---

# SLICE S0 — Real multi-select

**Why first:** the canvas is single-select today (`selectedId`); "select 2+ boards → Ctrl+G" needs a real multi-selection. We ADD `selectedIds: string[]` (the full set) alongside the existing `selectedId` (kept as the "primary" = last selected, which `usePreviewManager`/`previewPlan`/full-view and ~40 tests still read). Invariant: `selectedId === selectedIds[selectedIds.length - 1] ?? null`.

### Task 0.1: Store multi-selection state + actions

**Files:**
- Modify: `src/renderer/src/store/canvasStore.ts`
- Test: `src/renderer/src/store/canvasStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `canvasStore.test.ts` (new `describe`):

```ts
describe('multi-select', () => {
  beforeEach(() => {
    useCanvasStore.setState({ boards: [], past: [], future: [], selectedId: null, selectedIds: [] })
  })

  it('selectBoard sets a single-element selectedIds and the primary', () => {
    const { selectBoard } = useCanvasStore.getState()
    selectBoard('a')
    expect(useCanvasStore.getState().selectedIds).toEqual(['a'])
    expect(useCanvasStore.getState().selectedId).toBe('a')
    selectBoard(null)
    expect(useCanvasStore.getState().selectedIds).toEqual([])
    expect(useCanvasStore.getState().selectedId).toBeNull()
  })

  it('toggleSelect adds then removes, keeping selectedId as the last', () => {
    const { toggleSelect } = useCanvasStore.getState()
    toggleSelect('a')
    toggleSelect('b')
    expect(useCanvasStore.getState().selectedIds).toEqual(['a', 'b'])
    expect(useCanvasStore.getState().selectedId).toBe('b')
    toggleSelect('b')
    expect(useCanvasStore.getState().selectedIds).toEqual(['a'])
    expect(useCanvasStore.getState().selectedId).toBe('a')
  })

  it('setSelection replaces the set and derives the primary from the last id', () => {
    const { setSelection } = useCanvasStore.getState()
    setSelection(['a', 'b', 'c'])
    expect(useCanvasStore.getState().selectedIds).toEqual(['a', 'b', 'c'])
    expect(useCanvasStore.getState().selectedId).toBe('c')
    setSelection([])
    expect(useCanvasStore.getState().selectedId).toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test -- canvasStore.test --run`
Expected: FAIL — `selectedIds` / `toggleSelect` / `setSelection` are undefined.

- [ ] **Step 3: Implement the store changes**

In `canvasStore.ts`, add to the `CanvasState` interface (right after the `selectedId` field at line 74):

```ts
  /**
   * Full multi-selection set (marquee / shift-click). `selectedId` is the PRIMARY —
   * the last id added — kept in sync as `selectedIds[selectedIds.length - 1] ?? null`
   * so single-select consumers (preview liveness, full view) are unchanged. Ephemeral:
   * never serialized (scene/session split), reset to [] on load/undo like selectedId.
   */
  selectedIds: string[]
```

Add to the interface's action signatures (near `selectBoard` at line 145):

```ts
  /** Toggle one board in/out of the multi-selection (shift-click). Primary = last id. */
  toggleSelect: (id: string) => void
  /** Replace the whole multi-selection (marquee). Primary = last id, or null when empty. */
  setSelection: (ids: string[]) => void
```

Add `selectedIds: []` to the store initializer (after `selectedId: null,` at line 334).

Replace `selectBoard` (line 580) with:

```ts
  selectBoard: (id) => set({ selectedId: id, selectedIds: id ? [id] : [] }),
  toggleSelect: (id) =>
    set((s) => {
      const has = s.selectedIds.includes(id)
      const selectedIds = has ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id]
      return { selectedIds, selectedId: selectedIds[selectedIds.length - 1] ?? null }
    }),
  setSelection: (ids) =>
    set({ selectedIds: ids, selectedId: ids[ids.length - 1] ?? null }),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- canvasStore.test --run`
Expected: PASS (the new `multi-select` describe + all existing selectedId tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts
git commit -F - <<'EOF'
feat(groups): add multi-selection state to the canvas store

selectedIds[] alongside selectedId (primary = last). selectBoard now
sets both; toggleSelect (shift-click) + setSelection (marquee) added.
EOF
```

### Task 0.2: `buildBoardNodes` marks every selected board

**Files:**
- Modify: `src/renderer/src/canvas/boardNodes.ts`
- Test: `src/renderer/src/canvas/boardNodes.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `boardNodes.test.ts`:

```ts
it('marks every board in selectedIds as selected', () => {
  const a = makeBoard('a')
  const b = makeBoard('b')
  const c = makeBoard('c')
  const cache: NodeCache = new Map()
  const nodes = buildBoardNodes([a, b, c], { ...NO_FLAGS, selectedIds: ['a', 'c'] }, cache)
  expect(nodes.find((n) => n.id === 'a')?.selected).toBe(true)
  expect(nodes.find((n) => n.id === 'b')?.selected).toBe(false)
  expect(nodes.find((n) => n.id === 'c')?.selected).toBe(true)
})
```

Note: `makeBoard` is the existing test helper in this file; reuse it. Update the file's `NO_FLAGS` constant (line 6) to include `selectedIds: []` and drop `selectedId` (see Step 3).

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test -- boardNodes.test --run`
Expected: FAIL — `NodeFlags` has no `selectedIds`.

- [ ] **Step 3: Implement**

In `boardNodes.ts`, change the `NodeFlags` interface (line 15-20): replace `selectedId: string | null` with `selectedIds: readonly string[]`. Update the destructure (line 38) and the selected derivation (line 46):

```ts
export interface NodeFlags {
  selectedIds: readonly string[]
  focusedId: string | null
  fullViewId: string | null
  cameraFullViewId: string | null
}
```

```ts
  const { selectedIds, focusedId, fullViewId, cameraFullViewId } = flags
```

```ts
    const selected = selectedIds.includes(b.id)
```

In `boardNodes.test.ts`, update `NO_FLAGS` (line 6) from `selectedId: null` to `selectedIds: []`, and any existing test that passed `selectedId: 'a'` (line 56) to `selectedIds: ['a']`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test -- boardNodes.test --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/boardNodes.ts src/renderer/src/canvas/boardNodes.test.ts
git commit -F - <<'EOF'
feat(groups): buildBoardNodes marks all selectedIds as selected
EOF
```

### Task 0.3: Canvas applies the multi-selection from React Flow

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx`

(No new unit test — selection delta-folding is exercised by the existing e2e suite + the S3 create flow. This is the wiring task.)

- [ ] **Step 1: Read the current selection plumbing**

In `Canvas.tsx`: `selectedId` is read at line 108 and passed into `buildBoardNodes` at line 260-261; `onNodesChange` folds select intents into a single `nextSel` at lines 391-408.

- [ ] **Step 2: Switch the node build to selectedIds**

Replace line 108:

```ts
  const selectedIds = useCanvasStore((s) => s.selectedIds)
```

Add the new actions near the other store reads (after line 112):

```ts
  const setSelection = useCanvasStore((s) => s.setSelection)
```

Update the `buildBoardNodes` memo (lines 258-262):

```ts
  const nodes = useMemo<BoardFlowNode[]>(
    () =>
      buildBoardNodes(boards, { selectedIds, focusedId, fullViewId, cameraFullViewId }, nodeCache),
    [boards, selectedIds, focusedId, fullViewId, cameraFullViewId, nodeCache]
  )
```

- [ ] **Step 3: Fold ALL select/deselect intents into the multi-selection**

In `onNodesChange`, replace the single-select fold (lines 391-408) with a set-based apply. Replace:

```ts
      let nextSel: string | null | undefined
      for (const intent of nodeChangesToIntents(changes)) {
        if (intent.kind === 'move') updateBoard(intent.id, { x: intent.x, y: intent.y })
        else if (intent.kind === 'resize') resizeBoard(intent.id, intent.w, intent.h)
        else if (intent.kind === 'select') nextSel = intent.id
        else if (intent.kind === 'deselect') {
          if (nextSel === undefined) nextSel = null
        } else if (intent.kind === 'remove') {
          const removed = useCanvasStore.getState().boards.find((x) => x.id === intent.id)
          if (removed?.type === 'terminal') void window.api.parkTerminal(intent.id)
          removeBoard(intent.id)
          setFocusedId((f) => (f === intent.id ? null : f))
        }
      }
      if (nextSel !== undefined) selectBoard(nextSel)
```

with:

```ts
      // Fold React Flow's select/deselect deltas onto the current multi-selection. RF emits
      // select:false for the previously-selected on a plain click and select:true for each box
      // member on a marquee/shift gesture, so applying the deltas to the live set yields the
      // correct single OR multi selection (the prior single-id fold collapsed multi-select).
      let selChanged = false
      const selSet = new Set(useCanvasStore.getState().selectedIds)
      for (const intent of nodeChangesToIntents(changes)) {
        if (intent.kind === 'move') updateBoard(intent.id, { x: intent.x, y: intent.y })
        else if (intent.kind === 'resize') resizeBoard(intent.id, intent.w, intent.h)
        else if (intent.kind === 'select') {
          selSet.add(intent.id)
          selChanged = true
        } else if (intent.kind === 'deselect') {
          selSet.delete(intent.id)
          selChanged = true
        } else if (intent.kind === 'remove') {
          // #15: park a terminal's live session BEFORE removal so undo can adopt it. RF's
          // deleteKeyCode removes EVERY selected node, so this now loops over the whole selection.
          const removed = useCanvasStore.getState().boards.find((x) => x.id === intent.id)
          if (removed?.type === 'terminal') void window.api.parkTerminal(intent.id)
          removeBoard(intent.id)
          setFocusedId((f) => (f === intent.id ? null : f))
        }
      }
      if (selChanged) setSelection([...selSet])
```

Update the `onNodesChange` dependency array (line 410) to swap `selectBoard` → `setSelection`:

```ts
    [updateBoard, resizeBoard, removeBoard, setSelection, boards, rf]
```

Note: `selectBoard` is still imported/used elsewhere (focusBoard, clearSelection, boardActions). Leave those untouched — they intentionally collapse to a single selection.

- [ ] **Step 4: Run the gate**

Run: `pnpm typecheck && pnpm lint && pnpm test --run`
Expected: PASS (typecheck clean — note the `e2eHooks.ts:375` and `AppChrome.dock.integration.test.tsx:11` literals that set `selectedId: null` still type-check because `selectedIds` defaults via the initializer; if typecheck flags a missing `selectedIds` in a `setState` literal, add `selectedIds: []` there).

- [ ] **Step 5: Verify multi-select in the app (manual)**

Run: `pnpm dev`. Shift-click two boards → both show the selection ring. Shift+drag a marquee over several → all ring. Click empty → all clear.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/Canvas.tsx
git commit -F - <<'EOF'
feat(groups): apply React Flow multi-selection to the store

onNodesChange folds all select/deselect deltas into selectedIds via
setSelection; buildBoardNodes now reads selectedIds. Shift-click and
Shift+drag marquee select multiple boards.
EOF
```

---

# SLICE S1 — Data model + migration + undo (no UI)

### Task 1.1: `NamedGroup` type, `CanvasDoc.groups`, schema v6 + migration

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts`
- Test: `src/renderer/src/lib/boardSchema.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `boardSchema.test.ts`:

```ts
describe('schema v6 — board groups', () => {
  it('SCHEMA_VERSION is 6', () => {
    expect(SCHEMA_VERSION).toBe(6)
  })

  it('migrates a v5 doc to v6 with an empty groups array', () => {
    const v5 = { schemaVersion: 5, viewport: null, boards: [], connectors: [] }
    const migrated = migrate(v5 as never)
    expect(migrated.schemaVersion).toBe(6)
    expect(migrated.groups).toEqual([])
  })

  it('preserves existing groups through a no-op migrate of a v6 doc', () => {
    const v6 = {
      schemaVersion: 6,
      viewport: null,
      boards: [],
      connectors: [],
      groups: [{ id: 'g1', name: 'Auth', boardIds: [] }]
    }
    const migrated = migrate(v6 as never)
    expect(migrated.groups).toEqual([{ id: 'g1', name: 'Auth', boardIds: [] }])
  })
})
```

(Ensure `SCHEMA_VERSION` and `migrate` are imported in the test file — they already are for the existing migration suite.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- boardSchema.test --run`
Expected: FAIL — `SCHEMA_VERSION` is 5; `migrated.groups` is undefined.

- [ ] **Step 3: Implement the type + version + migration**

In `boardSchema.ts`:

Bump the version + update the claim comment (lines 14-21):

```ts
/**
 * Bump on any breaking change to the persisted shape and add a migration below.
 *
 * SCHEMA-VERSION CLAIM: v5 = MCP M2 spatial connectors. **v6 = board groups**
 * (named board clusters, this feature). The Diagram element (PR #72 research) also
 * eyed v6 — whichever lands first takes v6, the other rebases to v7. Do not silently
 * reuse a version for a different shape.
 */
export const SCHEMA_VERSION = 6
```

Add the `NamedGroup` interface (right after the `Connector` block, around line 151):

```ts
// ── Named board groups (v6 — a named cluster of boards) ────────────────────────
// A user-named set of boards: durable navigation/grouping data (camera-focus a group,
// draw an outline box around it). A board may belong to MANY groups (multi-membership).
// Forward-compatible with the deferred Feature Workspaces phase, which will add an
// optional `worktreePath` to this record (no breaking migration).

export interface NamedGroup {
  id: string
  name: string
  boardIds: string[]
}
```

Add `groups` to `CanvasDoc` (the interface at lines 161-171) — OPTIONAL so a pre-migration v5 doc still parses:

```ts
  /** Named board groups (v6). Optional in the type so a pre-migration v5 doc parses;
   *  the v5→v6 migration backfills `[]` and `fromObject` always returns a present array. */
  groups?: NamedGroup[]
```

Add the migration step (in `MIGRATIONS`, after the `4:` entry at line 301):

```ts
  // v6 adds `groups` (named board clusters). Backfill an empty array — older projects
  // have no groups. Boards/connectors are untouched.
  5: (doc) => ({ ...doc, schemaVersion: 6, groups: (doc as CanvasDoc).groups ?? [] })
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- boardSchema.test --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/boardSchema.ts src/renderer/src/lib/boardSchema.test.ts
git commit -F - <<'EOF'
feat(groups): NamedGroup type + schema v5->v6 migration
EOF
```

### Task 1.2: `assertGroup` validation + dangling-boardId sweep in `fromObject`

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts`
- Test: `src/renderer/src/lib/boardSchema.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('fromObject — groups validation + reconciliation', () => {
  const base = (groups: unknown): unknown => ({
    schemaVersion: 6,
    viewport: null,
    boards: [
      { id: 'b1', type: 'terminal', x: 0, y: 0, w: 300, h: 200, title: 'T' },
      { id: 'b2', type: 'terminal', x: 0, y: 0, w: 300, h: 200, title: 'T' }
    ],
    connectors: [],
    groups
  })

  it('keeps a valid group and prunes boardIds that point at missing boards', () => {
    const doc = fromObject(base([{ id: 'g1', name: 'Auth', boardIds: ['b1', 'ghost'] }]))
    expect(doc.groups).toEqual([{ id: 'g1', name: 'Auth', boardIds: ['b1'] }])
  })

  it('keeps a group whose boards were all pruned (named-empty survives)', () => {
    const doc = fromObject(base([{ id: 'g1', name: 'Auth', boardIds: ['ghost'] }]))
    expect(doc.groups).toEqual([{ id: 'g1', name: 'Auth', boardIds: [] }])
  })

  it('throws on a malformed group (non-string-array boardIds)', () => {
    expect(() => fromObject(base([{ id: 'g1', name: 'Auth', boardIds: [5] }]))).toThrow(
      /fromObject/
    )
  })

  it('defaults a v6 doc with no groups field to an empty array', () => {
    const { groups: _omit, ...noGroups } = base([]) as Record<string, unknown>
    const doc = fromObject(noGroups)
    expect(doc.groups).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- boardSchema.test --run`
Expected: FAIL — `doc.groups` is currently passed through unvalidated/unreconciled (danglers not pruned; malformed not rejected).

- [ ] **Step 3: Implement `assertGroup` + `reconcileGroups`**

In `boardSchema.ts`, add after `assertConnector` (line 491):

```ts
/** Validate one named group (id/name strings + a string[] boardIds); throws on mismatch. */
function assertGroup(g: unknown): void {
  if (!isRecord(g)) fail('group is not an object')
  if (typeof g.id !== 'string') fail('group has a non-string id')
  if (typeof g.name !== 'string') fail('group has a non-string name')
  if (!Array.isArray(g.boardIds) || !g.boardIds.every((x) => typeof x === 'string')) {
    fail('group boardIds is not a string[]')
  }
}

/**
 * Reconcile a migrated doc's groups: validate each, then prune every boardId that points
 * at a board no longer present (the on-disk consistency guard, mirror of reconcileConnectors).
 * A group whose boards are all gone is KEPT (named-empty groups survive — design decision 4).
 */
function reconcileGroups(doc: CanvasDoc): NamedGroup[] {
  const raw = Array.isArray(doc.groups) ? doc.groups : []
  raw.forEach(assertGroup)
  const ids = new Set(doc.boards.map((b) => b.id))
  return (raw as NamedGroup[]).map((g) => ({
    ...g,
    boardIds: g.boardIds.filter((bid) => ids.has(bid))
  }))
}
```

In `fromObject`, after the `reconcileConnectors` line (line 549), add:

```ts
  // Reconcile groups (v6): validate, prune danglers, keep named-empty groups. Runs
  // post-migrate so a v5 doc's freshly-backfilled `[]` is handled the same as a v6 doc's.
  migrated.groups = reconcileGroups(migrated)
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- boardSchema.test --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/boardSchema.ts src/renderer/src/lib/boardSchema.test.ts
git commit -F - <<'EOF'
feat(groups): assertGroup validation + dangling-boardId sweep in fromObject
EOF
```

### Task 1.3: `toObject` serializes groups

**Files:**
- Modify: `src/renderer/src/lib/boardSchema.ts`
- Test: `src/renderer/src/lib/boardSchema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('toObject round-trips groups (deep-cloned)', () => {
  const groups = [{ id: 'g1', name: 'Auth', boardIds: ['b1'] }]
  const doc = toObject([], null, [], groups)
  expect(doc.groups).toEqual(groups)
  // deep clone: mutating the input must not change the doc
  groups[0].name = 'changed'
  expect(doc.groups?.[0].name).toBe('Auth')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- boardSchema.test --run`
Expected: FAIL — `toObject` takes 3 args; `doc.groups` is undefined.

- [ ] **Step 3: Implement**

In `boardSchema.ts`, extend `toObject` (lines 272-283):

```ts
export function toObject(
  boards: Board[],
  viewport: CanvasViewport | null,
  connectors: Connector[] = [],
  groups: NamedGroup[] = []
): CanvasDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    viewport: viewport ? { ...viewport } : null,
    boards: structuredClone(boards),
    connectors: structuredClone(connectors),
    groups: structuredClone(groups)
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- boardSchema.test --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/boardSchema.ts src/renderer/src/lib/boardSchema.test.ts
git commit -F - <<'EOF'
feat(groups): toObject serializes the groups array (deep-cloned)
EOF
```

### Task 1.4: Store `groups` slice + widened undo snapshot

**Files:**
- Modify: `src/renderer/src/store/canvasStore.ts`
- Test: `src/renderer/src/store/canvasStore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('groups — undo snapshot', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      boards: [], connectors: [], groups: [], past: [], future: [], selectedId: null, selectedIds: []
    })
  })

  it('initializes groups to an empty array', () => {
    expect(useCanvasStore.getState().groups).toEqual([])
  })

  it('captures groups in the undo snapshot (undo restores prior groups)', () => {
    const { addGroup, undo } = useCanvasStore.getState()
    const gid = addGroup('Auth', [])
    expect(useCanvasStore.getState().groups.map((g) => g.id)).toContain(gid)
    undo()
    expect(useCanvasStore.getState().groups).toEqual([])
  })
})
```

(This test also depends on `addGroup` from Task 1.5; if executing strictly in order, write the `addGroup`-using assertion in Task 1.5 instead and keep only the `initializes groups` assertion here. The widening below is the prerequisite either way.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- canvasStore.test --run`
Expected: FAIL — `groups` undefined on state; `CanvasSnapshot` has no `groups`.

- [ ] **Step 3: Implement the slice + snapshot widening**

In `canvasStore.ts`:

Widen `CanvasSnapshot` (lines 61-64):

```ts
export interface CanvasSnapshot {
  boards: Board[]
  connectors: Connector[]
  groups: NamedGroup[]
}
```

Import `NamedGroup` (add to the type import from `../lib/boardSchema`, lines 12-25):

```ts
  type NamedGroup,
```

Add `groups` to `CanvasState` (after the `connectors` field, line 73):

```ts
  /** Named board groups (v6). Rides the undo rail with boards + connectors. */
  groups: NamedGroup[]
```

Add `groups: []` to the initializer (after `connectors: [],` at line 333).

Update `lastRecorded` + `sameSnapshot` to include groups. Replace `sameSnapshot` (lines 179-181):

```ts
function sameSnapshot(snap: CanvasSnapshot | null | undefined, s: CanvasState): boolean {
  return (
    !!snap && snap.boards === s.boards && snap.connectors === s.connectors && snap.groups === s.groups
  )
}
```

Update `trackedChange` (lines 212-232) to carry groups:

```ts
function trackedChange(
  s: CanvasState,
  next: { boards?: Board[]; connectors?: Connector[]; groups?: NamedGroup[] } | null,
  opts: { selection?: { selectedId: string | null; selectedIds: string[] }; reflectPresent: boolean }
): Partial<CanvasState> | CanvasState {
  if (next == null) return s
  const nextBoards = next.boards ?? s.boards
  const nextConnectors = next.connectors ?? s.connectors
  const nextGroups = next.groups ?? s.groups
  if (nextBoards === s.boards && nextConnectors === s.connectors && nextGroups === s.groups) return s
  if (opts.reflectPresent) {
    lastRecorded = { boards: nextBoards, connectors: nextConnectors, groups: nextGroups }
  }
  const base: Partial<CanvasState> = {
    past: recordPast(s.past, { boards: s.boards, connectors: s.connectors, groups: s.groups }),
    future: [],
    boards: nextBoards,
    connectors: nextConnectors,
    groups: nextGroups
  }
  return opts.selection ? { ...base, ...opts.selection } : base
}
```

NOTE: this changes `trackedChange`'s `opts.selectedId` to `opts.selection` (an object). Update the three existing callers:
- `addBoard` (line 351): `{ selection: { selectedId: id, selectedIds: [id] }, reflectPresent: false }`
- `duplicateBoard` (line 414): `{ selection: { selectedId: cloneId, selectedIds: [cloneId] }, reflectPresent: false }`
- `removeBoard` (lines 377-381): compute the next selection (see Task 1.6) — for now, to keep this task self-contained, use:
  ```ts
  const nextSelIds = s.selectedIds.filter((x) => x !== id)
  return trackedChange(
    s,
    { boards: next, connectors: nextConnectors },
    {
      selection: { selectedIds: nextSelIds, selectedId: nextSelIds[nextSelIds.length - 1] ?? null },
      reflectPresent: false
    }
  )
  ```
- `addConnector`/`removeConnector`/`tidyBoards`/`tileBoards` (lines 439, 447, 522, 555): leave them WITHOUT a `selection` key (they omit selection to keep it untouched) — they already pass only `{ reflectPresent: ... }`, which still type-checks.

Update the `beginChange` snapshot (lines 598-600) to include groups:

```ts
      const snap: CanvasSnapshot = { boards: s.boards, connectors: s.connectors, groups: s.groups }
      lastRecorded = snap
      return { past: recordPast(s.past, snap) }
```

Update `undo` and `redo` (lines 602-629) — pass + restore groups:

```ts
  undo: () =>
    set((s) => {
      const r = applyUndo(
        s.past,
        { boards: s.boards, connectors: s.connectors, groups: s.groups },
        s.future
      )
      if (!r) return s
      lastRecorded = r.present
      return {
        boards: r.present.boards,
        connectors: r.present.connectors,
        groups: r.present.groups,
        past: r.past,
        future: r.future,
        selectedId: null,
        selectedIds: []
      }
    }),
  redo: () =>
    set((s) => {
      const r = applyRedo(
        s.past,
        { boards: s.boards, connectors: s.connectors, groups: s.groups },
        s.future
      )
      if (!r) return s
      lastRecorded = r.present
      return {
        boards: r.present.boards,
        connectors: r.present.connectors,
        groups: r.present.groups,
        past: r.past,
        future: r.future,
        selectedId: null,
        selectedIds: []
      }
    }),
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- canvasStore.test --run`
Expected: the `initializes groups` test passes; the `addGroup`/`undo` assertion passes once Task 1.5 lands (or is moved there).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts
git commit -F - <<'EOF'
feat(groups): store groups slice + widen undo snapshot to {boards,connectors,groups}
EOF
```

### Task 1.5: Group CRUD actions

**Files:**
- Modify: `src/renderer/src/store/canvasStore.ts`
- Test: `src/renderer/src/store/canvasStore.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe('group CRUD', () => {
  beforeEach(() => {
    useCanvasStore.setState({
      boards: [], connectors: [], groups: [], past: [], future: [], selectedId: null, selectedIds: []
    })
  })

  it('addGroup mints an id, stores name + boardIds, returns the id', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1', 'b2'])
    const g = useCanvasStore.getState().groups.find((x) => x.id === id)
    expect(g).toEqual({ id, name: 'Auth', boardIds: ['b1', 'b2'] })
  })

  it('renameGroup changes the name only', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1'])
    useCanvasStore.getState().renameGroup(id, 'API')
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)?.name).toBe('API')
  })

  it('removeGroup drops the record (boards untouched)', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1'])
    useCanvasStore.getState().removeGroup(id)
    expect(useCanvasStore.getState().groups).toEqual([])
  })

  it('addBoardsToGroup unions ids (no duplicates); removeBoardFromGroup removes one', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1'])
    useCanvasStore.getState().addBoardsToGroup(id, ['b1', 'b2'])
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)?.boardIds).toEqual(['b1', 'b2'])
    useCanvasStore.getState().removeBoardFromGroup(id, 'b1')
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)?.boardIds).toEqual(['b2'])
  })

  it('each CRUD op is one undo step', () => {
    const id = useCanvasStore.getState().addGroup('Auth', ['b1'])
    useCanvasStore.getState().renameGroup(id, 'API')
    useCanvasStore.getState().undo()
    expect(useCanvasStore.getState().groups.find((x) => x.id === id)?.name).toBe('Auth')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- canvasStore.test --run`
Expected: FAIL — actions undefined.

- [ ] **Step 3: Implement the CRUD actions + interface signatures**

Add to the `CanvasState` interface (near `removeConnector`, around line 114):

```ts
  /** Create a named group over `boardIds`; returns the new id. One tracked undo step. */
  addGroup: (name: string, boardIds: string[]) => string
  /** Remove a group record (boards untouched). One tracked step; no-op for an unknown id. */
  removeGroup: (id: string) => void
  /** Rename a group. One tracked step; no-op for an unknown id or unchanged name. */
  renameGroup: (id: string, name: string) => void
  /** Union boards into a group (dedup). One tracked step; no-op if nothing new. */
  addBoardsToGroup: (id: string, boardIds: string[]) => void
  /** Remove one board from a group. One tracked step; no-op if not a member. */
  removeBoardFromGroup: (id: string, boardId: string) => void
```

Add the implementations (after `removeConnector`, around line 454):

```ts
  addGroup: (name, boardIds) => {
    const id = newId()
    const group: NamedGroup = { id, name, boardIds: [...new Set(boardIds)] }
    set((s) => trackedChange(s, { groups: [...s.groups, group] }, { reflectPresent: false }))
    return id
  },

  removeGroup: (id) =>
    set((s) => {
      if (!s.groups.some((g) => g.id === id)) return s
      return trackedChange(s, { groups: s.groups.filter((g) => g.id !== id) }, { reflectPresent: false })
    }),

  renameGroup: (id, name) =>
    set((s) => {
      const g = s.groups.find((x) => x.id === id)
      if (!g || g.name === name) return s
      return trackedChange(
        s,
        { groups: s.groups.map((x) => (x.id === id ? { ...x, name } : x)) },
        { reflectPresent: false }
      )
    }),

  addBoardsToGroup: (id, boardIds) =>
    set((s) => {
      const g = s.groups.find((x) => x.id === id)
      if (!g) return s
      const merged = [...new Set([...g.boardIds, ...boardIds])]
      if (merged.length === g.boardIds.length) return s // nothing new
      return trackedChange(
        s,
        { groups: s.groups.map((x) => (x.id === id ? { ...x, boardIds: merged } : x)) },
        { reflectPresent: false }
      )
    }),

  removeBoardFromGroup: (id, boardId) =>
    set((s) => {
      const g = s.groups.find((x) => x.id === id)
      if (!g || !g.boardIds.includes(boardId)) return s
      return trackedChange(
        s,
        {
          groups: s.groups.map((x) =>
            x.id === id ? { ...x, boardIds: x.boardIds.filter((b) => b !== boardId) } : x
          )
        },
        { reflectPresent: false }
      )
    }),
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- canvasStore.test --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts
git commit -F - <<'EOF'
feat(groups): store CRUD — add/remove/rename group + add/remove member
EOF
```

### Task 1.6: `removeBoard` sweeps groups

**Files:**
- Modify: `src/renderer/src/store/canvasStore.ts`
- Test: `src/renderer/src/store/canvasStore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('removeBoard removes the deleted id from every group in one undo step', () => {
  useCanvasStore.setState({
    boards: [], connectors: [], groups: [], past: [], future: [], selectedId: null, selectedIds: []
  })
  const id = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
  const gid = useCanvasStore.getState().addGroup('Auth', [id])
  useCanvasStore.getState().removeBoard(id)
  expect(useCanvasStore.getState().groups.find((g) => g.id === gid)?.boardIds).toEqual([])
  // one undo restores both the board and its membership
  useCanvasStore.getState().undo()
  expect(useCanvasStore.getState().groups.find((g) => g.id === gid)?.boardIds).toEqual([id])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- canvasStore.test --run`
Expected: FAIL — `removeBoard` doesn't touch groups.

- [ ] **Step 3: Implement the sweep in `removeBoard`**

In `removeBoard` (lines 356-382), after computing `nextConnectors`, add the group sweep and pass `groups` into `trackedChange`:

```ts
      // Sweep the removed board out of every group IN THE SAME tracked step, so one undo
      // restores the board AND its memberships (mirror of the connector sweep). Only mint a
      // new groups array when a membership actually changes (else keep the ref to no-op).
      const inGroups = s.groups.some((g) => g.boardIds.includes(id))
      const nextGroups = inGroups
        ? s.groups.map((g) =>
            g.boardIds.includes(id) ? { ...g, boardIds: g.boardIds.filter((b) => b !== id) } : g
          )
        : s.groups
      const nextSelIds = s.selectedIds.filter((x) => x !== id)
      return trackedChange(
        s,
        { boards: next, connectors: nextConnectors, groups: nextGroups },
        {
          selection: { selectedIds: nextSelIds, selectedId: nextSelIds[nextSelIds.length - 1] ?? null },
          reflectPresent: false
        }
      )
```

(Replace the existing `return trackedChange(...)` at lines 377-381 with the above.)

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- canvasStore.test --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/canvasStore.ts src/renderer/src/store/canvasStore.test.ts
git commit -F - <<'EOF'
feat(groups): removeBoard sweeps the deleted id from all groups (one undo step)
EOF
```

### Task 1.7: Persistence bridge — `toObject`/`loadObject`/`applyOpenResult` thread groups

**Files:**
- Modify: `src/renderer/src/store/canvasStore.ts`
- Test: `src/renderer/src/store/persistence.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `persistence.integration.test.ts`:

```ts
it('round-trips groups through toObject -> loadObject and prunes deleted boards', () => {
  useCanvasStore.setState({
    boards: [], connectors: [], groups: [], past: [], future: [], selectedId: null, selectedIds: []
  })
  const b1 = useCanvasStore.getState().addBoard('terminal', { x: 0, y: 0 })
  const b2 = useCanvasStore.getState().addBoard('terminal', { x: 400, y: 0 })
  const gid = useCanvasStore.getState().addGroup('Auth', [b1, b2])
  const doc = useCanvasStore.getState().toObject()
  expect(doc.groups?.find((g) => g.id === gid)?.boardIds).toEqual([b1, b2])

  // Reload a doc whose group references a now-missing board → pruned on load.
  const pruned = { ...doc, boards: doc.boards.filter((b) => b.id === b1) }
  useCanvasStore.getState().loadObject(pruned)
  expect(useCanvasStore.getState().groups.find((g) => g.id === gid)?.boardIds).toEqual([b1])
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- persistence.integration.test --run`
Expected: FAIL — `toObject` doesn't pass groups; `loadObject` doesn't set `groups`.

- [ ] **Step 3: Implement the bridge wiring**

In `canvasStore.ts`:

`toObject` (lines 633-637) — pass groups:

```ts
  toObject: () =>
    toObject(
      get().boards,
      get().viewport,
      [...previewConnectorsFor(get().boards), ...get().connectors],
      get().groups
    ),
```

`loadObject` success `set(...)` (lines 658-665) — add `groups: d.groups ?? []`:

```ts
    set({
      boards: d.boards,
      connectors: d.connectors,
      groups: d.groups ?? [],
      viewport: d.viewport,
      selectedId: null,
      selectedIds: [],
      past: [],
      future: []
    })
```

`applyOpenResult` — BOTH the `.bak` recovery `set(...)` (lines 691-699) and the main success `set(...)` (lines 717-725): add `groups: d2.groups ?? []` / `groups: d.groups ?? []` and `selectedIds: []`. Example for the main path:

```ts
    set({
      boards: d.boards,
      connectors: d.connectors,
      groups: d.groups ?? [],
      viewport: d.viewport,
      selectedId: null,
      selectedIds: [],
      past: [],
      future: [],
      project: { dir: r.dir, name: r.name, status: 'open' }
    })
```

(`d.groups` is always present after `fromObject`'s `reconcileGroups`, but `?? []` is defensive against the type's optional `groups?`.)

- [ ] **Step 4: Run the gate**

Run: `pnpm typecheck && pnpm lint && pnpm test --run`
Expected: PASS. (Watch `useMcpCommands.test.ts:9`, `previewPlan.test.ts`, etc. — they set `selectedId: null` in `setState` literals; if typecheck flags a missing field it'll be `selectedIds`, add `selectedIds: []` there. `groups` defaults via the initializer so partial `setState` literals are fine.)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/store/canvasStore.ts src/renderer/src/store/persistence.integration.test.ts
git commit -F - <<'EOF'
feat(groups): persist groups via toObject/loadObject/applyOpenResult bridge
EOF
```

---

# SLICE S2 — Group box render

### Task 2.1: Pure `computeGroupBoxes` with nested-inset overlap

**Files:**
- Create: `src/renderer/src/lib/groupBoxes.ts`
- Test: `src/renderer/src/lib/groupBoxes.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/renderer/src/lib/groupBoxes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeGroupBoxes } from './groupBoxes'
import type { NamedGroup } from './boardSchema'
import type { BoardRect } from './boardGeometry'

const boards: BoardRect[] = [
  { id: 'a', x: 0, y: 0, w: 100, h: 100 },
  { id: 'b', x: 200, y: 0, w: 100, h: 100 },
  { id: 'c', x: 0, y: 200, w: 100, h: 100 }
]

describe('computeGroupBoxes', () => {
  it('frames a group around its members minus the base inset (pad expands the box outward)', () => {
    const groups: NamedGroup[] = [{ id: 'g1', name: 'Auth', boardIds: ['a', 'b'] }]
    const [box] = computeGroupBoxes(groups, boards, { pad: 16, insetStep: 8 })
    // bounds of a+b = x:0..300, y:0..100; pad 16 expands outward, depth 0 (no nesting)
    expect(box).toMatchObject({ id: 'g1', name: 'Auth', depth: 0 })
    expect(box.x).toBe(-16)
    expect(box.y).toBe(-16)
    expect(box.w).toBe(300 + 32)
    expect(box.h).toBe(100 + 32)
  })

  it('skips an empty group (no members → no box)', () => {
    const groups: NamedGroup[] = [{ id: 'g1', name: 'Empty', boardIds: [] }]
    expect(computeGroupBoxes(groups, boards, { pad: 16, insetStep: 8 })).toEqual([])
  })

  it('skips a group whose members are all missing', () => {
    const groups: NamedGroup[] = [{ id: 'g1', name: 'Ghosts', boardIds: ['zzz'] }]
    expect(computeGroupBoxes(groups, boards, { pad: 16, insetStep: 8 })).toEqual([])
  })

  it('insets a fully-contained (nested) group by its depth so overlapping boxes are concentric', () => {
    const groups: NamedGroup[] = [
      { id: 'outer', name: 'Outer', boardIds: ['a', 'b', 'c'] },
      { id: 'inner', name: 'Inner', boardIds: ['a', 'b'] }
    ]
    const boxes = computeGroupBoxes(groups, boards, { pad: 16, insetStep: 8 })
    const outer = boxes.find((x) => x.id === 'outer')!
    const inner = boxes.find((x) => x.id === 'inner')!
    expect(outer.depth).toBe(0)
    expect(inner.depth).toBe(1) // inner sits inside outer's bounds → deeper
    // deeper boxes shrink their pad by depth*insetStep so they nest visibly inside
    expect(inner.x).toBeGreaterThan(outer.x)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- groupBoxes.test --run`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `groupBoxes.ts`**

```ts
/**
 * Pure geometry for the group outline boxes (no React/DOM). Each group becomes one
 * world-space rect framing its member boards, expanded outward by a `pad`. When a board
 * belongs to multiple groups the boxes would overlap, so a box that is fully contained
 * within another group's bounds gets a higher `depth` and a smaller effective pad — the
 * boxes draw concentric (largest-outer), one accent, no per-group colour (DESIGN: one accent).
 *
 * Unit-tested in isolation; the GroupBoxLayer just renders what this returns.
 */
import type { NamedGroup } from './boardSchema'
import { boardsBounds, type BoardRect, type Bounds } from './boardGeometry'

export interface GroupBox {
  id: string
  name: string
  x: number
  y: number
  w: number
  h: number
  /** Nesting depth (0 = outermost). Drives the concentric inset. */
  depth: number
}

export interface GroupBoxOpts {
  /** World-px the box extends beyond its member bounds at depth 0. */
  pad: number
  /** World-px the pad shrinks per nesting level so nested boxes sit visibly inside. */
  insetStep: number
}

/** True when bounds `a` is fully inside bounds `b` (used to order nesting). */
function contains(b: Bounds, a: Bounds): boolean {
  return a.minX >= b.minX && a.minY >= b.minY && a.maxX <= b.maxX && a.maxY <= b.maxY
}

export function computeGroupBoxes(
  groups: NamedGroup[],
  boards: BoardRect[],
  opts: GroupBoxOpts
): GroupBox[] {
  const byId = new Map(boards.map((b) => [b.id, b]))
  // Resolve each group to the bounds of its PRESENT members; skip groups with none.
  const resolved = groups
    .map((g) => {
      const rects = g.boardIds.map((id) => byId.get(id)).filter((b): b is BoardRect => !!b)
      const bb = rects.length ? boardsBounds(rects) : null
      return bb ? { group: g, bounds: bb } : null
    })
    .filter((r): r is { group: NamedGroup; bounds: Bounds } => !!r)

  return resolved.map(({ group, bounds }) => {
    // Depth = how many OTHER resolved groups fully contain this one's bounds. A larger box
    // that contains this is "outer"; this one nests inside → deeper → smaller pad.
    const depth = resolved.filter((o) => o.group.id !== group.id && contains(o.bounds, bounds)).length
    const pad = Math.max(0, opts.pad - depth * opts.insetStep)
    return {
      id: group.id,
      name: group.name,
      x: bounds.minX - pad,
      y: bounds.minY - pad,
      w: bounds.maxX - bounds.minX + pad * 2,
      h: bounds.maxY - bounds.minY + pad * 2,
      depth
    }
  })
}
```

Export `Bounds` from `boardGeometry.ts` if not already exported — it is (line 34, `export interface Bounds`).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- groupBoxes.test --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/groupBoxes.ts src/renderer/src/lib/groupBoxes.test.ts
git commit -F - <<'EOF'
feat(groups): pure computeGroupBoxes with nested-inset overlap geometry
EOF
```

### Task 2.2: `GroupBoxLayer` component + mount in the canvas

**Files:**
- Create: `src/renderer/src/canvas/GroupBoxLayer.tsx`
- Modify: `src/renderer/src/canvas/Canvas.tsx`
- Modify: `src/renderer/src/renderer.css` (or the existing global stylesheet — see note)

> **Stylesheet note:** the repo's tokens live in `src/renderer/src/index.css` (mirror of DESIGN.md). Add the group-box classes there, alongside the existing `.ca-*` classes. Use only existing tokens (`--accent`, `--accent-wash`, `--surface-raised`, `--text-2`, `--r-ctl`).

- [ ] **Step 1: Implement the layer component**

Create `src/renderer/src/canvas/GroupBoxLayer.tsx`:

```tsx
/**
 * Draws one outline box per named group, framing its member boards with the name on a tab.
 * Mounted INSIDE <ReactFlow> (below the board nodes) so it rides the camera transform via the
 * React Flow viewport. Outline-only + interior pointer-events:none so boards/canvas underneath
 * stay interactive; only the name tab is a handle (S3/S5 wire its actions). Occlusion (ADR 0002):
 * a live Browser board's native view paints over box segments it overlaps at rest — accepted.
 */
import { useMemo, type ReactElement } from 'react'
import { useStore } from '@xyflow/react'
import { useCanvasStore } from '../store/canvasStore'
import { computeGroupBoxes } from '../lib/groupBoxes'

/** World-px the box extends beyond member bounds (depth 0) + the per-nesting inset. */
export const GROUP_BOX_PAD = 20
export const GROUP_BOX_INSET_STEP = 12

export interface GroupBoxLayerProps {
  /** Single-click a tab = select all members; double-click = focus the group (S4/S5). */
  onTabClick?: (groupId: string) => void
  onTabDoubleClick?: (groupId: string) => void
}

export function GroupBoxLayer({ onTabClick, onTabDoubleClick }: GroupBoxLayerProps): ReactElement {
  const groups = useCanvasStore((s) => s.groups)
  const boards = useCanvasStore((s) => s.boards)
  // React Flow's live camera transform [x, y, zoom]; the layer is positioned in flow space.
  const [tx, ty, zoom] = useStore((s) => s.transform)

  const boxes = useMemo(
    () =>
      computeGroupBoxes(groups, boards, { pad: GROUP_BOX_PAD, insetStep: GROUP_BOX_INSET_STEP }),
    [groups, boards]
  )

  return (
    <div
      className="group-box-layer"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        // Match the React Flow viewport transform so boxes track the camera 1:1.
        transform: `translate(${tx}px, ${ty}px) scale(${zoom})`,
        transformOrigin: '0 0',
        zIndex: 0
      }}
    >
      {boxes.map((b) => (
        <div
          key={b.id}
          className="group-box"
          style={{ position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h }}
        >
          <button
            type="button"
            className="group-box-tab"
            style={{ pointerEvents: 'auto' }}
            onClick={() => onTabClick?.(b.id)}
            onDoubleClick={() => onTabDoubleClick?.(b.id)}
            title={b.name}
          >
            {b.name}
          </button>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Add the styles**

In `src/renderer/src/index.css`, add:

```css
/* Named board groups — outline box + name tab (S2). Outline only; one accent. */
.group-box {
  border: 1.5px solid var(--accent-wash);
  border-radius: var(--r-ctl);
  pointer-events: none;
}
.group-box-tab {
  position: absolute;
  top: -11px;
  left: 10px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 8px;
  font-size: 11px;
  font-family: var(--ui);
  color: var(--text-2);
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  border-radius: 5px;
  cursor: pointer;
}
.group-box-tab:hover {
  color: var(--accent);
  border-color: var(--accent-wash);
}
```

- [ ] **Step 3: Mount the layer in the canvas**

In `Canvas.tsx`, import the layer (with the other canvas imports near line 70):

```ts
import { GroupBoxLayer } from './GroupBoxLayer'
```

Mount it inside `<ReactFlow>`, right after `<FadingDots />` (line 730) and before `<BrowserPreviewLayer ... />`:

```tsx
            <FadingDots />
            <GroupBoxLayer />
```

- [ ] **Step 4: Run the gate + manual check**

Run: `pnpm typecheck && pnpm lint && pnpm test --run`
Then `pnpm dev`: seed a group (DevTools console: `window` store, or temporarily add two boards and call `useCanvasStore.getState().addGroup('Auth', [<id1>,<id2>])`) → an outline box with an "Auth" tab frames the two boards and tracks the camera on pan/zoom.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/canvas/GroupBoxLayer.tsx src/renderer/src/canvas/Canvas.tsx src/renderer/src/index.css
git commit -F - <<'EOF'
feat(groups): GroupBoxLayer renders outline boxes + name tabs, camera-tracked
EOF
```

---

# SLICE S3 — Create + name

### Task 3.1: `nextGroupName` helper + `Ctrl+G` key action

**Files:**
- Modify: `src/renderer/src/lib/groupBoxes.ts` (co-locate the small naming helper) OR create `src/renderer/src/lib/groupName.ts`. **Use** `src/renderer/src/lib/groupName.ts`.
- Create: `src/renderer/src/lib/groupName.ts`
- Test: `src/renderer/src/lib/groupName.test.ts`
- Modify: `src/renderer/src/canvas/hooks/useCanvasKeybindings.ts`
- Test: `src/renderer/src/canvas/hooks/useCanvasKeybindings.test.ts` (the resolver test file)

- [ ] **Step 1: Write the failing tests**

`src/renderer/src/lib/groupName.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { nextGroupName } from './groupName'

describe('nextGroupName', () => {
  it('returns Group 1 for no groups', () => {
    expect(nextGroupName([])).toBe('Group 1')
  })
  it('skips taken ordinals', () => {
    expect(nextGroupName([{ id: 'a', name: 'Group 1', boardIds: [] }])).toBe('Group 2')
  })
  it('fills the lowest free ordinal', () => {
    expect(
      nextGroupName([
        { id: 'a', name: 'Group 1', boardIds: [] },
        { id: 'b', name: 'Group 3', boardIds: [] }
      ])
    ).toBe('Group 2')
  })
})
```

In `useCanvasKeybindings.test.ts`, add resolver cases:

```ts
it('Ctrl/Cmd+G resolves to group (not while typing)', () => {
  expect(resolveCanvasKeyAction(chord({ key: 'g', ctrlKey: true }), notTyping)).toEqual({
    kind: 'group'
  })
  expect(resolveCanvasKeyAction(chord({ key: 'g', ctrlKey: true }), typing)).toBeNull()
})

it('bare f resolves to focusGroup when a bare key is allowed', () => {
  expect(resolveCanvasKeyAction(chord({ key: 'f' }), bareAllowed)).toEqual({ kind: 'focusGroup' })
  expect(resolveCanvasKeyAction(chord({ key: 'f' }), notBareAllowed)).toBeNull()
})
```

(Reuse the file's existing `chord`/context helpers; mirror the names used by the `tidy`/`fit` resolver tests — `typing`, `notTyping`, `bareAllowed`, `notBareAllowed`. If those helpers are named differently, match the file's convention.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- groupName.test useCanvasKeybindings.test --run`
Expected: FAIL — `nextGroupName` missing; resolver returns null for g/f.

- [ ] **Step 3: Implement**

`src/renderer/src/lib/groupName.ts`:

```ts
/** Auto-name for a new group: the lowest free "Group N". Pure. */
import type { NamedGroup } from './boardSchema'

export function nextGroupName(groups: NamedGroup[]): string {
  const taken = new Set(groups.map((g) => g.name))
  let n = 1
  while (taken.has(`Group ${n}`)) n++
  return `Group ${n}`
}
```

In `useCanvasKeybindings.ts`, extend the action union (lines 29-36):

```ts
export type CanvasKeyAction =
  | { kind: 'undo' }
  | { kind: 'redo' }
  | { kind: 'clearSelection' }
  | { kind: 'toggleDiag' }
  | { kind: 'fit' }
  | { kind: 'reset' }
  | { kind: 'tidy' }
  | { kind: 'group' }
  | { kind: 'focusGroup' }
```

In `resolveCanvasKeyAction` (after the undo/redo block, before the Escape line ~57):

```ts
  // Ctrl/⌘+G groups the current selection (no Alt — that's a different chord). Wins over the
  // bare-key chain like undo/redo do. Guarded against firing while typing in a field.
  if (mod && k === 'g' && !e.shiftKey && !typing) return { kind: 'group' }
```

And add the bare focus key alongside `1`/`0`/`t` (after the `t` line ~61):

```ts
  if (k === 'f' && bareKeyAllowed && !e.ctrlKey && !e.metaKey && !e.altKey)
    return { kind: 'focusGroup' }
```

Add the deps + dispatch to the hook. Extend `CanvasKeybindingDeps` (interface around line 65):

```ts
  groupSelection: () => void
  focusGroup: () => void
```

Destructure them (line 83-98) and add the dispatch cases in the main keymap switch (after the `tidy` case ~161):

```ts
        case 'group':
          e.preventDefault()
          groupSelection()
          break
        case 'focusGroup':
          focusGroup()
          break
```

Add `groupSelection`, `focusGroup` to the effect's dependency array (line 166).

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- groupName.test useCanvasKeybindings.test --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/groupName.ts src/renderer/src/lib/groupName.test.ts src/renderer/src/canvas/hooks/useCanvasKeybindings.ts src/renderer/src/canvas/hooks/useCanvasKeybindings.test.ts
git commit -F - <<'EOF'
feat(groups): nextGroupName helper + Ctrl+G (group) / f (focusGroup) key actions
EOF
```

### Task 3.2: `GroupNamePopover` (inline name editor)

**Files:**
- Create: `src/renderer/src/canvas/GroupNamePopover.tsx`

(No standalone unit test — it's a small controlled-input popover verified via the S3 create flow + e2e. The logic it owns — Enter commits, Esc cancels — is trivial and covered by the create-flow e2e in Task 3.3 Step 5.)

- [ ] **Step 1: Implement the component**

Create `src/renderer/src/canvas/GroupNamePopover.tsx`:

```tsx
/**
 * A small floating text input to (re)name a group, anchored at a client-space point. Mirrors the
 * TerminalConfig inline-popover discipline: controlled value, focus ring, Enter commits, Esc
 * cancels, stopPropagation on keydown so the canvas keymap (Ctrl+G/f/Esc) doesn't fire while
 * typing. Calls setMenuOpen so a live Browser board detaches and can't paint over it (ADR 0002).
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { usePreviewStore } from '../store/previewStore'

export interface GroupNamePopoverProps {
  /** Initial text (auto-name for create; current name for rename). */
  initial: string
  /** Client-space anchor (top-left of the input). */
  at: { x: number; y: number }
  onCommit: (name: string) => void
  onCancel: () => void
}

export function GroupNamePopover({
  initial,
  at,
  onCommit,
  onCancel
}: GroupNamePopoverProps): ReactElement {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  const token = useId()
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)

  useEffect(() => {
    setMenuOpen(token, true)
    return () => setMenuOpen(token, false)
  }, [token, setMenuOpen])

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = (): void => {
    const name = value.trim()
    if (name) onCommit(name)
    else onCancel()
  }

  return createPortal(
    <div
      className="group-name-pop"
      style={{ position: 'fixed', top: at.y, left: at.x, zIndex: 250 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        ref={inputRef}
        className="group-name-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') commit()
          else if (e.key === 'Escape') onCancel()
        }}
        onBlur={commit}
        placeholder="Group name"
      />
    </div>,
    document.body
  )
}
```

Add styles to `index.css`:

```css
.group-name-pop {
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-ctl);
  box-shadow: var(--shadow-pop);
  padding: 6px;
}
.group-name-input {
  width: 180px;
  height: 28px;
  padding: 0 8px;
  font-size: 12.5px;
  font-family: var(--ui);
  color: var(--text);
  background: var(--inset);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  outline: none;
}
.group-name-input:focus {
  border-color: var(--accent);
}
```

- [ ] **Step 2: Run the gate**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/canvas/GroupNamePopover.tsx src/renderer/src/index.css
git commit -F - <<'EOF'
feat(groups): GroupNamePopover inline name editor (Enter commit, Esc cancel)
EOF
```

### Task 3.3: Floating "Group" button + wire the create flow

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx`
- Test (e2e): `tests/e2e/groups.spec.ts`

- [ ] **Step 1: Wire the create handler + popover state in `CanvasInner`**

In `Canvas.tsx`, add store reads (near line 112):

```ts
  const addGroup = useCanvasStore((s) => s.addGroup)
```

Add local state for the name popover (near the other `useState`s ~134):

```ts
  // Group create/rename: the inline name popover (anchored in client space) + the group whose
  // name it is editing (null = closed). Ephemeral.
  const [namingGroupId, setNamingGroupId] = useState<string | null>(null)
  const [namePopAt, setNamePopAt] = useState<{ x: number; y: number } | null>(null)
```

Add the create action (after `addCentered`, ~426):

```ts
  // Create a group from the current multi-selection (>=2 boards). Mints the group with an
  // auto-name, then opens the inline name popover over the selection's top-left so the user can
  // rename immediately (Esc keeps the auto-name). No-op for <2 selected.
  const groupSelection = useCallback(() => {
    const st = useCanvasStore.getState()
    const ids = st.selectedIds
    if (ids.length < 2) return
    const name = nextGroupName(st.groups)
    const gid = st.addGroup(name, ids)
    // Anchor the popover at the selection's top-left in client space.
    const sel = st.boards.filter((b) => ids.includes(b.id))
    const bb = boardsBounds(sel)
    if (bb) {
      const p = rf.flowToScreenPosition({ x: bb.minX, y: bb.minY })
      setNamePopAt({ x: p.x, y: Math.max(8, p.y - 40) })
      setNamingGroupId(gid)
    }
  }, [rf])
```

Add the imports (near line 52 / 73):

```ts
import { boardsBounds } from '../lib/boardGeometry'   // already imported snapOthers from here — add boardsBounds to that import
import { nextGroupName } from '../lib/groupName'
```

(Note: `snapOthers` is already imported from `../lib/boardGeometry` at line 52 — extend that import to `{ snapOthers, boardsBounds }`.)

Add `renameGroup` read for the popover commit:

```ts
  const renameGroup = useCanvasStore((s) => s.renameGroup)
```

- [ ] **Step 2: Pass `groupSelection` into the keybindings hook**

In the `useCanvasKeybindings({ ... })` call (lines 629-644), add:

```ts
    groupSelection,
    focusGroup,   // defined in Slice S4; for S3 commit, pass a no-op placeholder: () => {}
```

For the S3 commit, define a temporary `focusGroup` no-op above the hook call so the build is green; S4 replaces it:

```ts
  const focusGroup = useCallback(() => {}, [])
```

- [ ] **Step 3: Render the floating button + the name popover**

In the return JSX, after the `<EmptyState>`/`<AppChrome>` block (~805), add the floating button (shown only when 2+ selected) and the name popover:

```tsx
          {selectedIds.length >= 2 && (
            <button className="group-fab" onClick={groupSelection} title="Group selection (Ctrl+G)">
              <span style={{ fontFamily: 'var(--mono)' }}>⌘G</span> Group {selectedIds.length}
            </button>
          )}
          {namingGroupId && namePopAt && (
            <GroupNamePopover
              initial={
                useCanvasStore.getState().groups.find((g) => g.id === namingGroupId)?.name ?? ''
              }
              at={namePopAt}
              onCommit={(name) => {
                renameGroup(namingGroupId, name)
                setNamingGroupId(null)
                setNamePopAt(null)
              }}
              onCancel={() => {
                setNamingGroupId(null)
                setNamePopAt(null)
              }}
            />
          )}
```

Import the popover (near line 73): `import { GroupNamePopover } from './GroupNamePopover'`.

Add the FAB style to `index.css`:

```css
.group-fab {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 14px;
  font-size: 12.5px;
  font-family: var(--ui);
  color: var(--accent);
  background: var(--surface-raised);
  border: 1px solid var(--accent-wash);
  border-radius: 9px;
  box-shadow: var(--shadow-pop);
  cursor: pointer;
}
.group-fab:hover {
  background: var(--accent-wash);
}
```

- [ ] **Step 4: Run the gate**

Run: `pnpm typecheck && pnpm lint && pnpm test --run`
Expected: PASS.

- [ ] **Step 5: Write + run an e2e for the create flow**

Create `tests/e2e/groups.spec.ts` (match the existing e2e harness — `_electron` launch + the `?e2e=1` seeded boards; mirror an existing spec's setup boilerplate, e.g. `tests/e2e/canvas.spec.ts`):

```ts
import { test, expect } from '@playwright/test'
import { launchSeeded } from './helpers' // reuse the repo's existing launch helper

test('Ctrl+G groups the selected boards and shows the box tab', async () => {
  const { page, app } = await launchSeeded()
  try {
    // Select two seeded boards via the store hook, then trigger group (real keypress).
    await page.evaluate(() => {
      const ids = (window as any).useCanvasStore.getState().boards.slice(0, 2).map((b: any) => b.id)
      ;(window as any).useCanvasStore.getState().setSelection(ids)
    })
    await page.keyboard.press('Control+g')
    // A group now exists with both boards.
    const count = await page.evaluate(
      () => (window as any).useCanvasStore.getState().groups.length
    )
    expect(count).toBe(1)
    await expect(page.locator('.group-box-tab')).toHaveCount(1)
  } finally {
    await app.close()
  }
})
```

> If the store isn't exposed on `window` in e2e, expose it under the existing `?e2e=1` guard (mirror how `e2eHooks.ts` exposes test handles) rather than reaching into internals. Keep it behind `isE2E()`.

Run: `pnpm test:e2e -- groups.spec`
Expected: PASS (the pre-commit matrix will also run it).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/Canvas.tsx src/renderer/src/index.css tests/e2e/groups.spec.ts
git commit -F - <<'EOF'
feat(groups): Ctrl+G / floating button create a group from the selection + inline name
EOF
```

---

# SLICE S4 — Grouped focus

### Task 4.1: `GroupFocusPicker` (TidyMenu-style popover)

**Files:**
- Create: `src/renderer/src/canvas/GroupFocusPicker.tsx`

- [ ] **Step 1: Implement the picker**

Create `src/renderer/src/canvas/GroupFocusPicker.tsx` (clone of the `TidyMenu` popover discipline — portal, viewport-clamp, outside-pointerdown/Esc close, `setMenuOpen` token):

```tsx
/**
 * "Which group?" picker shown when focus is triggered with more than one group. Clones the
 * TidyMenu popover discipline (AppChrome): portaled to <body>, detaches live Browser views via
 * setMenuOpen (ADR 0002), closes on outside pointerdown / Escape. One row per group; choosing one
 * calls onPick. Anchored at a client-space point (the focus key has no DOM anchor, so it's centered
 * near the top by the caller).
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { usePreviewStore } from '../store/previewStore'
import type { NamedGroup } from '../lib/boardSchema'

export interface GroupFocusPickerProps {
  groups: NamedGroup[]
  /** Client-space anchor (top-center) where the picker opens. */
  at: { x: number; y: number }
  onPick: (groupId: string) => void
  onClose: () => void
}

export function GroupFocusPicker({
  groups,
  at,
  onPick,
  onClose
}: GroupFocusPickerProps): ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: -9999, left: -9999 })
  const token = useId()
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)

  useEffect(() => {
    setMenuOpen(token, true)
    return () => setMenuOpen(token, false)
  }, [token, setMenuOpen])

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [onClose])

  useLayoutEffect(() => {
    const m = menuRef.current?.getBoundingClientRect()
    if (!m) return
    const PAD = 8
    const left = Math.max(PAD, Math.min(at.x - m.width / 2, window.innerWidth - m.width - PAD))
    setPos({ top: at.y, left })
  }, [at])

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="group-pick-pop"
      style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 250 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="group-pick-head">Focus group</div>
      {groups.map((g) => (
        <button
          key={g.id}
          role="menuitem"
          className="group-pick-row"
          onClick={() => onPick(g.id)}
        >
          <span className="group-pick-name">{g.name}</span>
          <span className="group-pick-count">{g.boardIds.length}</span>
        </button>
      ))}
    </div>,
    document.body
  )
}
```

Add styles to `index.css`:

```css
.group-pick-pop {
  min-width: 200px;
  padding: 6px;
  background: var(--surface-overlay);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-ctl);
  box-shadow: var(--shadow-pop);
}
.group-pick-head {
  padding: 2px 6px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--text-3);
}
.group-pick-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 6px 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: none;
  color: var(--text);
  font-size: 12.5px;
  font-family: var(--ui);
  cursor: pointer;
}
.group-pick-row:hover {
  background: var(--accent-wash);
  border-color: var(--accent-wash);
}
.group-pick-count {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
}
```

- [ ] **Step 2: Run the gate**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/canvas/GroupFocusPicker.tsx src/renderer/src/index.css
git commit -F - <<'EOF'
feat(groups): GroupFocusPicker popover (which-group chooser)
EOF
```

### Task 4.2: Pure `groupFocusNodes` (member nodes + raster cap)

**Files:**
- Modify: `src/renderer/src/lib/groupBoxes.ts`
- Test: `src/renderer/src/lib/groupBoxes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { groupFitMaxZoom } from './groupBoxes'
import type { Board } from './boardSchema'

describe('groupFitMaxZoom', () => {
  const mk = (id: string, type: Board['type']): Board =>
    ({ id, type, x: 0, y: 0, w: 300, h: 200, title: 't' }) as Board

  it('caps at 1 when any member is terminal or browser (raster)', () => {
    expect(groupFitMaxZoom([mk('a', 'planning'), mk('b', 'terminal')], 2.5)).toBe(1)
    expect(groupFitMaxZoom([mk('a', 'browser')], 2.5)).toBe(1)
  })
  it('returns the vector cap when all members are planning', () => {
    expect(groupFitMaxZoom([mk('a', 'planning'), mk('b', 'planning')], 2.5)).toBe(2.5)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test -- groupBoxes.test --run`
Expected: FAIL — `groupFitMaxZoom` missing.

- [ ] **Step 3: Implement**

Append to `groupBoxes.ts`:

```ts
import type { Board } from './boardSchema'

/**
 * The fitView maxZoom for a group: capped at 1 when ANY member is a raster board
 * (terminal/browser bitmap content blurs when upscaled past 100%), else the vector cap.
 * Generalizes the single-board focus rule in Canvas.focusBoard.
 */
export function groupFitMaxZoom(members: Board[], vectorMax: number): number {
  const anyRaster = members.some((b) => b.type === 'terminal' || b.type === 'browser')
  return anyRaster ? 1 : vectorMax
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm test -- groupBoxes.test --run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/groupBoxes.ts src/renderer/src/lib/groupBoxes.test.ts
git commit -F - <<'EOF'
feat(groups): groupFitMaxZoom — raster cap for mixed-member group focus
EOF
```

### Task 4.3: Wire the focus flow + camera-cluster button

**Files:**
- Modify: `src/renderer/src/canvas/Canvas.tsx`
- Modify: `src/renderer/src/canvas/AppChrome.tsx`
- Test (e2e): `tests/e2e/groups.spec.ts`

- [ ] **Step 1: Implement `focusGroup` in `CanvasInner`**

Replace the S3 placeholder `const focusGroup = useCallback(() => {}, [])` with the real one (and add picker state). Add state near the naming state:

```ts
  // Grouped focus: when >1 group exists the focus action opens this picker (anchored top-center);
  // null = closed. The actual camera fit is in `fitGroup`.
  const [pickerAt, setPickerAt] = useState<{ x: number; y: number } | null>(null)
```

Add the fit helper + the focus entry point:

```ts
  // Fit the camera to one group's member boards (raster-capped). Mirrors focusBoard but over
  // the whole member set; exits dim-focus so others aren't left dimmed.
  const fitGroup = useCallback(
    (groupId: string) => {
      const st = useCanvasStore.getState()
      const g = st.groups.find((x) => x.id === groupId)
      if (!g) return
      const members = st.boards.filter((b) => g.boardIds.includes(b.id))
      if (members.length === 0) return
      setFocusedId(null)
      const maxZoom = groupFitMaxZoom(members, Z_MAX)
      void rf.fitView(
        cameraAnim({ ...FOCUS_OPTIONS, maxZoom, nodes: members.map((b) => ({ id: b.id })) })
      )
    },
    [rf]
  )

  // Focus action (key `f` + camera-cluster button + tab double-click): 0 groups → no-op,
  // 1 group → fit it directly, >1 → open the picker anchored top-center.
  const focusGroup = useCallback(() => {
    const st = useCanvasStore.getState()
    if (st.groups.length === 0) return
    if (st.groups.length === 1) {
      fitGroup(st.groups[0].id)
      return
    }
    const el = paneRef.current
    const r = el?.getBoundingClientRect()
    setPickerAt({ x: (r ? r.left + r.width / 2 : window.innerWidth / 2), y: (r?.top ?? 0) + 56 })
  }, [fitGroup])
```

Add imports: `groupFitMaxZoom` from `../lib/groupBoxes`, and `Z_MAX` is already imported (line 43).

```ts
import { computeGroupBoxes, groupFitMaxZoom } from '../lib/groupBoxes'  // if GroupBoxLayer owns computeGroupBoxes import, only add groupFitMaxZoom here
```

- [ ] **Step 2: Render the picker + wire the GroupBoxLayer tab double-click**

Update the `<GroupBoxLayer />` mount to pass tab handlers:

```tsx
            <GroupBoxLayer onTabClick={selectGroupMembers} onTabDoubleClick={fitGroup} />
```

Add `selectGroupMembers` (tab single-click selects all members — also used by S5):

```ts
  const selectGroupMembers = useCallback((groupId: string) => {
    const st = useCanvasStore.getState()
    const g = st.groups.find((x) => x.id === groupId)
    if (g) st.setSelection(g.boardIds)
  }, [])
```

Render the picker (after the name popover block):

```tsx
          {pickerAt && (
            <GroupFocusPicker
              groups={groups}
              at={pickerAt}
              onPick={(id) => {
                setPickerAt(null)
                fitGroup(id)
              }}
              onClose={() => setPickerAt(null)}
            />
          )}
```

Add `groups` read + imports:

```ts
  const groups = useCanvasStore((s) => s.groups)
```
```ts
import { GroupFocusPicker } from './GroupFocusPicker'
```

- [ ] **Step 3: Add the camera-cluster focus button**

In `AppChrome.tsx`, extend `AppChromeProps` + thread an `onFocusGroup` callback from Canvas. In `Canvas.tsx` the `<AppChrome onTidy={tidyAndFit} />` (line 805) becomes:

```tsx
          <AppChrome onTidy={tidyAndFit} onFocusGroup={focusGroup} />
```

In `AppChrome.tsx`:
- Add to `AppChromeProps`: `onFocusGroup: () => void`.
- Pass it through `AppChrome` → `CameraCluster`.
- Add a `ToolBtn` in the cluster pill (after the Overview button, ~line 209), gated on group existence:

```tsx
        <FocusGroupBtn onFocusGroup={onFocusGroup} />
```

Add the small component (near `TidyMenu`):

```tsx
// Focus-a-group button — enabled only when >=1 group exists. Opens the picker (or fits directly
// when there's exactly one) via the Canvas-provided handler.
function FocusGroupBtn({ onFocusGroup }: { onFocusGroup: () => void }): ReactElement {
  const groupCount = useCanvasStore((s) => s.groups.length)
  if (groupCount === 0) return <></>
  return <ToolBtn name="focus" title="Focus group (F)" onClick={onFocusGroup} />
}
```

> **Icon note:** reuse an existing `IconName` for the focus button (e.g. `"fit"` or `"overview"`) if no `"focus"` glyph exists in `Icon.tsx` — check `IconName` and pick the closest existing glyph rather than adding a new SVG. Update the `name=` accordingly.

- [ ] **Step 4: Run the gate**

Run: `pnpm typecheck && pnpm lint && pnpm test --run`
Expected: PASS.

- [ ] **Step 5: Extend the e2e**

Add to `tests/e2e/groups.spec.ts`:

```ts
test('focus fits one group directly and shows the picker for many', async () => {
  const { page, app } = await launchSeeded()
  try {
    await page.evaluate(() => {
      const st = (window as any).useCanvasStore.getState()
      const ids = st.boards.map((b: any) => b.id)
      st.addGroup('Auth', ids.slice(0, 2))
    })
    // exactly one group → f fits directly, no picker
    await page.keyboard.press('f')
    await expect(page.locator('.group-pick-pop')).toHaveCount(0)
    // add a second group → f opens the picker
    await page.evaluate(() => {
      const st = (window as any).useCanvasStore.getState()
      st.addGroup('API', st.boards.map((b: any) => b.id).slice(2, 4))
    })
    await page.keyboard.press('f')
    await expect(page.locator('.group-pick-pop')).toHaveCount(1)
  } finally {
    await app.close()
  }
})
```

Run: `pnpm test:e2e -- groups.spec`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/Canvas.tsx src/renderer/src/canvas/AppChrome.tsx tests/e2e/groups.spec.ts
git commit -F - <<'EOF'
feat(groups): grouped focus — f / camera-cluster button / tab dbl-click + which-group picker
EOF
```

---

# SLICE S5 — Tab interactions + manage

### Task 5.1: Tab right-click menu (rename / focus / add-selected / remove)

**Files:**
- Modify: `src/renderer/src/canvas/GroupBoxLayer.tsx`
- Modify: `src/renderer/src/canvas/Canvas.tsx`

- [ ] **Step 1: Add a context-menu handler prop to the tab**

In `GroupBoxLayer.tsx`, extend `GroupBoxLayerProps`:

```ts
  onTabContextMenu?: (groupId: string, at: { x: number; y: number }) => void
```

On the `.group-box-tab` button add:

```tsx
            onContextMenu={(e) => {
              e.preventDefault()
              onTabContextMenu?.(b.id, { x: e.clientX, y: e.clientY })
            }}
```

- [ ] **Step 2: Implement a small group context menu in Canvas**

Add state + handler in `CanvasInner`:

```ts
  const [groupMenu, setGroupMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(
    null
  )
  const removeGroup = useCanvasStore((s) => s.removeGroup)
  const addBoardsToGroup = useCanvasStore((s) => s.addBoardsToGroup)
```

Wire the layer:

```tsx
            <GroupBoxLayer
              onTabClick={selectGroupMembers}
              onTabDoubleClick={fitGroup}
              onTabContextMenu={(id, at) => setGroupMenu({ id, at })}
            />
```

Render the menu (a minimal portal popover, same discipline as the picker). Add after the picker block:

```tsx
          {groupMenu && (
            <GroupContextMenu
              at={groupMenu.at}
              hasSelection={selectedIds.length > 0}
              onRename={() => {
                const g = useCanvasStore.getState().groups.find((x) => x.id === groupMenu.id)
                if (g) {
                  setNamePopAt(groupMenu.at)
                  setNamingGroupId(groupMenu.id)
                }
                setGroupMenu(null)
              }}
              onFocus={() => {
                fitGroup(groupMenu.id)
                setGroupMenu(null)
              }}
              onAddSelected={() => {
                addBoardsToGroup(groupMenu.id, useCanvasStore.getState().selectedIds)
                setGroupMenu(null)
              }}
              onRemove={() => {
                removeGroup(groupMenu.id)
                setGroupMenu(null)
              }}
              onClose={() => setGroupMenu(null)}
            />
          )}
```

- [ ] **Step 3: Implement the `GroupContextMenu` component**

Create `src/renderer/src/canvas/GroupContextMenu.tsx`:

```tsx
/**
 * Right-click menu for a group's name tab: Rename, Focus, Add selected boards, Remove group.
 * Same popover discipline as GroupFocusPicker (portal, outside-pointerdown/Esc close, setMenuOpen).
 */
import { useEffect, useId, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { usePreviewStore } from '../store/previewStore'

export interface GroupContextMenuProps {
  at: { x: number; y: number }
  hasSelection: boolean
  onRename: () => void
  onFocus: () => void
  onAddSelected: () => void
  onRemove: () => void
  onClose: () => void
}

export function GroupContextMenu(props: GroupContextMenuProps): ReactElement {
  const { at, hasSelection, onRename, onFocus, onAddSelected, onRemove, onClose } = props
  const token = useId()
  const setMenuOpen = usePreviewStore((s) => s.setMenuOpen)

  useEffect(() => {
    setMenuOpen(token, true)
    return () => setMenuOpen(token, false)
  }, [token, setMenuOpen])

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <div
      role="menu"
      className="group-ctx"
      style={{ position: 'fixed', top: at.y, left: at.x, zIndex: 250 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button role="menuitem" className="group-ctx-row" onClick={onRename}>
        Rename
      </button>
      <button role="menuitem" className="group-ctx-row" onClick={onFocus}>
        Focus
      </button>
      <button
        role="menuitem"
        className="group-ctx-row"
        disabled={!hasSelection}
        onClick={onAddSelected}
      >
        Add selected boards
      </button>
      <div className="group-ctx-divider" />
      <button role="menuitem" className="group-ctx-row group-ctx-danger" onClick={onRemove}>
        Remove group
      </button>
    </div>,
    document.body
  )
}
```

Import it in Canvas: `import { GroupContextMenu } from './GroupContextMenu'`.

Add styles to `index.css`:

```css
.group-ctx {
  min-width: 170px;
  padding: 5px;
  background: var(--surface-overlay);
  border: 1px solid var(--border-subtle);
  border-radius: var(--r-ctl);
  box-shadow: var(--shadow-pop);
}
.group-ctx-row {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 8px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--text);
  font-size: 12.5px;
  font-family: var(--ui);
  cursor: pointer;
}
.group-ctx-row:hover:not(:disabled) {
  background: var(--accent-wash);
}
.group-ctx-row:disabled {
  color: var(--text-faint);
  cursor: default;
}
.group-ctx-danger {
  color: #e5484d;
}
.group-ctx-divider {
  height: 1px;
  margin: 4px 0;
  background: var(--border-subtle);
}
```

- [ ] **Step 4: Run the gate**

Run: `pnpm typecheck && pnpm lint && pnpm test --run`
Expected: PASS.

- [ ] **Step 5: Manual verification**

`pnpm dev`: create a group; right-click its tab → Rename opens the inline editor; Focus fits; select another board then Add selected adds it (box grows); Remove deletes the box (boards remain). Single-click tab selects all members; double-click focuses.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/canvas/GroupBoxLayer.tsx src/renderer/src/canvas/GroupContextMenu.tsx src/renderer/src/canvas/Canvas.tsx src/renderer/src/index.css
git commit -F - <<'EOF'
feat(groups): name-tab handle — click selects members, dbl-click focuses, right-click menu
EOF
```

### Task 5.2: Final integration sweep + spec sign-off

**Files:**
- Modify: `docs/superpowers/specs/2026-06-06-named-board-groups-design.md` (mark shipped slices)

- [ ] **Step 1: Run the full local matrix**

Run: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test --run && pnpm test:e2e`
Expected: all green (memory: the `browser`/`browser-gesture`/`focus-detach` trio can env-flake — rerun e2e once for a clean pass; it's not a regression).

- [ ] **Step 2: Verify the spec's acceptance criteria**

Confirm each S-slice checkpoint in the spec is met: persist+reload groups (S1), boxes track members + nest (S2), Ctrl+G create + name (S3), focus picker (S4), manage (S5). Tick them in the spec.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-06-named-board-groups-design.md
git commit -F - <<'EOF'
docs(groups): mark S0-S5 shipped in the design spec
EOF
```

- [ ] **Step 4: Finish the branch**

Invoke `superpowers:finishing-a-development-branch` to choose merge/PR. The merge gate is CI (`check` job) + the local pre-commit e2e matrix; merge into `main` sequentially per CLAUDE.md (rebrand `#17` still merges LAST).

---

## Self-review (run by the plan author)

**Spec coverage:**
- Decision 1 (multi-membership) → S0 + S1 (`boardIds[]`, no exclusivity). ✓
- Decision 2 (dedicated focus trigger) → S4 (key `f` + camera-cluster button + tab dbl-click). ✓
- Decision 3/5 (visible selection box, name tab, nested-inset overlap) → S2. ✓
- Decision 4 (keep named-empty) → S1 `reconcileGroups` keeps empty groups; removeGroup is explicit-only. ✓
- Decision 6 (tracked undo) → S1.4 widened snapshot. ✓
- Decision 7 (top-level `groups[]`) → S1.1. ✓
- Decision 8 (Ctrl+G, ≥2) → S3 (`groupSelection` no-op <2; FAB shown at ≥2). ✓
- Decision 9 (tab handle: click/dbl/rename/right-click) → S5 + S4 (dbl-click focus). ✓
- Risk: v6 collision w/ Diagram #72 → noted in S1.1 comment + commit. ✓
- Risk: never serialize selection → selection stays ephemeral (S0); groups read at commit (S3). ✓
- Risk: undo phantom-step → `sameSnapshot`/`lastRecorded`/`trackedChange` all include `groups` (S1.4). ✓
- Risk: delete consistency (2 layers) → `removeBoard` sweep (S1.6) + `reconcileGroups` (S1.2). ✓
- Risk: raster cap → `groupFitMaxZoom` (S4.2). ✓
- Risk: ADR-0002 occlusion → popovers call `setMenuOpen`; box is decoration (S2/S3/S4/S5). ✓
- Risk: MCP "groups not published" gap → no MCP touch; documented in the spec (carry an ADR note at merge). ✓

**Placeholder scan:** the S3 `focusGroup` no-op is an INTENTIONAL temporary (replaced in S4.3) and is flagged as such — not a plan placeholder. No "TBD"/"add error handling"-style gaps.

**Type consistency:** `NamedGroup`, `selectedIds`, `groups`, `computeGroupBoxes`/`groupFitMaxZoom`, `nextGroupName`, the `{kind:'group'}`/`{kind:'focusGroup'}` actions, and `trackedChange`'s new `opts.selection` are used identically across tasks. The `trackedChange` signature change (`opts.selectedId` → `opts.selection`) updates all three callers in the same task (S1.4).

**Scope:** one feature, six small slices, each runnable + committed. Good for a single execution pass.

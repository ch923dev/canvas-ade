# VS Code's file tree, and the canvas twist: spawn many file boards

> Research + design proposal for the next file-tree slice (S6-candidate). Worktree
> `feat/file-tree-s3`. Date 2026-06-20. **Status: design artifact awaiting sign-off — no code yet.**

## 0. The one-paragraph thesis

VS Code's entire file UX is shaped by one constraint: there is **a single editor surface**.
Preview tabs, editor groups, the Open Editors view, tab pinning — every one of those mechanisms
exists to *ration that one surface*. Our canvas deletes the constraint: space is infinite and every
file can be its own persistent **board**. So the twist is **not** to port VS Code's tab machinery —
it's to take the *intent* behind each mechanism and re-express it spatially. The headline that makes
"spawn many boards" usable instead of chaotic is VS Code's **preview-tab discipline**: a single
reusable *peek* board for browsing, and an explicit *pin* gesture that promotes it to a permanent
board.

---

## 1. How VS Code's file tree actually works

### 1.1 The widget stack (composition, not inheritance)

VS Code's tree is built up in layers, each adding one capability over the one below
([Lists-And-Trees wiki](https://github.com/microsoft/vscode/wiki/Lists-And-Trees)):

```
List                 virtual renderer: only visible rows are in the DOM
 └ IndexTree         maps hierarchy onto the flat List via multi-dim splice(start: number[])
    └ ObjectTree     element-addressed: setChildren(element, children) instead of index paths
       └ DataTree    lazy: IDataSource.hasChildren() + getChildren(): Thenable<T[]>
          └ AsyncDataTree            handles concurrent refreshes, loading spinners
             └ CompressibleAsyncDataTree   ← the File Explorer uses this one
```

**Virtual List.** The base `List<T>` materialises DOM nodes only for visible rows ("100k elements
without breaking a sweat"). It keeps an in-memory height map + viewport position and, on scroll,
computes which rows to insert/remove. Each row's pixel height must be known upfront. Mutation API is
a single `splice(start, deleteCount, toInsert)`.

**Template recycling.** Rows are not created/destroyed as you scroll; a `Renderer` owns a small pool
of row *templates* (`renderTemplate` / `renderElement` / `disposeTemplate`) and the List rebinds
data onto recycled DOM. This is what keeps Collapse-All at 20k items fast (48× speedup vs the old
tree).

**DataSource (lazy).** `DataTree` and up take an `IDataSource<T>` with `hasChildren(element)` and
`getChildren(element): Thenable<T[]>`. A folder reports `hasChildren: true` before it's ever read, so
its twistie shows; expanding it triggers the async `getChildren`. This is exactly lazy directory
listing.

**Compressible variant = compact folders.** `WorkbenchCompressibleAsyncDataTree` renders a chain of
single-child folders as one compressed row (`a / b / c`). `explorer.compactFolders` (default on)
([issue #41627](https://github.com/microsoft/vscode/issues/41627),
[vscode.pro tip 27](https://vscode.pro/tip/27)).

**Identity for stable expansion.** The tree tracks elements by a stable identity so add/remove/refresh
doesn't collapse expanded subtrees.

### 1.2 The Explorer model + file watcher

The `ExplorerModel` / `ExplorerItem` layer sits *above* the tree and owns:

- the **folder working set** + per-folder **file watchers**;
- the **compression state** (whether compact rendering is on);
- listening to file-system change events and **batching refreshes through a `RunOnceScheduler`** so a
  burst of FS events collapses into one UI refresh (not one re-render per event);
- lazy watching — a "lazy watcher scans only the files directly under the current dir, not
  recursively, invoked once a dir is opened"
  ([issue #81473](https://github.com/microsoft/vscode/issues/81473)).

### 1.3 Decorations & sorting

File decorations (git status colour, problems badge, etc.) are a separate provider layer painted onto
rows. Sort is dirs-first then a configurable comparator.

### 1.4 The part that matters most here — how files actually *open*

This is the crux for "spawn many boards." VS Code has **one editor area**, so it invented machinery to
keep that one surface from thrashing:

- **Preview tab.** Single-click in the Explorer opens the file in a *preview* tab — **italic title,
  and it is reused**: the next single-click *replaces* it. `workbench.editor.enablePreview` (default
  on). ([userinterface docs](https://code.visualstudio.com/docs/getstarted/userinterface),
  [issue #43245](https://github.com/microsoft/vscode/issues/43245))
- **Pin = promote.** **Double-click**, **starting to edit**, or right-click **Pin** converts the
  preview tab into a dedicated (bold) tab. From then on, single-clicking another file opens a *new*
  preview tab elsewhere.
- **Editor groups / split.** `Ctrl+\` splits into a new editor group; files tile into a grid. This is
  how you view 2–3 files at once.
- **Open Editors view.** A list at the top of the Explorer of every open editor, grouped — for jumping
  around and for noticing what's open when tabs overflow.

**Why this matters:** preview tabs exist *because* a new tab per click would bury you. On a canvas the
same hazard is a new *board* per click littering the scene. The fix is the same idea, re-expressed.

---

## 2. What we already have (current state)

Mostly-built today on `feat/file-tree-s3` (see the per-file map in the session notes):

| Area | Status |
|---|---|
| Tree engine | `react-arborist@^3.10.5` — **already virtualized** (react-window inside), lazy load on toggle + single-child cascade. |
| Compact folders | ✅ `compactTree()` merges loaded single-child chains into `a / b / c` rows. |
| Tree chrome | ✅ indent guides, file-type glyphs (neutral, one-accent), collapse-all + **Ctrl+Shift+B**, no horizontal scrollbar (ellipsis). |
| File watcher | ✅ chokidar → `file:treeEvent`; tree re-lists affected parent (debounced 250ms). |
| Auto-reveal | ✅ focusing a file board reveals + highlights it in the tree. |
| File board | ✅ CodeMirror 6 dual-mode (view snapshot / live edit on focus), Markdown preview/split/source, save, font stepper, read-only. |
| Open / drag | ✅ tree click → `openFileBoard(path)`; drag a row → canvas drop spawns a board; drop onto a board rebinds it. |
| De-dupe | ✅ `openFileBoard` reuses an existing board **for the same path** (no duplicate). |
| Many boards | ✅ already a first-class board type — no count limit, tidy/tile treat it like any board. |
| Security | ✅ MAIN-side `realResolveWithinRoot` path containment, no-symlink-follow, foreign-sender guard, 64 MiB read cap. |

**So we already "spawn many file boards" mechanically.** What we *don't* have is the **discipline**
that makes browsing-by-clicking tidy, plus the canvas-native expressions of editor-groups and the
Open-Editors view. That's the gap this slice fills.

---

## 3. The gap → the twist

| VS Code mechanism | Why it exists | **Canvas re-expression (the twist)** |
|---|---|---|
| Preview tab (single-click, italic, **reused**) | avoid tab clutter while browsing | **One reusable "peek" board** — single-click rebinds *it* (ghosted chrome), never spawns a 2nd peek |
| Pin (double-click / edit / Pin) | keep a file you care about | **Pin** promotes the peek board to a permanent board; next single-click spawns a fresh peek |
| Editor groups / split editors | see 2–3 files at once | **Free** — boards already tile anywhere, any N; plus multi-select → **spawn a tidy grid** |
| Open Editors view | track/jump to open files | **Open-boards awareness** — tree marks files that already have a board; click the mark = jump camera |
| Reveal active file | locate what you're editing | ✅ already have auto-reveal |

The spine of the slice is three moves:

1. **Peek vs Pin** — the headline. Makes "many boards" *opt-in* instead of accidental. (VS Code parity.)
2. **Spawn many, on purpose** — multi-select rows → *Open N boards* in a tidy grid (the canvas
   superpower VS Code can't do).
3. **Open-boards awareness** — close the loop tree↔canvas (which files are already out there, jump to
   them). (Optional polish; smallest of the three.)

---

## 4. Design (the visible artifact)

### 4.1 Peek vs Pin

```
TREE  (single-click "main.ts")             CANVAS
┌─ FILES ───────┐                          ┌──────────────────────────────────┐
│ ▾ src         │                          │   ╭┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╮              │
│   ▸ lib       │        single-click       │   ┊ main.ts   ·peek· ┊  ← dashed │
│   • main.ts ◀─┼──────────────────────────┼─▶ ┊  [ live editor ]  ┊    ghost  │
│   • app.tsx   │                          │   ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯    chrome     │
│ ▸ docs        │                          │                                    │
└───────────────┘                          └──────────────────────────────────┘

  single-click "app.tsx"   → the SAME peek board rebinds to app.tsx (no new board)
  double-click │ edit │ ⇧-drag-out │ "Pin" → board turns SOLID (pinned); the next
                                              single-click spawns a fresh peek elsewhere
```

- Exactly one peek board exists at a time (an ephemeral, session-only marker — never serialized).
- Peek chrome is visually distinct (dashed border / faded title, the canvas analog of italic).
- A peek board sits where the focused board would (camera already fits it — we have that plumbing).
- Closing has no friction: peek auto-recycles; nothing to clean up.

### 4.2 Spawn many, on purpose

```
TREE  (Ctrl/Shift-select 3 rows → Enter, or ⋯ "Open boards")   CANVAS
┌─ FILES ───────┐                                ┌────────────────────────────────┐
│ ▾ src         │                                │  ┌────────┐ ┌────────┐          │
│   ✓ main.ts   │           Open 3 boards         │  │main.ts │ │app.tsx │          │
│   ✓ app.tsx   │   ─────────────────────────────▶│  └────────┘ └────────┘          │
│   ✓ util.ts   │                                │  ┌────────┐    (tidy grid,        │
│ ▸ docs        │                                │  │util.ts │     reuses Tidy)      │
└───────────────┘                                └────────┘                          │
```

- Multi-select in arborist (Ctrl/Shift) is built in; we add an `Open boards` action (Enter / context
  menu) that spawns one **pinned** board per selected file, laid out with the existing `tidyLayout`.
- De-dupe still applies: files that already have a board are focused, not re-spawned.
- Drag-out of a multi-selection could later drop the whole grid at the cursor (stretch).

### 4.3 Open-boards awareness (optional, smallest)

```
┌─ FILES ───────┐
│ ▾ src         │   ● = a board for this file is already on the canvas
│   ▸ lib       │       click the dot → jump camera to that board (no new board)
│ ● • main.ts   │
│   • app.tsx   │
└───────────────┘
```

- The tree subscribes to the set of file-board paths; rows for open files get a small dot + a
  "go to board" affordance. This is the Open-Editors view, folded into the tree instead of a
  separate panel.

### 4.4 Interaction table (proposed)

| Gesture in tree | Today | **Proposed** |
|---|---|---|
| Single-click file | opens/reuses a persistent per-path board | **peek**: reuse the one peek board (rebind it) |
| Double-click file | (n/a) | **pin** a permanent board (or focus existing) |
| Start editing a peek | (n/a) | auto-**pin** (VS Code parity) |
| Enter on selection | (n/a) | **Open boards** for all selected (pinned grid) |
| ⇧-drag row to canvas | spawns a board | spawns a **pinned** board (unchanged) |
| Click a row's "open" dot | (n/a) | jump camera to the existing board |
| Single-click folder | toggle | toggle (unchanged) |

### 4.5 Non-goals / preserved invariants

- No change to the MAIN-side security model (path containment, foreign-sender, size caps).
- Peek/pin state is **ephemeral** (session-only) — never serialized; respects the scene/session split.
- Compact folders, indent guides, watcher, auto-reveal — unchanged.
- One accent (blue), no rainbow — peek chrome uses opacity/dash, not a new colour.
- Schema: peek is ephemeral, so **no schema bump** unless we choose to persist a `pinned`/`peek` flag
  (recommend: don't — derive peek from a single ephemeral `peekBoardId`).

---

## 5. Open decisions (for sign-off)

1. **Adopt peek/pin?** (changes current single-click behavior) — recommended yes; it's the discipline
   that makes "many boards" pleasant. Alternative: keep today's "single-click = persistent per-path
   board" and only add multi-spawn.
2. **What pins?** Recommended: double-click **and** start-editing auto-pin (exact VS Code), plus
   drag-out always pinned. Optional explicit "Pin" in the board menu.
3. **Include multi-spawn grid** this slice, or defer? (It's the clearest "spawn MANY" payoff.)
4. **Include open-boards awareness** this slice, or defer to polish?

Sources are linked inline above.

---

## 6. Sign-off (2026-06-20)

Decisions confirmed by the user:

1. **Browse model = Peek + Pin (VS Code parity).** Single-click reuses ONE ghosted peek board.
2. **Pin gesture = double-click + auto-pin on edit** (drag-out always spawns pinned).
3. **Scope = full:** include both *multi-select → spawn grid* and *open-boards awareness* this slice.

### Implementation plan (3 increments, each runnable + e2e-green + committed)

**Engineering spine — `peekBoardId` (ephemeral):** a board is "peek" ⟺ `board.id === peekBoardId`.
`peekBoardId` lives in the canvas store as an ephemeral field (sibling of `pendingFocusId`), so
`toObject`'s whitelist (`{schemaVersion, viewport, boards}`) **never serializes it** → no schema bump
(stays v13). The peek board itself is a normal board; at most one ever exists (it recycles), so a
left-over peek board saving as a normal board is harmless. Browsing must **not** spam undo: peek
*rebind* uses a non-recording path set; only spawn keeps its single undo step.

**Legibility refinement (2026-06-20, after live review).** The first cut signalled "peek" with a
faint dashed border — invisible in practice ("I don't even know what this is"). Replaced with VS
Code's actual cue: the **File board title now shows the filename**, rendered **italic** while it is
the peek board (upright once pinned). The dashed border was dropped. The title-bar **Pin** control
stays (e2e-proven to promote: italic → upright, button gone, board survives) — the earlier "Pin not
working" was the invisible state change, now an obvious one.

- **Inc 1 — Peek + Pin core.** Add `peekBoardId` + actions (`peekFile`, `pinFile`/`pin-on-edit`,
  ephemeral rebind) in a canvas-store slice (keeps `canvasStore.ts` under the 700-line cap). Wire
  single-click → peek (rebind/spawn), double-click → pin, edit → auto-pin, drag-out → pinned. Ghosted
  peek chrome in `FileBoard` (dashed/faded, optional Pin control). e2e: 1 board on browse + rebind,
  double-click pins, edit auto-pins.
- **Inc 2 — Multi-select → spawn grid.** `openFileBoards(paths)` spawns one pinned board per fresh
  file in a grid at viewport center (skips already-open → focuses), camera fits the new grid; tree
  multi-select + Enter / context-menu action. e2e: N selected → N boards in a grid.
- **Inc 3 — Open-boards awareness.** Tree derives the open-file-path set from `boards`, marks rows
  (● dot), click-to-jump camera; peek vs pinned shown distinctly. e2e: dot appears + jumps.


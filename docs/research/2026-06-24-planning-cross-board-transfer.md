# Feature Request — Cross-Board Element Transfer (Planning ↔ Planning)

**Date:** 2026-06-24 · **Status:** Proposal / pre-implementation. Uncommitted artifact (main is
integration-only; implementation moves to a `feat/*` worktree on sign-off).
**Author prep:** in-depth planning-board review + 3-mechanism design.
**Decisions locked with requester (2026-06-24):** semantics = **Move *and* Copy**; scope = **same
project / canvas only**; triggers = **all three** (picker + copy/paste + cross-board drag); **Q1** locked
members are **skipped on Move** (stay in source); **Q2** the picker **includes "+ New planning board"**;
**Q3** every transfer shows **one confirmation toast that is click-to-focus the target** (no auto-pan).
**Supersedes/extends:** `docs/research/2026-06-06-planning-board-deep-dive.md` › #15 (element copy/paste,
never built).

---

## 1. Problem & goal

Today a Planning board's elements (`note · text · arrow · stroke · checklist · image · diagram ·
fileref`) are trapped in the board they were created on. There is **no element-level clipboard and no
cross-board mechanism** of any kind — the OS clipboard IPC (`clipboardIpc.ts`) is text/image-only and
serves terminals. A user who splits planning across several boards (e.g. *Sprint Plan*, *Architecture*,
*Bug Triage*) cannot move a checklist, a cluster of notes, or a diagram from one to another without
re-creating it by hand.

**Goal:** let a user **transfer any selection of elements from one Planning board to another** on the
same canvas — by **moving** (re-homing) or **copying** (sharing a duplicate) — through three
complementary triggers: an explicit menu **picker**, **keyboard copy/cut/paste**, and **cross-board
drag**.

### Why this is cheap (the four enabling facts from the review)

1. **Assets are project-scoped + content-addressed.** Images carry `assetId = assets/<sha1>.<ext>`;
   diagrams carry `source` + a derived `svgCache` assetId; filerefs carry a project-relative path. Both
   the source and target board resolve from the same `<project>/.canvas/assets/` store, so **an
   in-project transfer of an image/diagram/fileref is a plain string copy** — no asset re-write, no
   decode. (Cross-*project* would need asset copying — explicitly out of scope, §2.)
2. **The store is global.** Any board can write another board's elements via
   `useCanvasStore.getState().updateBoard(targetId, { elements })`. No per-board sandbox to cross.
3. **A two-board transfer is ONE undo step.** `beginChange()` arms a single checkpoint over the whole
   `{boards, connectors, groups}` snapshot; the first `updateBoard` consumes it and a second `updateBoard`
   in the same window coalesces (`canvasStore.ts:767-781, 922-934`). So **Move = remove-from-A +
   add-to-B = a single Ctrl+Z**.
4. **The clone + picker UI already exist.** `duplicateElements()` (`elements.ts:506-533`) already mints
   fresh ids and remaps `groupId`s per copy — exactly the target-side insert. `BrowserPickPanel.tsx` is
   the board-picker pattern to clone for "Send to which board?".

**Net cost:** no `schemaVersion` bump, no new element kind, no asset machinery. A small pure transform,
one store action, one picker panel, keyboard wiring, and (the one hard part) a cross-board drag layer.

---

## 2. Scope & non-goals

**In scope (v1):**
- Transfer any multi-kind selection (incl. whole groups) between two **Planning** boards on the **current
  canvas**.
- **Move** and **Copy** semantics, user-chosen per transfer.
- Three triggers: (A) right-click **Send to board…** picker, (B) **Ctrl+C / Ctrl+X / Ctrl+V**, (C)
  **cross-board drag**.

**Non-goals (v1):**
- **Cross-project** transfer (different canvas opened later). Needs asset copy + path validation +
  OS-clipboard JSON interchange. Deferred.
- Transfer **to/from non-Planning boards** (terminal/browser/diagram-as-board/dataflow/command). Only
  Planning↔Planning.
- Transferring **board-level** things (groups of *boards*, connectors between boards). RF already owns
  board↔board; this feature is strictly *inside-the-board* element content.
- A persistent/visible clipboard history panel.

---

## 3. The three trigger mechanisms

All three feed **one shared transfer engine** (§4). They differ only in *how the user names the target*
and *how Move-vs-Copy is chosen*.

### 3.A — "Send to board…" picker (primary; lowest risk)

Right-click an element selection → a **Send to board…** entry → a small picker panel (clone of
`BrowserPickPanel`) listing the *other* Planning boards + a "New planning board" option, with a
**Copy / Move** toggle. This is the most discoverable trigger and matches the word "transfer".

```
Right-click selection ▸ (ElementContextMenu)
┌──────────────────────┐
│ Lock                 │
│ Group                │
│ Duplicate            │
│ Send to board…  ─────┼───▶  ┌─────────────────────────────┐
│ Tint  ▸              │      │ Send 3 items to…            │
│ Align ▸              │      │   ( ) Copy     (•) Move     │
│ Distribute ▸         │      ├─────────────────────────────┤
│ Delete               │      │ ▸ Sprint Plan               │
└──────────────────────┘      │ ▸ Architecture              │
                              │ ▸ Bug Triage                │
                              │ + New planning board        │
                              └─────────────────────────────┘
```

- Entry is **disabled** when the selection is empty or there is no other Planning board.
- Picking a target transfers immediately (one undo step) and shows the confirmation toast: *"Moved 3
  items to Sprint Plan"* — **clicking the toast focuses the target board** (Q3; the off-screen-picker
  payoff). No auto-pan.
- Placement in target: §4.3 (centered in the target's content box, relative layout preserved).
- **Reuse:** standalone panel modeled on `BrowserPickPanel.tsx` — *not* a nested submenu (the current
  `ElementContextMenu` supports `action`/`iconRow`/`swatchRow`, **no submenu nesting**; a flat panel
  avoids adding a submenu primitive).

### 3.B — Copy / Cut / Paste (keyboard; power users)

- **Ctrl/⌘+C** — serialize the (group-expanded) selection into an **in-app element clipboard** (a tiny
  module-level store / Zustand slice — *not* serialized to disk, *not* the OS clipboard in v1).
- **Ctrl/⌘+X** — same, then remove from source (lock-precedence, one undo step).
- **Ctrl/⌘+V** — when the focused well's board has a non-empty element clipboard, insert fresh-id copies
  at the cursor (or board center if no cursor), one undo step. Paste works **into any Planning board**,
  including the source (within-board duplicate falls out for free).

```
  Board A (source)            Board B (target)
 ┌────────────────┐          ┌────────────────┐
 │ ▢ note  ☑ list │  Ctrl+C  │   (click well) │
 │   (selected)   │ ───────▶ │   Ctrl+V       │
 │   Ctrl+X = cut │          │  ▢ note  ☑ list│
 └────────────────┘          └────────────────┘
   in-app element clipboard (JSON)  ·  paste at cursor
```

- **Coexistence with image paste (critical):** `usePlanningImageIO.onWellPaste` is a **document-level**
  `paste` listener that handles bitmaps. Element paste must **not** go through the OS `paste` event in v1
  — it is a direct `Ctrl+V` keydown handler on the focused well (`usePlanningKeyboard`). Precedence: if
  the in-app element clipboard is non-empty **and** the well is focused, the keydown handler consumes
  `Ctrl+V` (`preventDefault` + `stopPropagation`) so the bitmap-paste path doesn't also fire; otherwise
  the existing image-paste path is untouched. (Document this ordering in both files.)

### 3.C — Cross-board drag (highest risk; sequence LAST)

Drag a selection out of the source well, across the canvas, and drop it into another Planning board's
well. Plain drag = **Move**; **Alt-drag = Copy** (consistent with the existing within-board Alt-drag
duplicate).

```
   ┌─ Sprint Plan ─┐                 ┌─ Architecture ─┐
   │ ▢▢ ☑          │  drag ▶▶▶▶▶     │                │
   │     ╲         │                 │      ▢▢ ☑  ◀────┤ drop (target ring)
   └──────╲────────┘                 └────────────────┘
           ╲___ canvas-level ghost follows cursor ___▶
```

**How it threads through React Flow (the design that makes it feasible):**
- The within-board element drag already uses **pointer capture** on the source well
  (`usePlanningPointer.startElementDrag`). Captured pointer events keep flowing to the source well **even
  when the cursor is over another board** — so we get continuous `clientX/Y` across the whole canvas for
  free, and React Flow's pane never steals the gesture.
- When the cursor leaves the source well's rect, enter a **cross-board sub-mode**:
  - Render a **canvas-level ghost overlay** (a portal above all boards) following the cursor, with
    `pointer-events: none` so it never blocks hit-testing. v1 ghost = the selection's union-bbox outline
    + a count badge ("3 items"); full-fidelity card ghosts are a stretch.
  - Hit-test the board under the cursor via `document.elementFromPoint(clientX, clientY)` → nearest
    `.pl-well` whose board id ≠ source. (Pointer *capture* redirects pointer **events**, not
    `elementFromPoint` hit-testing — so this works.) Highlight that well as the active drop target.
- On `pointerup`:
  - **Over a foreign Planning well** → map `clientX/Y` into that board's local space (its
    `getBoundingClientRect()` + `screenScale`), transfer (Move, or Copy if Alt held) preserving the
    selection's relative layout around the drop point, one undo step.
  - **Otherwise** (back over the source / empty canvas) → the existing within-board drop (no behavior
    change).

**Risk & mitigations:** this is the one slice that fights the engine. Risks: clipped `overflow:hidden`
wells, two board-local coordinate spaces at different zooms, ghost hit-test interference, and target
auto-grow. All have concrete mitigations (pointer-capture for events, `elementFromPoint` for hit-test,
`pointer-events:none` ghost, existing `growForChecklist` for target height). **It ships last**, after the
picker + copy/paste have proven the shared engine.

### Move-vs-Copy matrix (consistent across triggers)

| Trigger | Move | Copy |
|---|---|---|
| Picker | "Move" radio | "Copy" radio |
| Keyboard | Ctrl+X → Ctrl+V | Ctrl+C → Ctrl+V |
| Drag | plain drag | Alt-drag |

---

## 4. Shared transfer engine (data model)

One pure transform + one store action serve all three triggers.

### 4.1 Pure transform (`planning/elements.ts`, unit-tested)

Two pure helpers (or one combined) keeping the existing immutable/caller-supplied-id discipline:

- `extractForTransfer(els, ids)` → `{ payload: PlanningElement[], remaining: PlanningElement[] }`
  - `payload` = the **group-expanded** (`expandGroups`) selection, deep-cloned, **normalized** so the
    group's union-bbox top-left sits at the origin (subtract min x/y) — placement is then a single
    translate at insert time.
  - For **Move**, `remaining` = source minus the moved ids, applying **lock-precedence** (Q1, locked):
    locked members **stay in source** and are **not** copied to the target (mirrors Delete/Cut — a Move
    never silently re-homes a locked element).
- `insertTransferred(targetEls, payload, at, newId)` → `{ elements, newIds }`
  - Clone `payload` with **fresh ids** + **remapped group ids** (reuse `duplicateElements`' remap logic),
    translate by `at`, append to `targetEls`. Returns `newIds` for reselection in the target.

`assetId` / `source` / `svgCache` / `path` are copied verbatim (same project → valid references).

### 4.2 Store action (`canvasStore.ts`) — atomic, testable

```ts
transferElements(
  sourceId: string,
  targetId: string,
  ids: Iterable<string>,
  mode: 'copy' | 'move',
  at: { x: number; y: number },
): { newIds: string[] }   // for target reselection
```

- `beginChange()` once, then `updateBoard(targetId, …)` and — when `mode==='move'` —
  `updateBoard(sourceId, …)`, coalesced into **one** undo step (verified, §1.3).
- No-op guards (empty payload, target===source on Move, target not Planning) return without arming a
  checkpoint (the phantom-undo discipline). Doing this in the store (vs. the component) keeps it
  unit-testable and atomic.

### 4.3 Placement rules (where elements land in the target)

- **Picker:** center the payload's union bbox in the target's **content box** (`board.w/2, board.h/2`
  minus half the payload size); clamp to `(16,16)` if the payload is larger than the target. Target
  auto-grows for tall checklists via the existing `growForChecklist` measure path.
- **Paste:** at the target well's **last cursor position**; fall back to board center (mirrors image
  paste). Subsequent pastes nudge by a small offset to avoid stacking.
- **Drag:** at the **actual drop point** (cursor → target-local), preserving each element's offset from
  the grabbed anchor.

### 4.4 What is preserved / reset

- Preserved: kind-specific data (text, items+done, tint, rotation, points, `assetId`/`source`/`path`,
  `w/h`, `locked`), relative layout, group cohesion (as a fresh group in the target).
- Reset: element `id`s (fresh), `groupId`s (remapped), absolute position (re-placed per §4.3).

---

## 5. Architecture constraints honored

1. **Scene/session split** — selection/clipboard/drag-ghost/drop-target are **ephemeral** (React /
   Zustand-runtime / module state), never serialized, never added to `PATCHABLE_KEYS` or routed into
   `elements[]`.
2. **Undo invariants** — lazy `beginChange` at commit; one coalesced step per transfer; no-op transfers
   arm no checkpoint (Bug #7/#11/#24/#28/#29/#37 discipline).
3. **Single commit path** — all writes go through `updateBoard`; `PATCHABLE_KEYS.planning` unchanged.
4. **Sandbox** — pure JS only; no node/native; in-app clipboard is in-memory; no new IPC in v1.
5. **No schema change** — reuses existing kinds + the project asset store; no `schemaVersion`/floor bump.
6. **Security** — Planning content stays passive data; nothing reaches a PTY/browser channel; same-project
   asset references only.

---

## 6. Edge cases

| # | Case | Handling |
|---|---|---|
| E1 | Selection spans a group | `expandGroups` first; group re-homed as one fresh group in target. |
| E2 | Locked elements in a **Move** | Lock-precedence (Q1): locked stay in source, not copied to target (mirrors Delete). Copy is unaffected (locked elements copy normally). |
| E3 | Target is the source board | Picker hides source; Paste into source = within-board duplicate (fine); Drag back onto source = normal within-board drop. |
| E4 | Image/diagram/fileref | String-copy the asset ref — valid in-project (§1.1). |
| E5 | Payload larger than target | Clamp placement to `(16,16)`; target auto-grows height for checklists. |
| E6 | No other Planning board exists | Picker entry disabled / "New planning board" only; Paste still works within-board. |
| E7 | Ctrl+V with an image in the OS clipboard **and** a non-empty element clipboard | Element clipboard (more recent explicit Ctrl+C/X) wins when the well is focused; document the precedence. |
| E8 | Drag released over a non-Planning board / empty canvas | Falls back to within-board drop; no transfer. |
| E9 | Undo after a Move | Single step restores both source and target. |
| E10 | Arrows/strokes (absolute-point kinds) | `shiftElement`/normalize already handle both endpoints / every point pair (`elements.ts:361-374`). |

---

## 7. Impact map (files)

| File | Change |
|---|---|
| `planning/elements.ts` | Pure `extractForTransfer` + `insertTransferred` (+ tests). |
| `planning/elementClipboard.ts` *(new)* | In-app element clipboard (set/get/clear; module or tiny slice). |
| `store/canvasStore.ts` | `transferElements(...)` action (one undo step) + selector for "other Planning boards". |
| `planning/contextMenuEntries.ts` | "Send to board…" entry (disabled rules) + open-picker callback. |
| `planning/SendToBoardPanel.tsx` *(new)* | Picker panel (clone of `BrowserPickPanel`) + Copy/Move toggle. |
| `planning/ElementContextMenu.tsx` | Wire the entry to open the panel (no submenu primitive needed). |
| `usePlanningKeyboard.ts` | Ctrl+C / Ctrl+X / Ctrl+V handlers (coexist with image paste). |
| `usePlanningImageIO.ts` | Document/confirm Ctrl+V precedence note. |
| `usePlanningPointer.ts` | Cross-board drag sub-mode (leave-well detect, hit-test, drop transfer). |
| `CrossBoardDragGhost.tsx` *(new)* | Canvas-level ghost overlay (portal, `pointer-events:none`). |
| `PlanningBoard.tsx` | Wire panel + clipboard + drag-ghost + reselection of `newIds`. |
| toast | Confirmation toast ("Moved/Copied N items to <title>") — **clickable to focus the target** (Q3); reuses the camera-fit/focus helper. No auto-pan. |

---

## 8. Phased build plan (each phase ends runnable + committed)

1. **Engine** — `extractForTransfer` + `insertTransferred` + `transferElements` store action + unit/store
   tests (one-undo-step, lock-precedence, asset-ref copy, group remap). No UI yet.
2. **Picker (3.A)** — `SendToBoardPanel` + context-menu entry + toast. The discoverable MVP; proves the
   engine end-to-end. **Gate: pixel mock of the picker reviewed (§10).**
3. **Copy/Paste (3.B)** — in-app clipboard + Ctrl+C/X/V + image-paste coexistence.
4. **Cross-board drag (3.C)** — pointer sub-mode + ghost overlay + drop transfer. Highest risk; lands last
   on the proven engine.

Each phase: full gate (typecheck · lint · format:check · unit+int) + the e2e `@planning` leg; full e2e
matrix once at the pre-merge gate (CLAUDE.md › Parallel sessions).

---

## 9. Test plan

- **Unit (`elements.test.ts`):** extract normalizes to origin; group expansion + remap; move-removes-source
  with lock-precedence; asset-ref verbatim copy; arrow/stroke point integrity.
- **Store:** `transferElements` = one undo step (move touches both boards, single Ctrl+Z); no-op guards
  arm no checkpoint; copy leaves source intact.
- **E2E (`@planning`, real input):** drive via real DOM `keydown` + `PointerEvent` on `.pl-well` (screen
  coords = well rect × scale — the established whiteboard-probe pattern), assert off `getBoards()`:
  - picker: right-click → Send to → target board gains N elements; Move drops them from source.
  - copy/paste: Ctrl+C in A → focus B → Ctrl+V → B gains N; Ctrl+X variant removes from A.
  - drag: pointer-drag from A's well across to B's well → B gains N at the drop point; Alt-drag copies.

---

## 10. Resolved decisions + remaining gate

**Resolved with requester (2026-06-24):**
- **Q1 — Locked on Move → SKIP.** Locked members stay in source and are not copied to the target
  (lock-precedence, consistent with Delete/Cut). Copy is unaffected — locked elements copy normally.
- **Q2 — Picker includes "+ New planning board".** Choosing it spawns a fresh Planning board (`addBoard`)
  and transfers into it. Placement = the new board's center (§4.3).
- **Q3 — One clickable confirmation toast for every transfer; click focuses the target.** No auto-pan
  (a camera jump you didn't ask for is jarring for drag/paste where the target is already visible). The
  click reuses the existing camera-fit/focus helper. Same toast across all three triggers — redundant but
  harmless for drag/paste, the payoff for the off-screen picker case.

**Remaining gate (before Phase 2 code):**
- **Picker pixel mock** — build a throwaway static HTML/JSX mock of `SendToBoardPanel` with the real
  tokens from `index.css` and screenshot it for sign-off (CLAUDE.md › Design artifact before code). The
  ASCII wireframes above cover structure; the picker is "real UI" and gets a pixel mock. (Phase 1, the
  pure engine, is UI-free and needs no mock — it can start in parallel.)

---

**One-line thesis:** the planning board's clean element model + project-scoped content-addressed assets +
global store + coalescing undo make cross-board transfer a *small* feature (no schema bump, no asset
machinery) — the only real engineering is the cross-board drag layer, which is sequenced last on a shared,
already-proven transform engine.

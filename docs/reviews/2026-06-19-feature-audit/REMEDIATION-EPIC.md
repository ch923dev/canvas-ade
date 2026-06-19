# Post-Audit Polish — remediation umbrella (epic "PA")

> Executable decomposition of the [2026-06-19 feature audit](./REPORT.md) into **file-disjoint,
> parallel-runnable slices**. Source of truth for findings + evidence is `REPORT.md`; this doc is the
> build order.
>
> **Design goal: maximum parallelism.** Slices are partitioned by **file-zone ownership** (not by
> theme), so two sessions never edit the same file. The few genuinely shared files have a single
> declared owner + a coordination rule (§3). Run in batches of ~4 (the repo's live-worktree cap).

---

## 1. How this is organized

- **10 work slices (PA-1 … PA-10) + 1 final ratchet (PA-R).** Each slice = one worktree/branch, one
  PR, merged sequentially into `main` re-running the full gate + e2e matrix per merge (CLAUDE.md
  › Parallel sessions).
- **Ownership rule:** the *Owns* column lists files a slice has exclusive write access to for the epic.
  If your slice needs to touch a file owned by another slice, it's a **shared file** (§3) — coordinate
  on `ACTIVE-WORK.md`, keep the edit to a distant region, and merge the owner first.
- **Dependencies** are minimal by design: only PA-5 and PA-6 depend on earlier slices (they touch
  `Canvas.tsx` / `BoardFrame.tsx`), and PA-R runs last. Everything else is independent.
- **Design-artifact gate:** slices flagged ✎ change visible UI → produce a wireframe/mock for sign-off
  *before* code (CLAUDE.md › Design artifact before code).

---

## 2. Slice ownership map

| Slice | Title | Findings | Owns (exclusive files) | Dep | Eff | UI? |
|---|---|---|---|---|---|---|
| **PA-1** | Canvas camera & core cleanup | CANVAS-01 (H), 02, 04, 06 | `Canvas.tsx`, `lib/digest.ts`, `lib/canvasView.ts`, `hooks/useFullView.ts`, `hooks/useBoardKeyboardNav.ts` | — | S–M | — |
| **PA-2** | Board chrome (keystone a11y) | PLAN-02 (H, IconBtn), PERF-04, PERF-05, CANVAS-05 | `BoardFrame.tsx`, `Icon.tsx`, `BoardNode.tsx` | — | S | — |
| **PA-3** | App chrome + save status | CHROME-01, 02, 05, A11Y-01, PERSIST-03 | `AppChrome.tsx`, `WelcomeScreen.tsx`, `store/saveStatusStore.ts` | — | M | ✎ |
| **PA-4** | Modals & token conformance | STYLE-01, MCP-01, MCP-05 | `ConfirmModal.tsx`, `RecapConsentModal.tsx`, `SettingsModal.tsx`, `AuditLogViewer.tsx` | — | S–M | ✎ |
| **PA-5** | Planning / whiteboard | PLAN-01 (H), 02-labels, 03, 04, 05, 06, 07, 08 | `PlanningBoard.tsx`, `boards/planning/*`, `lib/pen.ts`, `DESIGN.md` §7.3 | PA-2 | M–L | ✎ |
| **PA-6** | Groups & connectors | GROUP-01…07 | `GroupBoxLayer.tsx`, `Group*.tsx`, `hooks/useGroupInteractions.ts`, `hooks/useBoardPlacement.ts`, `slices/{group,connector}Slice.ts`, `edges/OrchestrationEdge.tsx`, `lib/{groupBoxes,groupReflow,orchestrationEdges,resolveConnectTarget}.ts` | PA-1, PA-2 | M–L | ✎ |
| **PA-7** | Preview / OSR | PREV-01, 02, 03, 04 | `boards/BrowserBoard.tsx`, `boards/useOffscreen*.ts`, `lib/osrSizing.ts`, `main/previewOsr.ts`, preview parts of `preload/index.ts` | — | M | — |
| **PA-8** | Persistence & autosave | PERSIST-01 (+PERF-07), 02 | `lib/boardSchema.ts`, `store/useAutosave.ts`, `store/canvasStore.ts` (toObject) | — | S | — |
| **PA-9** | Terminal | TERM-01, PERF-06, (verify-first) TERM-02…08 | `boards/TerminalBoard.tsx`, `boards/terminal/*`, `RecapView.tsx`, `main/pty.ts` | — | S–M | ✎ |
| **PA-10** | Context / MCP UI | MCP-03, 04, 06, 07, 08 | `DigestPanel.tsx`, `main/auditLog.ts`, `main/{canvasMemory,boardMemory,summaryLoop}.ts` | — | S–M | — |
| **PA-R** | Token-enforcement lint ratchet | STYLE-02 | `eslint.config.mjs` | all | M | — |

> H = contains a High-severity finding. The three Highs are split across PA-1 (CANVAS-01), PA-2
> (PLAN-02 keystone), PA-5 (PLAN-01).

---

## 3. Shared / contended files (the only collision points)

Three files are unavoidably touched by more than one slice. Rules:

| File | Owner | Other slices touching it | Rule |
|---|---|---|---|
| `Canvas.tsx` | **PA-1** | PA-6 (connector rubber-band ~L869-897), PA-10 (MCP-04 refresh ~L293) | PA-1 merges first; others edit only their cited distant region, rebase after PA-1. |
| `BoardFrame.tsx` | **PA-2** | PA-6 (connector handle ~L737, remove-from-group menu ~L451) | PA-2 merges first; PA-6 rebases. PA-2's `IconBtn` a11y fix is a **keystone** — it gives every icon button an accessible name + pressed state at once, so PA-5/PA-9 toolbar buttons inherit it for free. |
| `index.css` | **shared, additive** | PA-2 (resize handles), PA-3 (focus rings), PA-4 (button/modal), PA-10 (digest) | No single owner — but each slice adds rules **in its own selector block only**; never reflow another section. CSS conflicts are line-adjacency only; distinct selectors ⇒ near-zero risk. |

Everything not in this table is genuinely disjoint.

---

## 4. Parallel execution schedule (4-worktree cap)

```
Wave 1 (start now, fully disjoint):   PA-1   PA-2   PA-7   PA-8
                                        │      │
Wave 2 (independent, any order):      PA-3   PA-4   PA-9   PA-10
                                        └──┬───┘ (PA-1, PA-2 now merged)
Wave 3 (need PA-1/PA-2 merged):       PA-5   PA-6   PA-R
```

- **Wave 1** owns the four most-contended file zones (`Canvas.tsx`, `BoardFrame.tsx`, preview,
  persistence). Landing these first unblocks the dependent slices and clears the keystone.
- **Wave 2** is independent of Wave 1 (different files) — it can actually start *concurrently* with
  Wave 1 if you have the worktree capacity; it's placed second only to respect the ~4 cap and let the
  `index.css` additive edits land in a predictable order.
- **Wave 3** rebases onto the merged PA-1/PA-2 (so the `Canvas.tsx` / `BoardFrame.tsx` shared edits are
  conflict-free) and PA-R runs last so it has the fewest literal violations to clean up.

Each wave ends with the **full e2e matrix** at the pre-merge gate (mandatory once per PR per CLAUDE.md).

---

## 5. Per-slice detail

### PA-1 · Canvas camera & core cleanup  ·  `fix/pa1-canvas-perf`
- **CANVAS-01 (High, perf):** drop `viewport` from the `buildDigest` arg + `useMemo` deps
  (`Canvas.tsx:257-259`) and remove the reactive `const viewport = useCanvasStore(s=>s.viewport)`
  (`Canvas.tsx:161`); remove the now-unused `viewport` field from `buildDigest`'s `CanvasDoc` arg in
  `lib/digest.ts`. (Restore effect already reads viewport via `getState()`.)
- **CANVAS-02 (low):** delete the dead `fullViewMotion` flag (`useFullView.ts:37,68,137`); rewrite the
  stale WebContentsView comment to describe the OSR canvas.
- **CANVAS-04 (low):** extract `focusMaxZoom(boardType)` into `lib/canvasView.ts`; call from
  `useBoardKeyboardNav` + `useFullView`.
- **CANVAS-06 (low):** read `--grid-dot` once via `getComputedStyle` (memoized) for `<Background>`, or
  export one shared constant.
- **✅ Accept:** no `CanvasInner` re-render on pan/zoom (verify via React DevTools profiler or a
  render-count assertion); digest unit tests still green; gate + e2e green.

### PA-2 · Board chrome — keystone a11y  ·  `fix/pa2-board-chrome-a11y`
- **PLAN-02 core (High, a11y):** in `IconBtn` (`BoardFrame.tsx`) default `aria-label` ← `title`, add
  `aria-pressed={active}` for toggle buttons, `aria-hidden` the inner `Icon` glyph (`Icon.tsx`). This
  alone fixes the planning toolbar, snap, export, restart-menu, and every other icon button.
- **PERF-04 (medium, perf):** move the `const groups = useCanvasStore(s=>s.groups)` read out of the
  always-mounted `BoardMenu` trigger into the open popover body (or narrow to a per-board membership
  selector) so group mutations stop re-rendering every board's title bar.
- **PERF-05 (low, perf):** lift `lodPill` + its terminal/preview runtime subscriptions into the
  `showCard` (LOD) branch only (`BoardNode.tsx:130-134`).
- **CANVAS-05 (low, styling):** bring resize handles to §6 (8×8 corners, faint 2px visible edge line)
  **or** record the divergence in DESIGN.md §6 (`index.css:818-840`, resize-handle block only).
- **✅ Accept:** every icon button announces a name + pressed state (AT smoke / unit on IconBtn);
  group rename doesn't re-render unrelated title bars; gate + e2e green. **Merge before PA-5/PA-6.**

### PA-3 · App chrome + save status  ✎  ·  `fix/pa3-app-chrome`
- **CHROME-02 (medium, a11y):** `aria-pressed={active}` on `ToolBtn`/`DockBtn`.
- **A11Y-01 (medium, a11y):** add `.ca-t-ctl:focus-visible` accent ring; include
  `project-switcher-trigger` + the zoom `%` button.
- **CHROME-01 (low, perf):** cache the dock-wrapper rect; recompute on resize, not per `pointermove`.
- **PERSIST-03 (medium, ux):** promote `saveStatusStore` to an idle/saving/saved/error machine; render
  a quiet `--text-3` status next to the board count. ✎ **needs a small mock** (placement + states).
- **CHROME-05 (low, code):** *defer to end of slice* — extract a `useProjectSwitch`-style seam /
  `TidyMenu` module from `AppChrome.tsx` once the above land (optional; skip if risky).
- **✅ Accept:** save status visibly cycles saving→saved on edit; chrome controls have consistent
  focus rings + pressed state; gate + e2e green.

### PA-4 · Modals & token conformance  ✎  ·  `fix/pa4-modals-tokens`
- **STYLE-01 (medium, styling/a11y):** switch Confirm/RecapConsent/Settings primary buttons from
  filled `--accent`+`--text` (~2.8:1) to accent-on-`--accent-wash` (passes AA) **or** a near-`--void`
  foreground token; align with the documented button grammar. ✎ **mock the two button states.**
- **MCP-05 (low, ux):** add a `maxCallsPerDay` field + a small usage peek to `SettingsModal`.
- **MCP-01 (low, a11y):** correct `AuditLogViewer`'s `role` (it's a persistent side panel, not a
  `dialog`) — `role="complementary"`/`region`, not the `Modal` wrapper.
- **✅ Accept:** modal primaries pass AA contrast; budget configurable; gate + e2e green.

### PA-5 · Planning / whiteboard  ✎  ·  `fix/pa5-planning`  (dep: PA-2)
- **PLAN-01 (High, perf):** stop subscribing to `transform[2]`; read zoom from a ref (subscribe w/o
  render) or `rf.getZoom()` at gesture time inside `toBoard` (`PlanningBoard.tsx:79,160`).
- **PLAN-07 (low, perf):** `React.memo` `WhiteboardSvg` (mostly subsumed once PLAN-01 lands).
- **PLAN-03 (medium, a11y):** add keyboard shortcuts for `text`/`diagram` (collision-checked vs `t`),
  surface the letters in titles (`tools.ts`).
- **PLAN-04 (medium, a11y):** `role="progressbar"` + `aria-value*` on the checklist bar.
- **PLAN-02 labels (refine):** pass human labels ("Sticky note", "Eraser") from `PlanningToolbar` now
  that PA-2's IconBtn supports `aria-label`.
- **PLAN-05 (medium, ux):** reuse the `DiagramCard` resize-handle pattern for `NoteCard`/`ChecklistCard`
  (width). ✎ **mock the resize affordance.**
- **PLAN-08 (low, ux/feature):** optional `label` on `ArrowElement` (additive schema bump, ADR 0007) +
  midpoint chip. ✎ **mock the label chip.**
- **PLAN-06 (low, ux):** fix the empty-state hint + add `diagram` to DESIGN.md §7.3.
- **✅ Accept:** no planning re-render on camera move; all 8 tools keyboard-reachable; checklist
  progress announced; note/checklist width-resizable; gate + e2e (whiteboard probes) green.
- *Internal ordering:* `ChecklistCard` is touched by PLAN-04 + PLAN-05 → do them in sequence within
  the slice.

### PA-6 · Groups & connectors  ✎  ·  `fix/pa6-groups-connectors`  (dep: PA-1, PA-2)
- **GROUP-03 (medium, ux):** highlight the resolved drop-target board mid connector-drag (reuse the
  `.group-box--drop-target` treatment); run `resolveConnectTarget` in `onMove`.
- **GROUP-04 (low, ux):** branch on `addConnector`'s null return → toast ("Already connected" /
  "Can't connect a board to itself").
- **GROUP-01 (medium, a11y):** keyboard/palette path to create + delete connectors; make edges
  focusable; `aria-label` the ✕.
- **GROUP-02 (medium, a11y):** keyboard handlers on the group name-tab (Enter=focus, menu key=manage);
  debounce click vs dblclick; `aria-label`.
- **GROUP-05 (low, ux):** wire single-board "Add to {name}" to plain `addBoardsToGroup` (no repack);
  keep the animated repack for the drag-onto-box gesture.
- **GROUP-06 (low, ux):** one "Remove from {name}" row per membership; keep "Remove from all" only when
  in 2+.
- **GROUP-07 (low, perf):** during a single-board drag, recompute only the groups containing that board.
- **✅ Accept:** connector drop target visible; rejects toast; connectors + groups keyboard-operable;
  manual layouts survive add-to-group; gate + e2e green. ✎ **mock the drop-target highlight + the
  per-group remove menu.**

### PA-7 · Preview / OSR  ·  `fix/pa7-preview-osr`
- **PREV-01 (medium, perf):** make `useOffscreenSizing` full-view-aware — recompute `S` from the
  full-view pixel box, re-send `preview:osrResize` on enter/exit.
- **PREV-02 (medium, perf):** one shared `preview:osrFrame`/`osrCursor` renderer listener dispatching
  to a `Map<boardId, handler>`; rAF-coalesce per-board blits (`preload/index.ts`, `useOffscreen*`).
- **PREV-04 (medium, a11y):** `aria-label="Preview URL"` + `aria-invalid` on the URL input.
- **PREV-03 (low, perf):** *optional* — freeze fully screen-covered boards via a rect-cover test
  (MAIN-side CPU only; skip if not worth the complexity).
- **✅ Accept:** full-view preview crisp to the 2× cap; one IPC frame listener regardless of board
  count; URL input has an accessible name; gate + e2e (preview leg) green.

### PA-8 · Persistence & autosave  ·  `fix/pa8-persistence`
- **PERSIST-01 (medium, perf):** drop the `structuredClone` in `toObject` (IPC already isolates);
  memoize `previewConnectorsFor(boards)` against the boards ref (folds in PERF-07).
- **PERSIST-02 (low, code):** add a single-flight latch to `createAutosaver` so a re-armed timer can't
  fire an overlapping `project:save`.
- **✅ Accept:** one deep pass per save (not three); no overlapping saves under rapid edits; persistence
  integration tests green; gate + e2e green.

### PA-9 · Terminal  ✎  ·  `fix/pa9-terminal`
- **TERM-01 (medium, ux):** wire the existing `formatTimer` + an elapsed tick into the status pill
  (`TerminalBoard.tsx:286` → pass the timer arg to `statusFor`).
- **PERF-06 (low, perf):** replace the PTY string-concat ring with a chunk deque; join only on adopt
  (`main/pty.ts`).
- **TERM-02…08 (verify-first):** re-confirm each against source, then action the real ones (status
  label hover-only; `--text-faint` flag hint; exited re-run CTA; recap re-fetch; interrupt confirm;
  settled-zoom fan-out). TERM-07 (god-file split) last/optional.
- **✅ Accept:** run timer ticks in the pill; PTY append is O(chunk); gate + e2e (terminal leg) green.

### PA-10 · Context / MCP UI  ·  `fix/pa10-context-mcp`
- **MCP-04 (low, ux):** surface the reason a digest refresh produced nothing (no key / budget / error)
  — propagate from `Canvas.tsx:293` (distant region; rebase after PA-1) to `DigestPanel`.
- **MCP-08 (low, ux):** line-clamp digest prose with an expand affordance.
- **MCP-06 (low, styling):** style all digest status values (or enum), not just `ready`/`linked`.
- **MCP-03 (low, perf):** rotate/size-cap the audit JSONL; tail-read on open.
- **MCP-07 (low, code):** extract the shared `SAFE_ID` regex into one module used by
  `canvasMemory`/`boardMemory`.
- **✅ Accept:** refresh gives feedback; prose clamped; log bounded; gate + e2e green.

### PA-R · Token-enforcement lint ratchet  ·  `fix/par-token-lint`  (dep: all)
- **STYLE-02 (medium, code):** add a renderer `no-restricted-syntax` rule flagging numeric
  `fontSize`/`borderRadius` + raw hex/rgba in inline `style` objects (or stylelint). Start **warn-only**
  to surface the backlog, ratchet to error once the component slices have cleared their literals.
- **✅ Accept:** rule active; no new violations introduced; gate green.

---

## 6. Standard process per slice (CLAUDE.md)

1. `pwsh .claude/tools/new-worktree.ps1` → branch off current `main` (rebase if main advanced).
2. Implement; keep within your *Owns* zone. Cross-zone touch → note on `ACTIVE-WORK.md` first.
3. ✎ slices: produce the design artifact (wireframe or token-built mock) and get sign-off **before** code.
4. Gate green: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
5. **Manual dev check** in a running app with `CANVAS_DEV_TITLE='PR#NNN <slice>'; pnpm dev`.
6. Open PR; address the Claude reviewer's inline comments with inline dispositions.
7. **Pre-merge: full e2e matrix** (`pnpm test:e2e:matrix`, both legs) — mandatory once per PR.
8. Merge sequentially into `main`, re-run gate + e2e after each, `signal-merge.ps1`.

---

## 7. Coverage check (every confirmed finding is assigned)

- **PA-1:** CANVAS-01, 02, 04, 06
- **PA-2:** PLAN-02 (core), PERF-04, PERF-05, CANVAS-05
- **PA-3:** CHROME-01, 02, 05, A11Y-01, PERSIST-03
- **PA-4:** STYLE-01, MCP-01, MCP-05
- **PA-5:** PLAN-01, 02 (labels), 03, 04, 05, 06, 07, 08
- **PA-6:** GROUP-01, 02, 03, 04, 05, 06, 07
- **PA-7:** PREV-01, 02, 03, 04
- **PA-8:** PERSIST-01 (+PERF-07), 02
- **PA-9:** TERM-01, PERF-06, TERM-02…08 (verify-first)
- **PA-10:** MCP-03, 04, 06, 07, 08
- **PA-R:** STYLE-02

43 confirmed findings + 7 unverified terminal notes → all mapped. Rejected findings (CANVAS-03,
PERSIST-04, MCP-01-as-Modal, MCP-02, CHROME-04) are out of scope per `REPORT.md` §6.1.

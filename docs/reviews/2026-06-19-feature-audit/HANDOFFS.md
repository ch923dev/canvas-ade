# Post-Audit Polish (epic "PA") — parallel-session handoffs

Ready-to-paste session prompts for the **file-disjoint** slices of the
[remediation umbrella](./REMEDIATION-EPIC.md). Each block is self-contained: open a fresh Claude
session **in the repo** and paste the fenced prompt. Full finding evidence is in
[`REPORT.md`](./REPORT.md); the ownership map + shared-file rules + waves are in
[`REMEDIATION-EPIC.md`](./REMEDIATION-EPIC.md).

## How to use this

1. **One session per worktree.** Each prompt creates its own `.worktrees/<slice>` off `main`.
2. **PA-1 is already done** (`fix/pa1-canvas-perf`, committed local `daefee66`, gate-green, not pushed).
3. **Start order:** the four slices under *Ready now* are fully independent and can run **concurrently**
   (mind the ~4 live-worktree cap — 8 parked worktrees already exist, so tear one down first or stay ≤4
   new lanes). The *Needs a design artifact first* slices are also independent but must produce a
   wireframe/mock for sign-off **before** code (CLAUDE.md › Design artifact before code). The *Queued*
   slices depend on PA-1/PA-2 landing first.
4. **Every slice ends with:** full gate (`typecheck · lint · format:check · test`) → title-stamped
   manual dev check → PR → inline-reply each bot comment → **full e2e matrix both legs** at the
   pre-merge gate → merge sequentially → `signal-merge.ps1`.
5. **Env quirks (this machine):** run pnpm via nvm Node 22.17 + corepack (`export
   PATH="/c/Users/De Asis PC/AppData/Roaming/nvm/v22.17.0:$PATH"` then `corepack pnpm …`); never
   `pnpm install` from a worktree (recreates the shared main tree — run pnpm from a worktree with `-C`,
   no install). The worktree's `node_modules` is junctioned to main's, so typecheck/lint/test work
   without an install.

---

## Ready now — fully independent, no design artifact (Wave-1 remainder + PA-10)

### PA-2 · Board chrome — keystone a11y · `fix/pa2-board-chrome-a11y`
> **Merge before PA-5/PA-6.** Contains a High finding (PLAN-02). Its `IconBtn` fix is the keystone that
> gives every icon button across the app an accessible name + pressed state at once.

```
Implement slice PA-2 of the Post-Audit Polish umbrella. Read these first (absolute paths in the main
checkout): Z:\Canvas ADE\docs\reviews\2026-06-19-feature-audit\REPORT.md and REMEDIATION-EPIC.md (§5
PA-2). Then:

1. git fetch origin && git rebase origin/main, then:
   pwsh .claude/tools/new-worktree.ps1 -Name pa2-board-chrome-a11y -Branch fix/pa2-board-chrome-a11y -Zone "BoardFrame.tsx · Icon.tsx · BoardNode.tsx (PA-2)"
2. Owned files (exclusive): src/renderer/src/canvas/BoardFrame.tsx · canvas/Icon.tsx · canvas/BoardNode.tsx.
   (BoardFrame.tsx is a SHARED file — you are its owner; PA-6 rebases onto you. index.css: add only your
   own resize-handle selector block, never reflow another section.)
3. Fixes:
   - PLAN-02 core (High, a11y): in IconBtn (BoardFrame.tsx) default aria-label from `title`, add
     aria-pressed={active} for toggle buttons, and aria-hidden the inner Icon glyph (Icon.tsx).
   - PERF-04 (Med, perf): move `const groups = useCanvasStore(s=>s.groups)` out of the always-mounted
     BoardMenu trigger into the open popover body (or narrow to a per-board membership selector) so a
     group rename stops re-rendering every board's title bar.
   - PERF-05 (low, perf): lift lodPill + its terminal/preview runtime subscriptions into the showCard
     (LOD) branch only (BoardNode.tsx ~130-134).
   - CANVAS-05 (low, styling): bring resize handles to DESIGN.md §6 (8×8 corners, faint 2px edge line)
     OR record the divergence in DESIGN.md §6 (index.css resize-handle block only).
4. Accept: every icon button announces a name + pressed state (add/extend an IconBtn unit test); group
   rename doesn't re-render unrelated title bars; full gate + e2e green. Manual dev check with
   CANVAS_DEV_TITLE='PR PA-2 board-chrome-a11y'.
```

### PA-7 · Preview / OSR · `fix/pa7-preview-osr`
```
Implement slice PA-7 of the Post-Audit Polish umbrella. Read REPORT.md + REMEDIATION-EPIC.md (§5 PA-7)
under Z:\Canvas ADE\docs\reviews\2026-06-19-feature-audit\. Then:

1. git fetch origin && git rebase origin/main, then:
   pwsh .claude/tools/new-worktree.ps1 -Name pa7-preview-osr -Branch fix/pa7-preview-osr -Zone "boards/BrowserBoard.tsx · boards/useOffscreen*.ts · lib/osrSizing.ts · main/previewOsr.ts · preload preview surface (PA-7)"
2. Owned files: src/renderer/src/canvas/boards/BrowserBoard.tsx · boards/useOffscreen*.ts ·
   src/renderer/src/lib/osrSizing.ts · src/main/previewOsr.ts · the preview parts of src/preload/index.ts.
   (Touches src/main + preload → this push pays the FULL e2e matrix, not just Windows.)
3. Fixes:
   - PREV-01 (Med, perf): make useOffscreenSizing full-view-aware — recompute the supersample S from the
     full-view pixel box and re-send preview:osrResize on full-view enter/exit (today it stays at the
     small in-canvas size → blurry full-view preview).
   - PREV-02 (Med, perf): one shared preview:osrFrame / osrCursor renderer listener dispatching to a
     Map<boardId, handler>, rAF-coalesce per-board blits (preload/index.ts + useOffscreen*). Today each
     board adds its own IPC listener → N listeners for N boards.
   - PREV-04 (Med, a11y): aria-label="Preview URL" + aria-invalid on the URL input.
   - PREV-03 (low, perf, OPTIONAL): freeze fully screen-covered boards via a rect-cover test (MAIN-side
     CPU only) — skip if not worth the complexity.
4. Accept: full-view preview crisp up to the 2× cap; exactly one IPC frame listener regardless of board
   count; URL input has an accessible name; full gate + e2e (preview leg) green. Manual dev check.
```

### PA-8 · Persistence & autosave · `fix/pa8-persistence`
```
Implement slice PA-8 of the Post-Audit Polish umbrella. Read REPORT.md + REMEDIATION-EPIC.md (§5 PA-8)
under Z:\Canvas ADE\docs\reviews\2026-06-19-feature-audit\. Then:

1. git fetch origin && git rebase origin/main, then:
   pwsh .claude/tools/new-worktree.ps1 -Name pa8-persistence -Branch fix/pa8-persistence -Zone "lib/boardSchema.ts · store/useAutosave.ts · store/canvasStore.ts toObject (PA-8)"
2. Owned files: src/renderer/src/lib/boardSchema.ts · store/useAutosave.ts · store/canvasStore.ts
   (toObject path only). No schema-version bump (behavior-preserving perf/code).
3. Fixes:
   - PERSIST-01 (Med, perf, folds in PERF-07): drop the structuredClone in toObject — the IPC boundary
     already structured-clones, so this is a redundant second deep pass. Memoize
     previewConnectorsFor(boards) against the boards ref so it isn't recomputed each save.
   - PERSIST-02 (low, code): add a single-flight latch to createAutosaver so a re-armed debounce timer
     can't fire an overlapping project:save.
4. Accept: one deep pass per save (not three) — assert via a spy/count test; no overlapping saves under
   rapid edits; persistence integration tests green; full gate + e2e green. Manual dev check (edit →
   confirm canvas.json still round-trips).
```

### PA-10 · Context / MCP UI · `fix/pa10-context-mcp`
> Independent **except** MCP-04 touches `Canvas.tsx:~293` (PA-1's zone) — do that one finding in PA-1's
> cited distant region and **rebase after PA-1 merges**; everything else is disjoint, start anytime.

```
Implement slice PA-10 of the Post-Audit Polish umbrella. Read REPORT.md + REMEDIATION-EPIC.md (§5 PA-10)
under Z:\Canvas ADE\docs\reviews\2026-06-19-feature-audit\. Then:

1. git fetch origin && git rebase origin/main, then:
   pwsh .claude/tools/new-worktree.ps1 -Name pa10-context-mcp -Branch fix/pa10-context-mcp -Zone "DigestPanel.tsx · main/auditLog.ts · main/{canvasMemory,boardMemory,summaryLoop}.ts (PA-10)"
2. Owned files: src/renderer/src/canvas/DigestPanel.tsx · src/main/auditLog.ts ·
   src/main/{canvasMemory,boardMemory,summaryLoop}.ts. (Touches src/main → FULL e2e matrix on push.)
3. Fixes:
   - MCP-08 (low, ux): line-clamp digest prose with an expand affordance.
   - MCP-06 (low, styling): style ALL digest status values (or make them an enum), not just ready/linked.
   - MCP-03 (low, perf): rotate / size-cap the audit JSONL; tail-read on open.
   - MCP-07 (low, code): extract the shared SAFE_ID regex into one module used by canvasMemory + boardMemory.
   - MCP-04 (low, ux): surface WHY a digest refresh produced nothing (no key / budget / error). This
     propagates from Canvas.tsx:~293 (PA-1's zone) to DigestPanel — coordinate on ACTIVE-WORK and do this
     finding LAST, after PA-1 has merged; edit only that one distant region of Canvas.tsx.
4. Accept: refresh gives feedback; prose clamped; audit log bounded; full gate + e2e green. Manual dev check.
```

---

## Needs a design artifact first (independent, but ✎ sign-off before code)

These are file-disjoint from everything above and can run in parallel, but each changes visible UI →
produce a wireframe or token-built mock and get a nod **before** writing implementation code.

### PA-3 · App chrome + save status ✎ · `fix/pa3-app-chrome`
- Owns: `AppChrome.tsx` · `WelcomeScreen.tsx` · `store/saveStatusStore.ts`.
- CHROME-02 (Med, a11y) aria-pressed on ToolBtn/DockBtn · A11Y-01 (Med, a11y) `.ca-t-ctl:focus-visible`
  accent ring (incl. project-switcher-trigger + zoom % button) · CHROME-01 (low, perf) cache the
  dock-wrapper rect (recompute on resize, not per pointermove) · **PERSIST-03 (Med, ux) ✎** promote
  saveStatusStore to an idle/saving/saved/error machine + a quiet `--text-3` status next to the board
  count (**mock the placement + the 4 states**) · CHROME-05 (low, code, optional) extract a
  `useProjectSwitch`/`TidyMenu` seam from AppChrome at the end if low-risk.
- ✎ artifact: the save-status indicator placement + its 4 states.

### PA-4 · Modals & token conformance ✎ · `fix/pa4-modals-tokens`
- Owns: `ConfirmModal.tsx` · `RecapConsentModal.tsx` · `SettingsModal.tsx` · `AuditLogViewer.tsx`.
- **STYLE-01 (Med, styling/a11y) ✎** primary-button contrast: filled `--accent`+`--text` is ~2.8:1 →
  switch to accent-on-`--accent-wash` (or a near-`--void` foreground) to pass AA (**mock the two button
  states**) · MCP-05 (low, ux) `maxCallsPerDay` field + usage peek in SettingsModal · MCP-01 (low, a11y)
  fix AuditLogViewer's role (persistent side panel → `role="complementary"`/`region`, not a Modal/dialog).
- ✎ artifact: primary-button default + hover/disabled states at the new contrast.

### PA-9 · Terminal ✎ · `fix/pa9-terminal`
- Owns: `TerminalBoard.tsx` · `boards/terminal/*` · `RecapView.tsx` · `main/pty.ts`.
- TERM-01 (Med, ux) wire the existing `formatTimer` + an elapsed tick into the status pill
  (TerminalBoard ~286 → pass the timer arg to `statusFor`) · PERF-06 (low, perf) replace the PTY
  string-concat ring with a chunk deque, join only on adopt (`main/pty.ts`) · **TERM-02…08
  (VERIFY-FIRST)** re-confirm each against current source before actioning (status label hover-only ·
  `--text-faint` flag hint · exited re-run CTA · recap re-fetch · interrupt confirm · settled-zoom
  fan-out; TERM-07 god-file split last/optional). `log()` anything you drop as unverified.
- ✎ artifact: any TERM item that changes the visible pill/CTA layout.

---

## Queued — depend on PA-1/PA-2 landing first

- **PA-5 · Planning / whiteboard ✎ · `fix/pa5-planning`** (dep: PA-2). PLAN-01 (High, perf) stop
  subscribing to `transform[2]` — read zoom from a ref / `rf.getZoom()` at gesture time in `toBoard`
  (PlanningBoard.tsx:79,160) · PLAN-07 React.memo WhiteboardSvg · PLAN-03 text/diagram shortcuts ·
  PLAN-04 checklist `role="progressbar"` · PLAN-02 labels (inherits PA-2's IconBtn aria-label) · PLAN-05
  ✎ note/checklist width-resize · PLAN-08 ✎ optional arrow label (additive schema bump) · PLAN-06
  empty-state + DESIGN §7.3. Rebase onto merged PA-2 (shared BoardFrame keystone) before code.
- **PA-6 · Groups & connectors ✎ · `fix/pa6-groups-connectors`** (dep: PA-1, PA-2). GROUP-01…07
  (connector drop-target highlight · reject toast · keyboard/palette connector+group ops · single-board
  add-to-group no-repack · per-group remove menu · single-drag reflow scoping). Touches Canvas.tsx
  (PA-1 region ~869-897) + BoardFrame.tsx (PA-2 regions) → rebase after both merge; ✎ mock the
  drop-target highlight + per-group remove menu.
- **PA-R · Token-enforcement lint ratchet · `fix/par-token-lint`** (dep: all). STYLE-02 — a renderer
  `no-restricted-syntax` rule flagging numeric `fontSize`/`borderRadius` + raw hex/rgba in inline
  `style` objects. Start **warn-only**, ratchet to error once the component slices have cleared their
  literals. Runs LAST so it has the fewest violations to clean up.

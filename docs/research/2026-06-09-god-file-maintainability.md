# God-file maintainability — research & improvement plan

**Date:** 2026-06-09 · **Status:** research (no code changed) · **Scope:** the 8 largest source files
**Method:** 6 parallel read-only subagent dissections (one per file group) + a read of the existing
extraction idiom (`canvas/hooks/useTidyTile.ts`, the `*Core` pattern in `pty.ts`) and the Wave-5 B5
kickoff (`docs/reviews/2026-06-05-wave5-b4-b5-kickoff.md`). Line refs captured on `main` @ `6ca45fd`.

---

## TL;DR

The big files are **not rotten** — well-tested, clean seams, security invariants intact. The problem
is that **they regrow**. Wave-5 B5 (2026-06-05) split `Canvas.tsx` / `PlanningBoard.tsx` /
`BrowserPreviewLayer→usePreviewManager` into hooks; the ~9 features merged since (Named Board Groups,
terminal-recap, font-resize, text create/edit, full terminal I/O, browser quick-wins, …) piled new
concerns straight back into the host files.

**Split-without-ratchet always regrows.** The single durable fix is a **file-size lint ratchet** that
freezes each god-file at its current line count and only ever lets it shrink. Everything else
(per-file extractions) is a prioritized backlog that the ratchet makes *stick*.

---

## 1. The cure already exists in this repo

This is not missing knowledge — it's missing **enforcement**. The codebase already has a proven,
three-layer extraction idiom. New work should copy it, not invent.

| Layer | Pattern | Where it lives | Existing examples |
|---|---|---|---|
| **Pure logic** | plain functions, no React / no Electron, fully unit-tested | `lib/*.ts`, `boards/planning/*.ts` | `alignmentGuides` · `cameraBounds` · `previewPlan` · `nodeChanges` · `erase` · `marquee` · `snapping` · `align` · `tileLayout` · `portDetect` · `ptyOutput` |
| **Renderer sub-hooks** | `useX(deps)` returning a thin API; a typed `Deps` interface | `canvas/hooks/use*.ts` · `boards/<type>/use*.ts` | `useFullView` · `useTidyTile` · `useCanvasKeybindings` · `useBoardPlacement` · `usePlanningPointer` · `useTerminalFlip` |
| **MAIN pure cores** | `xCore(args, deps)` pure + a thin wrapper that binds module state | `main/*.ts` | `parkCore` · `adoptCore` · `cleanupCore` · `drainPtyCore` · `disposeAllPtysCore` (pty.ts) · `deriveStatus` (orchestrator) |

**Reference implementation:** `src/renderer/src/canvas/hooks/useTidyTile.ts` — pure `tileArea()`
exported + unit-tested, hook takes a typed `TidyTileDeps`, doc-comment states what is surfaced vs
internal. **Every new extraction should match this shape.**

---

## 2. Root cause — why they regrow

1. **No size gate.** `eslint` runs in CI but there is no `max-lines` rule. Nothing fails when a file
   crosses 1000 lines, so growth is invisible until a review notices.
2. **Feature-adds land in the host file.** Each new concern (recap flip, font resize, text toolbar)
   was wired *inline* into `TerminalBoard.tsx` / `PlanningBoard.tsx` instead of a new sub-hook.
3. **Test-the-host coupling.** Pure functions are exported *from* the big component (`Canvas.tsx`
   exports `applyPush`, `planFullViewAction`, `planNodeRemovalCleanup`). Tests import them from there,
   which quietly discourages moving them to `lib/`. `TerminalBoard.tsx`'s `pasteIntoTerminal` is
   unexported, so `TerminalBoard.paste.test.ts` tests a hand-kept **replica** — already drifted.

---

## 3. Maintenance doctrine

### Rule 1 — File-size lint ratchet (the keystone)
Add an ESLint `max-lines` rule. Global threshold catches new files; a per-file override allowlist
freezes the existing god-files at their **current** count and is only ever edited **downward**.

```js
// eslint.config.mjs (sketch)
rules: { 'max-lines': ['warn', { max: 600, skipBlankLines: true, skipComments: true }] }
// + per-file overrides pinning today's god-files (error if they GROW):
{ files: ['src/renderer/src/canvas/Canvas.tsx'],            rules: { 'max-lines': ['error', 1233] } }
{ files: ['src/renderer/src/canvas/boards/TerminalBoard.tsx'], rules: { 'max-lines': ['error', 1138] } }
// …one line per god-file, set to its current count…
```

Effect: a new file can't silently cross 600; a god-file can't grow past its frozen number. Each
successful extraction lowers its pin. This converts "we split it once" into "it stays split." **Do
this first — without it every extraction below eventually undoes itself.**

### Rule 2 — Extract-on-touch
Adding a **new** concern to a god-file means it goes in a new `use*.ts` / `lib/*.ts`, not inline. The
feature PR pays the small extraction tax. (This rule alone would have prevented all ~9 regrowths.)

### Rule 3 — Test the extracted helper, not a replica
Memory `e2e-evidence-harness` + the Wave-4 false-green lesson: replica tests pass on their own copy.
Export the real function and point the test at it. Fix the existing `pasteIntoTerminal` replica as the
first instance.

### Rule 4 — Security invariants never scatter
`mcpOrchestrator.ts` and `pty.ts` carry ~21 named safety invariants (see Appendix A). A split that
spreads one gate (sanitize → confirm → nonce → audit → write) across two files is an anti-pattern.
Keep each gate **whole**; extract *around* it. The 4× dispatch-gate dedup is the single highest-value
extraction AND the highest-risk — do it **last**, with the existing test suite unchanged as the proof.

### Rule 5 — Close the test gap before the risky extract
Several seams are e2e-only (no unit test). Add the unit test first, then refactor under the net. List
in §5.

---

## 4. Per-file diagnosis

### 4.1 `canvas/Canvas.tsx` — 1233 LOC
RF canvas root: derives nodes/edges from the store, owns canvas pointer/keyboard/camera, composes all
floating chrome. Already delegates full-view/keybindings/tidy/placement to hooks; **group
choreography, `onNodesChange`, digest panel, connector drag** are still inline.

| Seam | Lines | → module | LOC | Risk |
|---|---|---|---|---|
| `applyPush` · `planFullViewAction` · `planNodeRemovalCleanup` (+types) | 99–199 | `lib/canvasDecisions.ts` | ~102 | low (already tested; update import path) |
| 6 group state vars + 5 group callbacks + cleanup effect | 261–278, 603–691 | `canvas/hooks/useGroupInteractions.ts` | ~135 | low (`groups.e2e` covers) |
| `onNodesChange` (drag-snap / resize-snap / intent dispatch) | 441–583 | `canvas/hooks/useOnNodesChange.ts` (+ pure `applyDragSnap`/`applyResizeSnap`) | ~143 | **med** (mutation order is load-bearing; integration gap) |
| digest/prose cluster | 330–387 | `useDigestData` hook | ~58 | low (no test today) |

Smells: `onNodesChange` is 143 LOC / 3 passes; group state fragmented across 6 vars; JSX has an IIFE
computing `rf.flowToScreenPosition` inline (rubber-band SVG).

### 4.2 `boards/TerminalBoard.tsx` — 1138 LOC
xterm board: bridges xterm ⇄ PTY over MessagePort + hosts config/idle/restart/recap/port-picker UI.
Already extracted: `terminalKeymap`, `terminalSelection`, `terminalDrop`, `resumeCommand`,
`terminalState`, `terminalPreview`, `useTerminalFlip`. Still inline: the `spawn` mega-callback, WebGL
pool, preview pickers.

| Seam | Lines | → module | LOC | Risk |
|---|---|---|---|---|
| WebGL budget + `attachWebgl`/`detachWebgl` + LOD effect | 93–117, 243–304 | `boards/terminal/useTerminalWebgl.ts` | ~80 | low (pure move; keep module singleton single-instance) |
| preview/port + browser-connect pickers (state + JSX) | 654–715, 885–980 | `TerminalPreviewPicker` / `useTerminalPreviewPicker` | ~130 | low-med (`previewLink`/`browser` e2e) |
| `spawn` + `respawn` + `restart` + refs | 311–632 | `boards/terminal/useTerminalSpawn.ts` | ~250 | **HIGH** (adopt/idle state machine; e2e-only; real-claude verify) |

Smells: `spawn` is ~250 LOC doing xterm init + MessagePort wiring + ResizeObserver + adopt/idle + full
teardown in one `useCallback` (9 deps); `restart` duplicates the respawn logic; `attachWebglRef`
self-reference dance; **`pasteIntoTerminal` unexported → test is a replica** (fix per Rule 3).

### 4.3 `boards/usePreviewManager.ts` — 1035 LOC
Imperative engine for native `WebContentsView` lifecycle + camera sync. Pure math already in
`cameraBounds` / `previewPlan` / `browserLayout`. Seven concerns fused in one hook.

| Seam | Lines | → module | LOC | Risk |
|---|---|---|---|---|
| geometry callbacks (`boundsFor`, `zoomFor`, `stageScreenRect`, `liveEligible`, `occludesProtected`, `fullViewBoundsFor`) | 218–357 | `lib/previewGeom.ts` (params not closures) | ~140 | low (math tested; add fn tests) |
| `onPreviewEvent` main→renderer handler | 969–1025 | `boards/preview/usePreviewEvents.ts` | ~57 | low — **closes a real gap (no unit test today)** |
| motion: `beginMotion`/`applyLiveness`/`endMotion` + rAF pump + node-gesture effect | 499–709 | `boards/preview/usePreviewMotion.ts` | ~210 | **med** (shares `recs`/`geomRef`/`demoting` refs; preserve attachSeq + demoting-drain invariants) |

Guardrails to keep (memories `preview-camera-sync-rootcause`, `preview-reconcile-only-boards-subscription`):
camera sync stays one `useOnViewportChange({onStart,onChange,onEnd})` (no second slot); reconcile fires
only on a `canvasStore.boards` reference change; `demoting` Set must always drain in `finally` (Bug H1).

### 4.4 `boards/PlanningBoard.tsx` — 1002 LOC
Whiteboard orchestrator. Already extracted: `usePlanningPointer` + the pure `erase`/`marquee`/
`snapping`/`align`/`elements`/`tools`/`textStyle`/`svgPaths`. Confirmed **clean** of the
second-transform full-view anti-pattern (memory `planning-fullview-camera-fit`) — `onFull` just
forwards to `BoardFrame`.

| Seam | Lines | → module | LOC | Risk |
|---|---|---|---|---|
| image I/O (`addImageFromBlob`, paste effect, dragover/drop) | 92–100, 203–295 | `boards/planning/usePlanningImageIO.ts` | ~93 | low (`PlanningBoard.images.test` covers) |
| `buildMenuEntries` context-menu builder | 461–576 | `boards/planning/usePlanningContextMenu.ts` | ~120 | low-med (jsdom offsetWidth=0 hides align bug — add a test) |
| export popover (state + `runExport` + 2 effects + JSX) | 297–357, 666–703 | `boards/planning/ExportPopover.tsx` | ~75 | low — **no test today (add before)** |

Smell: delete logic duplicated between `buildMenuEntries` (557–569) and the inline `onKeyDown`
(787–805) → unify behind a shared `deleteSelection()` in `elements.ts`.

### 4.5 `store/canvasStore.ts` — 944 LOC
Single Zustand store: boards/connectors/groups/selection/tool/viewport/project + undo rails. Prime
candidate for Zustand **slice-pattern** splitting.

| Seam | Lines | → module | LOC | Risk |
|---|---|---|---|---|
| 7 group actions | 541–639 | `store/slices/groupSlice.ts` | ~99 | low (route through `trackedChange`) |
| connector CRUD | 505–539 | `store/slices/connectorSlice.ts` | ~40 | low |
| project/persistence (`applyOpenResult`, `loadObject`, `toObject`) + `idleOnMountIds` | 840–943 | `store/slices/projectSlice.ts` | ~160 | med (shares `set`; dedup the `applyOpenResult` happy-path) |

Keep `trackedChange` + `lastRecorded` in a shared `undo/` module (don't scatter). Known latent edge
(memory `undo-lastrecorded-phantom`): add/remove/duplicate/connector/group pass `reflectPresent:false`
→ a no-op gesture after them can push a phantom step (tolerated; do NOT "fix" to `true` — breaks
granular move-undo). `lastRecorded` + `idleOnMountIds` are module singletons **not reset in
`beforeEach`** → cross-test bleed risk; moving them into a slice makes that visible (net win).

### 4.6 `main/mcpOrchestrator.ts` — 998 LOC  ⚠️ security-sensitive
MCP swarm orchestration over an injected `BoardRegistry`. ~492 LOC is four near-identical dispatch
methods.

| Seam | Lines | → module | LOC | Risk |
|---|---|---|---|---|
| `BoardRegistry` interface + `deriveStatus` + `ConnectorMirrorEntry` | 71–167 | `main/mcpRegistry.ts` | ~90 | very low (types + 1 pure fn) |
| lifecycle: cap/`reconcile`/`reapIdle`/`spawnBoard`/`closeBoard` | 196–489 | `main/mcpLifecycle.ts` | ~200 | med (pass `closeBoard` callback, not `this`) |
| unify 4× dispatch gate (handoff/dispatch/relay/interrupt) | 490–993 | `main/mcpDispatchGate.ts` | ~350 | **HIGH** — security gate; extract LAST, tests unchanged as proof |

### 4.7 `main/pty.ts` — 935 LOC  ⚠️ security-sensitive
node-pty lifecycle. Already uses the `*Core` pattern → cleanest seams of all eight files.

| Seam | Lines | → module | LOC | Risk |
|---|---|---|---|---|
| shell discovery + `safeCwd` + `resolveShell` | 282–439 | `main/ptyShells.ts` | ~160 | **very low** (already exported + unit-tested) |
| session cores + kill-tree | 89–245, 623–740 | `main/ptySession.ts` | ~220 | low (`*Core` already param-injected) |
| `registerPtyHandlers` (IPC surface) | 448–614 | `main/ptyIpc.ts` | ~167 | med (closes over module state; do AFTER the two above) |

Smell: `pty:spawn` handler is one 120-line `ipcMain.handle`. Gap: `enumerateShells` branches +
`recapEnvProvider` exception path untested.

### 4.8 `main/mcpSmoke.ts` — 1221 LOC  (not dissected)
Dev/smoke harness, not a production runtime path. **Triage separately** — likely splits by smoke
scenario, and may be exempt from the runtime ratchet (or pinned but lower priority). Confirm its role
before touching.

---

## 5. Test gaps to close *before* the risky extracts

- `trackedChange` — no direct test (central undo invariant). Add before any store slice split.
- `history.ts` — no `history.test.ts` (HISTORY_LIMIT truncation, `applyUndo`/`applyRedo` null paths).
- `lastRecorded` + `idleOnMountIds` — add explicit reset to the shared `beforeEach`.
- `onNodesChange`, `spawn` state machine, `onPreviewEvent`, `reconcile`, `buildMenuEntries`,
  `runExport` — e2e-only; add unit tests targeting the extracted helper.
- `pasteIntoTerminal` — export it and point `TerminalBoard.paste.test.ts` at the real function.

---

## 6. Prioritized backlog (by risk)

**Tier 0 — guardrail (do first, tiny):** `max-lines` ratchet + this doctrine note.

**Tier 1 — very low / low risk (~850 LOC off the hot files, batchable a few per PR):**
`ptyShells.ts` · `mcpRegistry.ts` · `lib/canvasDecisions.ts` · `lib/previewGeom.ts` ·
`usePreviewEvents.ts` · `usePlanningImageIO.ts` · `groupSlice.ts` + `connectorSlice.ts` ·
`useGroupInteractions.ts` · `useTerminalWebgl.ts` · `ExportPopover.tsx`.

**Tier 2 — medium (one per PR, e2e matrix each, after the §5 tests):**
`useOnNodesChange.ts` · `projectSlice.ts` · `usePreviewMotion.ts` · `mcpLifecycle.ts` ·
`ptySession.ts` · `ptyIpc.ts` · `usePlanningContextMenu.ts` · `TerminalPreviewPicker`.

**Tier 3 — high (isolated PRs, subagent-driven + holistic review):**
`useTerminalSpawn.ts` · `mcpDispatchGate.ts`.

## 7. Sequencing & process
1. Tier 0 ratchet — 1 small PR. Stops the bleeding immediately.
2. Tier 1 — a few per PR, full gate after each.
3. Close §5 test gaps → Tier 2 one-per-PR, **e2e matrix green after each** (these touch the
   preview/whiteboard/PTY sync paths).
4. Tier 3 last, isolated, per the Wave-5 B5 rule (subagent-driven, per-extraction holistic review).

Per repo rules: each lands on a `feat/refactor/*` (or `chore/*`) **worktree off `main`**, sequential
merge, gate re-run after each. No behavior change and no UI change → no design artifact required.
Rebrand #17 still merges last; don't touch `chore/rebrand-expanse`.

---

## Appendix A — security invariants that must NOT scatter across a split

**`mcpOrchestrator.ts`** — fail-closed human confirm on every write (`approved===true`);
terminal-only writes (Browser↛PTY type-check before any side effect); single-use nonce evicted on
every deny path; audit-before-write + audit-on-every-branch; **sanitize before confirm** (CR/LF
injection); opaque-id resolution only (title is display-only); runaway-swarm cap reserved before any
`await` (TOCTOU); relay re-checks the orchestration cable after the confirm await; relay requires a
directional orchestration connector; `closeBoard` frees the cap slot in `finally`; `launchCommand`
exec-vector gated through sanitize→confirm→audit.

**`pty.ts`** — `isForeignSender` as the first line of every IPC handler; shell validated against the
live enumerated list before spawn; `safeCwd` fallback before spawn; identity-guarded cleanup
(`isStaleExit`) so a late OLD-proc exit never kills a respawn; kill the full process tree (taskkill
/T /F · negative pgid), never a bare `kill`; only two PTY write paths (spawn-time `launchCommand` +
the gated MCP `writeToPty`); resize validated at both MessagePort listener sites; `disposeAllPtys`
drains BOTH `sessions` and `parked` on quit; `drainPtyCore` pins the original proc across the grace
window (identity, not presence).

---

## Source agent reports
Six read-only dissections (Canvas · TerminalBoard · usePreviewManager · PlanningBoard · canvasStore ·
mcpOrchestrator+pty), 2026-06-09. Findings condensed above; re-run against the file if line numbers
drift.

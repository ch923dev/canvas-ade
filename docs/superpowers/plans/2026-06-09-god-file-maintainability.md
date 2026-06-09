# God-file Maintainability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install a file-size lint ratchet so the large source files stop regrowing, then take the low-risk (Tier-1) extractions the ratchet will enforce — behavior-preserving, ~1,070 LOC moved off the hot files.

**Architecture:** PR1 adds an ESLint `max-lines` rule (global cap 700 + per-file pins frozen at current size) and merges to `main` as the trunk. Five parallel-safe extraction lanes (PR2–PR6), each owning a **disjoint set of host files**, then fork off `main`, move identified code seams into idiom-matching modules, lower their own pin, and merge **sequentially** (full gate + e2e matrix per merge).

**Tech Stack:** TypeScript (strict), React 18, Zustand, ESLint 10 flat config, Vitest 4, Playwright `_electron` e2e (Win-native + Linux-Docker), pnpm 9, Electron 42.

**Source spec:** `docs/superpowers/specs/2026-06-09-god-file-maintainability-design.md`
**Companion research (seam tables, line refs, security invariants):** `docs/research/2026-06-09-god-file-maintainability.md`

---

## Conventions used by every task

**Behavior-preserving moves.** Tier-1 is pure relocation. Do NOT change logic, signatures' observable behavior, ordering, or comments while moving. Carry doc-comments verbatim with their code.

**Re-confirm line ranges.** Line numbers below were captured on `main` @ `6ca45fd`. Before cutting a block, locate it by **symbol name** (Grep) and use the live range — the file may have drifted.

**Repo idiom for new modules:**
- Pure logic (no React/Electron) → `src/renderer/src/lib/*.ts` or `src/main/*.ts`. Reference: `lib/cameraBounds.ts`.
- Renderer sub-hooks → `src/renderer/src/canvas/hooks/use*.ts` or `boards/<type>/use*.ts`. Reference shape: `canvas/hooks/useTidyTile.ts` (typed `Deps` interface, doc-comment stating what is surfaced vs internal).

**Per-lane gate (run before every push):**
```bash
git config core.hooksPath        # must print: .githooks  (else: git config core.hooksPath .githooks)
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
pnpm test:e2e:matrix             # Win-native + Linux-Docker (Docker Desktop running)
```
`pre-commit` runs the cheap trio (typecheck/lint/format); `pre-push` runs the e2e matrix. Junctioned worktrees on current `main` (post-T9, public `@expanse-ade/mcp`) inherit Electron-42 / Vitest-4 node_modules, so the full local gate works.

**Pin-lowering rule:** every extraction lane lowers its own file's `max-lines` pin in `eslint.config.mjs` **in the same commit** that shrinks the file. Pins move DOWN only.

**Claude PR reviewer:** reply inline on each reviewer comment with its disposition (fix / refactor / declined+reason) per CLAUDE.md.

---

## Task 1: PR1 — the ratchet (trunk → `main`)

This is the only lane that lands directly via a `chore/*` worktree off `main`; it carries no extraction. Merge it first.

**Files:**
- Modify: `eslint.config.mjs` (append a ratchet block before the final `eslintConfigPrettier`)
- Create: `docs/contributing/file-size-doctrine.md`
- Move into this PR (currently uncommitted on `main`): `docs/research/2026-06-09-god-file-maintainability.md`, `docs/superpowers/specs/2026-06-09-god-file-maintainability-design.md`, `docs/superpowers/plans/2026-06-09-god-file-maintainability.md`

- [ ] **Step 1: Create the worktree**

```bash
pwsh .claude/tools/new-worktree.ps1 godfile-ratchet chore/godfile-ratchet
# creates .worktrees/godfile-ratchet off main, junctions node_modules
```
Open the new worktree dir. Add a row to `.claude/coordination/ACTIVE-WORK.md` declaring zone: `eslint.config.mjs` + `docs/`.

- [ ] **Step 2: Measure each source file's eslint-counted size**

Add a TEMPORARY strict rule to measure (do not commit this form). Append to `eslint.config.mjs`:
```js
{ files: ['src/**/*.{ts,tsx}'],
  ignores: ['**/*.test.{ts,tsx}', '**/*.integration.test.{ts,tsx}'],
  rules: { 'max-lines': ['error', { max: 1, skipBlankLines: true, skipComments: true }] } },
```
Run: `pnpm lint 2>&1 | grep "max-lines"`
Expected: one line per source file reporting `File has too many lines (N). Maximum allowed is 1.` — `N` is the eslint-counted size. Record `N` for every file where `N > 700`. Then DELETE the temporary rule.

- [ ] **Step 3: Write the real ratchet block**

> **MEASUREMENT FINDING (2026-06-09, applied).** With `skipComments`+`skipBlankLines`, only **four**
> source files exceed 700 CODE-lines. The other "god-files" are large by `wc -l` but comment-dense, so
> they fall under the global cap and need **no pin** (the cap guards them against future growth):
>
> | File | code-lines | pin |
> |---|---|---|
> | `boards/TerminalBoard.tsx` | 1002 | 1025 |
> | `main/mcpSmoke.ts` | 976 | 1000 |
> | `canvas/Canvas.tsx` | 902 | 925 |
> | `boards/PlanningBoard.tsx` | 828 | 850 |
> | `main/mcpOrchestrator.ts` | 673 | — under cap |
> | `store/canvasStore.ts` | 612 | — under cap |
> | `boards/usePreviewManager.ts` | 597 | — under cap |
> | `main/pty.ts` | 524 | — under cap |
>
> **Downstream impact:** PR2 (pty/mcpOrchestrator), PR4 (usePreviewManager), PR5 (canvasStore) target
> files that are ALREADY under the cap → their "Lower the pin" steps are **no-ops** (no pin exists);
> those extractions become cognitive-load-only (still valuable, not lint-enforced). PR3 (Canvas) and
> PR6 (TerminalBoard, PlanningBoard) DO lower real pins. Re-weigh PR2/PR4/PR5 priority with the user
> after PR1 merges.

The block actually appended to `eslint.config.mjs` (before `eslintConfigPrettier`):
```js
// File-size ratchet — caps new source at 700 CODE lines (blanks + comments skipped) and freezes
// today's code-heavy files. Pins edited DOWNWARD only; delete an entry once it drops under 700.
{
  files: ['src/**/*.{ts,tsx}'],
  ignores: ['**/*.test.{ts,tsx}', '**/*.integration.test.{ts,tsx}'],
  rules: { 'max-lines': ['error', { max: 700, skipBlankLines: true, skipComments: true }] }
},
{ files: ['src/renderer/src/canvas/boards/TerminalBoard.tsx'],
  rules: { 'max-lines': ['error', { max: 1025, skipBlankLines: true, skipComments: true }] } },
{ files: ['src/main/mcpSmoke.ts'],
  rules: { 'max-lines': ['error', { max: 1000, skipBlankLines: true, skipComments: true }] } },
{ files: ['src/renderer/src/canvas/Canvas.tsx'],
  rules: { 'max-lines': ['error', { max: 925, skipBlankLines: true, skipComments: true }] } },
{ files: ['src/renderer/src/canvas/boards/PlanningBoard.tsx'],
  rules: { 'max-lines': ['error', { max: 850, skipBlankLines: true, skipComments: true }] } },
```

- [ ] **Step 4: Verify the gate is green (no-breakage proof)**

Run: `pnpm lint`
Expected: PASS, zero `max-lines` errors (every pinned file sits at-or-below its frozen pin; everything else is under 700).
Run: `pnpm typecheck && pnpm format:check`
Expected: PASS.

- [ ] **Step 5: Write the doctrine note**

Create `docs/contributing/file-size-doctrine.md`:
```markdown
# File-size doctrine

A `max-lines` ESLint rule (`eslint.config.mjs`) caps new source files at 700 code-lines and
freezes today's large files at pinned counts. The five rules that keep files maintainable:

1. **Ratchet.** Pins move DOWN only. Lower a file's pin in the same PR that shrinks it.
2. **Extract-on-touch.** A NEW concern goes in a new `use*.ts` / `lib/*.ts`, never inline into a
   file already near its pin. Reference shape: `canvas/hooks/useTidyTile.ts`.
3. **Test the real extracted symbol, not a replica.** Import the moved function in its test.
4. **Security invariants never scatter.** Keep a whole gate (sanitize→confirm→nonce→audit→write in
   mcpOrchestrator; isForeignSender/kill-tree/identity-cleanup in pty) in one file; extract around it.
5. **Close the test gap before a risky extract.** Add the unit test first, then refactor under it.

Layers: pure logic → `lib/*.ts` (or `main/*.ts`); renderer sub-hooks → `canvas/hooks/use*.ts` or
`boards/<type>/use*.ts`; MAIN pure cores → `xCore(args, deps)` + thin wrapper.
Full backlog + per-file seams: `docs/research/2026-06-09-god-file-maintainability.md`.
```

- [ ] **Step 6: Move the campaign docs into this PR**

```bash
git add eslint.config.mjs docs/contributing/file-size-doctrine.md \
        docs/research/2026-06-09-god-file-maintainability.md \
        docs/superpowers/specs/2026-06-09-god-file-maintainability-design.md \
        docs/superpowers/plans/2026-06-09-god-file-maintainability.md
```

- [ ] **Step 7: Run the full gate + e2e matrix**

Run the per-lane gate (see Conventions). The ratchet changes no runtime code, so e2e is a sanity pass.
Expected: all green.

- [ ] **Step 8: Commit + push + open PR**

```bash
git commit -m "chore(lint): add max-lines ratchet (cap 700 + frozen god-file pins) + file-size doctrine"
git push -u origin chore/godfile-ratchet
gh pr create --base main --title "chore(lint): file-size ratchet + doctrine" \
  --body "Adds max-lines (700 global + per-file pins frozen at current size). Green by construction — pins only error on growth. Carries the god-file research + spec + plan. Trunk for the Tier-1 extraction lanes."
```

- [ ] **Step 9: Merge to `main`, update integration tip**

After CI `check` green + review dispositions replied inline: squash-merge. Update the `## Integration tip` SHA in `ACTIVE-WORK.md`. Tear down the worktree (`pwsh .claude/tools/remove-worktree.ps1 godfile-ratchet`). All extraction lanes fork off this new `main`.

---

## Lane setup (applies to PR2–PR6)

Each lane is one worktree off the post-PR1 `main`. Run PR2–PR5 concurrently (≤4-worktree cap); start PR6 after one frees. Each lane:

```bash
git fetch origin && \
pwsh .claude/tools/new-worktree.ps1 <lane> <branch>   # e.g. godfile-main  feat/refactor-main-extracts
# declare the lane's host-file zone in ACTIVE-WORK.md before editing
```
Merge order is sequential; before merging a lane, rebase it onto current `main`, re-run the full gate + e2e matrix, merge, bump the ACTIVE-WORK integration tip, then the next lane rebases.

---

## Task 2: PR2 — MAIN extracts  (`feat/refactor-main-extracts`)

**Host files owned:** `src/main/pty.ts`, `src/main/mcpOrchestrator.ts`. Both MAIN, both very-low risk (pure helpers / types only). **Security gates are NOT touched** (dispatch gate, nonce/confirm/audit, isForeignSender, kill-tree stay put).

### Task 2.1: Extract shell discovery → `main/ptyShells.ts`

**Files:**
- Create: `src/main/ptyShells.ts`
- Modify: `src/main/pty.ts` (remove the moved fns, import them back) · `eslint.config.mjs` (lower pty.ts pin)
- Test: `src/main/pty.test.ts` (repoint imports — tests already exist)

- [ ] **Step 1: Confirm the seam.** Grep `src/main/pty.ts` for: `canonicalizeShellPath`, `onPath`, `firstFile`, `safeCwd`, `findGitBash`, `findWsl`, `enumerateShells`, `defaultShell`, `resolveShell` (approx lines 282–439). Note which are `export`ed and which `pty.test.ts` imports.

- [ ] **Step 2: Create `src/main/ptyShells.ts`.** Move those 9 functions verbatim (with doc-comments) plus their needed imports (`node:fs`, `node:os`, `node:path`, `node:child_process` execFile if used by them, and any `ShellInfo` type — move or re-export the type). `export` every symbol that `pty.ts` or `pty.test.ts` references.

- [ ] **Step 3: Wire `pty.ts`.** Delete the moved bodies; add at the top:
```ts
import {
  enumerateShells,
  resolveShell,
  safeCwd,
  defaultShell,
  canonicalizeShellPath
  // …plus any others pty.ts still calls
} from './ptyShells'
```
Keep any `ShellInfo` type import too. Leave `registerPtyHandlers` calling `resolveShell(opts.shell, enumerateShells())` and `safeCwd(opts.cwd)` exactly as before (SECURITY: shell-validate + safeCwd before spawn — unchanged).

- [ ] **Step 4: Repoint the test.** In `src/main/pty.test.ts`, change the shell-fn imports from `'./pty'` to `'./ptyShells'`. Do not change any assertions.

- [ ] **Step 5: Run tests.**
Run: `pnpm test src/main/pty.test.ts`
Expected: PASS (a pure move — the existing suite is the regression net).

- [ ] **Step 6: Lower the pin.** In `eslint.config.mjs`, reduce the `src/main/pty.ts` pin to its new measured size (re-run the Step-2 measure trick on pty.ts, or `pnpm lint` and read the reported number, then set the pin just above it). Run `pnpm lint` → PASS.

- [ ] **Step 7: Commit.**
```bash
git add src/main/ptyShells.ts src/main/pty.ts src/main/pty.test.ts eslint.config.mjs
git commit -m "refactor(pty): extract shell discovery to ptyShells.ts"
```

### Task 2.2: Extract `BoardRegistry` + `deriveStatus` → `main/mcpRegistry.ts`

**Files:**
- Create: `src/main/mcpRegistry.ts`
- Modify: `src/main/mcpOrchestrator.ts` · `eslint.config.mjs` (lower its pin)
- Test: Create `src/main/mcpRegistry.test.ts`

- [ ] **Step 1: Confirm the seam.** In `mcpOrchestrator.ts` locate `interface BoardRegistry` (≈71–146), `ConnectorMirrorEntry` (≈ near 146), and `function deriveStatus` (≈159–167). Note the type-only imports they need (`BoardId`/`BoardOutput`/`BoardResult`/`BoardResultInput`/`BoardStatusChange`/`BoardSummary`/`MemoryDoc` from `@expanse-ade/mcp`; `McpCommand`/`McpCommandAck` from `./mcpCommand`; `AuditInput` from `./auditLog`).

- [ ] **Step 2: Write the failing test.** Create `src/main/mcpRegistry.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { deriveStatus } from './mcpRegistry'

describe('deriveStatus', () => {
  const noSessions = new Map<string, string>()
  it('prefers the renderer-supplied bucket', () => {
    expect(deriveStatus({ id: 'a', type: 'terminal', status: 'attention' }, noSessions)).toBe('attention')
  })
  it('terminal with a running PTY session → running, else idle', () => {
    expect(deriveStatus({ id: 'a', type: 'terminal' }, new Map([['a', 'running']]))).toBe('running')
    expect(deriveStatus({ id: 'a', type: 'terminal' }, noSessions)).toBe('idle')
  })
  it('browser → idle, planning/unknown → static', () => {
    expect(deriveStatus({ id: 'b', type: 'browser' }, noSessions)).toBe('idle')
    expect(deriveStatus({ id: 'p', type: 'planning' }, noSessions)).toBe('static')
  })
})
```

- [ ] **Step 2b: Run it to confirm it fails.**
Run: `pnpm test src/main/mcpRegistry.test.ts`
Expected: FAIL — `Failed to resolve import "./mcpRegistry"`.

- [ ] **Step 3: Create `src/main/mcpRegistry.ts`.** Move `BoardRegistry`, `ConnectorMirrorEntry`, and `deriveStatus` verbatim with their type-only imports. `export interface BoardRegistry`, `export type ConnectorMirrorEntry`, `export function deriveStatus`.

- [ ] **Step 4: Wire `mcpOrchestrator.ts`.** Delete the moved declarations; add:
```ts
import { type BoardRegistry, type ConnectorMirrorEntry, deriveStatus } from './mcpRegistry'
```
(Drop now-unused type imports from `mcpOrchestrator.ts` that only `BoardRegistry` needed — let `pnpm lint` flag them.)

- [ ] **Step 5: Run tests.**
Run: `pnpm test src/main/mcpRegistry.test.ts src/main/mcpOrchestrator.test.ts`
Expected: PASS.

- [ ] **Step 6: Lower the `mcpOrchestrator.ts` pin** (measure → set just above). `pnpm lint` → PASS.

- [ ] **Step 7: Commit.**
```bash
git add src/main/mcpRegistry.ts src/main/mcpRegistry.test.ts src/main/mcpOrchestrator.ts eslint.config.mjs
git commit -m "refactor(mcp): extract BoardRegistry + deriveStatus to mcpRegistry.ts"
```

- [ ] **Step 8 (lane close): full gate + e2e matrix, push, PR, merge.** See Conventions + Lane setup.

---

## Task 3: PR3 — Canvas extracts  (`feat/refactor-canvas-extracts`)

**Host file owned:** `src/renderer/src/canvas/Canvas.tsx` only.

### Task 3.1: Extract pure decisions → `lib/canvasDecisions.ts`

**Files:**
- Create: `src/renderer/src/lib/canvasDecisions.ts`
- Modify: `Canvas.tsx` · `eslint.config.mjs`
- Test: `Canvas.fullview.test.ts`, `Canvas.pushundo.test.ts` (repoint imports — already exist)

- [ ] **Step 1: Confirm the seam.** In `Canvas.tsx` locate `planFullViewAction` (≈115–128), `planNodeRemovalCleanup` (≈142–151), `applyPush` + `ApplyPushDeps` (≈154–199), and their types (`FullViewAction`, `RemovalCleanupAction`). Confirm `Canvas.fullview.test.ts` imports `planFullViewAction` and `Canvas.pushundo.test.ts` imports `applyPush` + `planNodeRemovalCleanup` + `ApplyPushDeps`.

- [ ] **Step 2: Create `src/renderer/src/lib/canvasDecisions.ts`.** Move those functions + types verbatim with their imports (`previewStore`, `canvasStore`, `boardSchema`). `export` each.

- [ ] **Step 3: Wire `Canvas.tsx`.** Delete the moved bodies; add:
```ts
import {
  applyPush,
  planFullViewAction,
  planNodeRemovalCleanup,
  type ApplyPushDeps,
  type FullViewAction
} from '../lib/canvasDecisions'
```

- [ ] **Step 4: Repoint tests.** Change the imports in `Canvas.fullview.test.ts` and `Canvas.pushundo.test.ts` from `'./Canvas'`/`'../canvas/Canvas'` to the new `lib/canvasDecisions` path. No assertion changes.

- [ ] **Step 5: Run tests.**
Run: `pnpm test Canvas.fullview Canvas.pushundo`
Expected: PASS.

- [ ] **Step 6: Lower the `Canvas.tsx` pin.** `pnpm lint` → PASS.

- [ ] **Step 7: Commit.**
```bash
git add src/renderer/src/lib/canvasDecisions.ts src/renderer/src/canvas/Canvas.tsx \
        src/renderer/src/canvas/Canvas.fullview.test.ts src/renderer/src/canvas/Canvas.pushundo.test.ts \
        eslint.config.mjs
git commit -m "refactor(canvas): extract pure decisions to lib/canvasDecisions.ts"
```

### Task 3.2: Extract group choreography → `canvas/hooks/useGroupInteractions.ts`

**Files:**
- Create: `src/renderer/src/canvas/hooks/useGroupInteractions.ts`
- Modify: `Canvas.tsx` · `eslint.config.mjs`
- Test: Create `src/renderer/src/canvas/hooks/useGroupInteractions.test.ts` (closes the `reflowAddToGroup` gap)

- [ ] **Step 1: Confirm the seam.** In `Canvas.tsx` locate the 6 group state vars (`namingGroupId`, `namePopAt`, `pickerAt`, `groupMenu`, `reflowing`, `dropTargetGroupId`) + `reflowTimerRef` (≈261–278), the 5 callbacks `groupSelection`/`fitGroup`/`selectGroupMembers`/`focusGroup`/`reflowAddToGroup` (≈603–691), the group cleanup effect, and the `onNodeDrag` drop-target hit-test. Note every store action + value they close over (`addGroup`, `addBoardsToGroupReflowed`, `removeBoardFromGroup`, `rf`, `boards`, `groups`, …).

- [ ] **Step 2: Write the failing test.** Create `useGroupInteractions.test.ts` covering the pure absorb decision. If `reflowAddToGroup`'s reflow math already lives in `lib/groupReflow.ts` (it does — `addBoardsToGroupReflowed` calls it), test the hook's wiring by rendering it with `@testing-library/react`'s `renderHook`, seeding the store with 2 boards + 1 group, calling the returned `reflowAddToGroup(groupId, [boardId])`, and asserting `useCanvasStore.getState().groups` gained the member and a position reflow ran. Stub `rf` (`useReactFlow`) minimally.
```ts
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasStore } from '../../store/canvasStore'
import { useGroupInteractions } from './useGroupInteractions'
// …seed store, render hook with a stub deps object, call reflowAddToGroup, assert membership…
```
(Write the full body against the real returned API once Step 3 fixes the signature.)

- [ ] **Step 2b: Run it.** Expected: FAIL — module not found.

- [ ] **Step 3: Create the hook** following the `useTidyTile.ts` shape: a typed `GroupInteractionsDeps` interface (`rf`, `paneRef`, setters the JSX needs) and a return object exposing `{ namingGroupId, namePopAt, pickerAt, groupMenu, dropTargetGroupId, groupSelection, fitGroup, selectGroupMembers, focusGroup, reflowAddToGroup, onNodeDragGroupHitTest, closeGroupMenu, … }`. Move the 6 state vars + `reflowTimerRef` + 5 callbacks + cleanup effect verbatim into the hook body.

- [ ] **Step 4: Wire `Canvas.tsx`.** Replace the removed declarations with one call:
```ts
const groups = useGroupInteractions({ rf, paneRef /*, …setters as designed*/ })
```
Repoint JSX (`GroupNamePopover`, `GroupFocusPicker`, `GroupContextMenu`, the FAB) to read from `groups.*`. Keep `onNodeDrag`/`onNodeDragStop` calling the hook's hit-test exactly as before.

- [ ] **Step 5: Finish + run the test** from Step 2 against the real return shape.
Run: `pnpm test useGroupInteractions`
Expected: PASS.

- [ ] **Step 6: Lower the `Canvas.tsx` pin** again (it shrank further). `pnpm lint` → PASS.

- [ ] **Step 7: Commit.**
```bash
git add src/renderer/src/canvas/hooks/useGroupInteractions.ts \
        src/renderer/src/canvas/hooks/useGroupInteractions.test.ts \
        src/renderer/src/canvas/Canvas.tsx eslint.config.mjs
git commit -m "refactor(canvas): extract group choreography to useGroupInteractions"
```

- [ ] **Step 8 (lane close): full gate + e2e matrix (run `groups.e2e.ts` especially), push, PR, merge.**

---

## Task 4: PR4 — Preview extracts  (`feat/refactor-preview-extracts`)

**Host file owned:** `src/renderer/src/canvas/boards/usePreviewManager.ts` only. Carry the constraints: one `useOnViewportChange` slot; reconcile stays boards-ref-gated; `demoting` drains in `finally`.

### Task 4.1: Extract geometry math → `lib/previewGeom.ts`

**Files:**
- Create: `src/renderer/src/lib/previewGeom.ts`
- Modify: `usePreviewManager.ts` · `eslint.config.mjs`
- Test: Create `src/renderer/src/lib/previewGeom.test.ts`

- [ ] **Step 1: Confirm the seam.** Locate `boundsFor`, `zoomFor`, `stageScreenRect`, `fullViewBoundsFor`, `liveEligible`, `occludesProtected` (≈218–357). They are `useCallback`s closing over `getViewport()`, `paneOffset` ref, and a few refs.

- [ ] **Step 2: Convert closures to pure params.** In `previewGeom.ts`, define each as a plain function taking the closed-over values as explicit args, e.g.:
```ts
import { roundRect, worldRectToScreen, rectsEqual, fitZoomFactorForBounds } from './cameraBounds'
import { VIEWPORT_PRESETS, deviceStageRect, toWorldRect } from './browserLayout'
import { isLiveEligible, shouldDemoteForOcclusion } from './previewPlan'
import type { Viewport } from '@xyflow/react'

export function boundsFor(board: BoardGeom, viewport: Viewport, paneOffset: PaneOffset): ScreenRect { /* moved body, paneOffset.current → paneOffset */ }
export function zoomFor(board: BoardGeom, viewport: Viewport, paneOffset: PaneOffset): number { /* … */ }
// …stageScreenRect, liveEligible, occludesProtected likewise; fullViewBoundsFor takes the host element.
```
Move the `BoardGeom`/`PaneOffset`/`ScreenRect` types too (or import them).

- [ ] **Step 3: Write the test** (no DOM needed for the pure ones):
```ts
import { describe, it, expect } from 'vitest'
import { boundsFor, zoomFor } from './previewGeom'
// seed a BoardGeom + a Viewport {x,y,zoom} + paneOffset {x:0,y:0}; assert boundsFor returns the
// expected rounded screen rect and zoomFor returns the expected fit zoom factor.
```
Run: Expected FAIL (module not found) → after Step 4, PASS.

- [ ] **Step 4: Wire `usePreviewManager.ts`.** Replace each removed `useCallback` with a thin local wrapper that supplies the live values, e.g.:
```ts
import * as geom from '../../lib/previewGeom'
const boundsFor = useCallback(
  (b: BoardGeom) => geom.boundsFor(b, getViewport(), paneOffset.current),
  [getViewport]
)
```
Keep call sites (`flushBatch`, `applyLiveness`, reconcile) unchanged.

- [ ] **Step 5: Run tests.**
Run: `pnpm test previewGeom usePreviewManager`
Expected: PASS (incl. the BUG-002 race integration test).

- [ ] **Step 6: Lower the pin.** `pnpm lint` → PASS.

- [ ] **Step 7: Commit.**
```bash
git add src/renderer/src/lib/previewGeom.ts src/renderer/src/lib/previewGeom.test.ts \
        src/renderer/src/canvas/boards/usePreviewManager.ts eslint.config.mjs
git commit -m "refactor(preview): extract geometry math to lib/previewGeom.ts"
```

### Task 4.2: Extract the main→renderer event handler → `boards/preview/usePreviewEvents.ts`

**Files:**
- Create: `src/renderer/src/canvas/boards/preview/usePreviewEvents.ts`
- Modify: `usePreviewManager.ts` · `eslint.config.mjs`
- Test: Create `src/renderer/src/canvas/boards/preview/usePreviewEvents.test.tsx` (closes a real gap)

- [ ] **Step 1: Confirm the seam.** Locate the `onPreviewEvent` effect (≈969–1025). It reads `recs.current`, `patchRuntime`, `patchRuntimeIfPresent`, `fullViewIdRef`, `onCloseFullViewRef`, and registers `window.api.onPreviewEvent`.

- [ ] **Step 2: Write the failing test.** Mock `window.api.onPreviewEvent` to capture the listener; render `usePreviewEvents(...)` with a fake `recs` map + spies; fire each event variant (`did-finish-load`, `did-navigate`, `did-fail-load`, `did-start-navigation`, `escape`) and assert the right `patchRuntime`/`patchRuntimeIfPresent`/close-fullview calls (incl. the Bug-#32 orphan guard: an event for an id absent from `recs` must NOT resurrect it).
```ts
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { usePreviewEvents } from './usePreviewEvents'
// stub window.api.onPreviewEvent → return unsub; capture handler; drive events; assert.
```
Run: Expected FAIL (module not found).

- [ ] **Step 3: Create the hook.** `usePreviewEvents({ recs, patchRuntime, patchRuntimeIfPresent, fullViewIdRef, onCloseFullViewRef })` — one `useEffect` registering the listener, body moved verbatim, returns nothing.

- [ ] **Step 4: Wire `usePreviewManager.ts`.** Replace the inline effect with:
```ts
usePreviewEvents({ recs, patchRuntime, patchRuntimeIfPresent, fullViewIdRef, onCloseFullViewRef })
```

- [ ] **Step 5: Run tests.**
Run: `pnpm test usePreviewEvents usePreviewManager`
Expected: PASS.

- [ ] **Step 6: Lower the pin.** `pnpm lint` → PASS.

- [ ] **Step 7: Commit.**
```bash
git add src/renderer/src/canvas/boards/preview/usePreviewEvents.ts \
        src/renderer/src/canvas/boards/preview/usePreviewEvents.test.tsx \
        src/renderer/src/canvas/boards/usePreviewManager.ts eslint.config.mjs
git commit -m "refactor(preview): extract onPreviewEvent handler to usePreviewEvents (+ unit test)"
```

- [ ] **Step 8 (lane close): full gate + e2e matrix (run `preview-align.e2e.ts`, `browser.e2e.ts`, `fullview.e2e.ts`), push, PR, merge.**

---

## Task 5: PR5 — Store slices  (`feat/refactor-store-slices`)

**Host file owned:** `src/renderer/src/store/canvasStore.ts` only. **Use dependency injection — do NOT create shared mutable module state.** `trackedChange` + `lastRecorded` stay in `canvasStore.ts`; slices receive `trackedChange` (and `newId`) as parameters, avoiding the `lastRecorded` cross-module-mutation hazard.

### Task 5.1: Extract the group slice → `store/slices/groupSlice.ts`

**Files:**
- Create: `src/renderer/src/store/slices/groupSlice.ts`
- Modify: `canvasStore.ts` · `eslint.config.mjs`
- Test: `canvasStore.test.ts` (unchanged — drives the combined store)

- [ ] **Step 1: Confirm the seam.** Locate the 7 group actions in the `create` object literal: `addGroup`, `removeGroup`, `renameGroup`, `addBoardsToGroup`, `addBoardsToGroupReflowed`, `removeBoardFromGroup`, `removeBoardFromAllGroups` (≈541–639). Note they call `trackedChange`, `newId`, and read `s.groups`/`s.boards`.

- [ ] **Step 2: Define the slice factory.** In `groupSlice.ts`:
```ts
import type { StoreApi } from 'zustand'
import type { CanvasState } from '../canvasStore'   // type-only → no runtime cycle
import type { NamedGroup, Board, Connector } from '../../lib/boardSchema'

type Tracked = (
  s: CanvasState,
  next: { boards?: Board[]; connectors?: Connector[]; groups?: NamedGroup[] } | null,
  opts: { selection?: { selectedId: string | null; selectedIds: string[] }; reflectPresent: boolean }
) => Partial<CanvasState> | CanvasState

type GroupActions = Pick<CanvasState,
  'addGroup' | 'removeGroup' | 'renameGroup' | 'addBoardsToGroup' |
  'addBoardsToGroupReflowed' | 'removeBoardFromGroup' | 'removeBoardFromAllGroups'>

export function createGroupSlice(
  set: StoreApi<CanvasState>['setState'],
  get: StoreApi<CanvasState>['getState'],
  deps: { trackedChange: Tracked; newId: () => string }
): GroupActions {
  const { trackedChange, newId } = deps
  return {
    addGroup: (name, boardIds) => { /* moved body verbatim, using trackedChange/newId */ },
    // …the other 6 actions, moved verbatim…
  }
}
```
(Match `Tracked` to the real `trackedChange` signature in `canvasStore.ts` — copy it exactly.)

- [ ] **Step 3: Wire `canvasStore.ts`.** `export` the `CanvasSnapshot` and `CanvasState` types (if not already) and `export function trackedChange`/`export const newId` so the type-only + injected references resolve. In the `create` call, replace the 7 inline group actions with a spread:
```ts
export const useCanvasStore = create<CanvasState>((set, get) => ({
  /* …state + non-group actions… */
  ...createGroupSlice(set, get, { trackedChange, newId }),
}))
```
Add `import { createGroupSlice } from './slices/groupSlice'` at top.

- [ ] **Step 4: Run tests.**
Run: `pnpm test canvasStore persistence.integration`
Expected: PASS (the 15 group tests + sweeps + round-trip all drive the combined store unchanged).

- [ ] **Step 5: Lower the pin.** `pnpm lint` → PASS.

- [ ] **Step 6: Commit.**
```bash
git add src/renderer/src/store/slices/groupSlice.ts src/renderer/src/store/canvasStore.ts eslint.config.mjs
git commit -m "refactor(store): extract group actions to groupSlice (injected trackedChange)"
```

### Task 5.2: Extract the connector slice → `store/slices/connectorSlice.ts`

**Files:**
- Create: `src/renderer/src/store/slices/connectorSlice.ts`
- Modify: `canvasStore.ts` · `eslint.config.mjs`
- Test: `canvasStore.test.ts` (unchanged)

- [ ] **Step 1: Confirm the seam.** Locate `addConnector` (≈506–528) + `removeConnector` (≈530–540). Note `addConnector` validates self-link/missing-endpoint/duplicate against `get()` and mints `newId()`.

- [ ] **Step 2: Create the slice** mirroring 5.1's factory shape (`createConnectorSlice(set, get, { trackedChange, newId })`) returning `Pick<CanvasState, 'addConnector' | 'removeConnector'>`. Move both bodies verbatim.

- [ ] **Step 3: Wire `canvasStore.ts`.** Spread `...createConnectorSlice(set, get, { trackedChange, newId })` into `create`; remove the inline pair; add the import.

- [ ] **Step 4: Run tests.**
Run: `pnpm test canvasStore`
Expected: PASS (the 9 connector tests unchanged).

- [ ] **Step 5: Lower the pin.** `pnpm lint` → PASS.

- [ ] **Step 6: Commit.**
```bash
git add src/renderer/src/store/slices/connectorSlice.ts src/renderer/src/store/canvasStore.ts eslint.config.mjs
git commit -m "refactor(store): extract connector actions to connectorSlice"
```

- [ ] **Step 7 (lane close): full gate + e2e matrix, push, PR, merge.**

---

## Task 6: PR6 — Board extracts  (`feat/refactor-board-extracts`)

**Host files owned:** `src/renderer/src/canvas/boards/TerminalBoard.tsx` + `src/renderer/src/canvas/boards/PlanningBoard.tsx` (disjoint from all other lanes). Carry the constraint: Planning full-view stays a camera fit (no portal/CSS-transform).

### Task 6.1: Extract the WebGL pool → `boards/terminal/useTerminalWebgl.ts`

**Files:**
- Create: `src/renderer/src/canvas/boards/terminal/useTerminalWebgl.ts`
- Modify: `TerminalBoard.tsx` · `eslint.config.mjs`
- Test: covered by `terminal.e2e.ts` (runtime-only; no new unit test required — note in PR body)

- [ ] **Step 1: Confirm the seam.** Locate the module-level WebGL budget (`WEBGL_BUDGET`, `liveWebgl`, `wantWebgl`, `acquireWebglSlot`, `releaseWebglSlot`, ≈93–117), the `attachWebgl`/`detachWebgl` callbacks + `attachWebglRef` sync effect (≈243–295), and the LOD attach/detach effect (≈298–304).

- [ ] **Step 2: Create the hook.** `useTerminalWebgl(boardId: string, lodRef: RefObject<boolean>): { attachWebgl, detachWebgl }`. Keep the budget singletons (`liveWebgl`, `wantWebgl`) at **module scope in the new file** (single instance — they coordinate across all terminal boards). Move the callbacks + `attachWebglRef` dance + LOD effect verbatim.

- [ ] **Step 3: Wire `TerminalBoard.tsx`.** Replace the removed code with:
```ts
const { attachWebgl, detachWebgl } = useTerminalWebgl(board.id, lodRef)
```
Pass `attachWebgl`/`detachWebgl` to the spawn/teardown paths exactly as before.

- [ ] **Step 4: Typecheck + lint.**
Run: `pnpm typecheck && pnpm lint`
Expected: PASS. (No unit test — GL pooling is runtime; `terminal.e2e.ts` exercises it.)

- [ ] **Step 5: Lower the `TerminalBoard.tsx` pin.** `pnpm lint` → PASS.

- [ ] **Step 6: Commit.**
```bash
git add src/renderer/src/canvas/boards/terminal/useTerminalWebgl.ts \
        src/renderer/src/canvas/boards/TerminalBoard.tsx eslint.config.mjs
git commit -m "refactor(terminal): extract WebGL pool to useTerminalWebgl"
```

### Task 6.2: Fix the `pasteIntoTerminal` replica (test-the-real-symbol)

**Files:**
- Modify: `TerminalBoard.tsx` (export `pasteIntoTerminal`) · `TerminalBoard.paste.test.ts` (import the real fn)

- [ ] **Step 1:** In `TerminalBoard.tsx`, add `export` to the file-scope `pasteIntoTerminal` (≈123–141).
- [ ] **Step 2:** In `TerminalBoard.paste.test.ts`, delete the hand-kept replica (≈25–43) and `import { pasteIntoTerminal } from './TerminalBoard'`. Point the existing assertions at the real fn.
- [ ] **Step 3: Run.** `pnpm test TerminalBoard.paste` → Expected PASS (now testing the real function).
- [ ] **Step 4: Commit.**
```bash
git add src/renderer/src/canvas/boards/TerminalBoard.tsx src/renderer/src/canvas/boards/TerminalBoard.paste.test.ts
git commit -m "test(terminal): test the real pasteIntoTerminal, drop the replica"
```

### Task 6.3: Extract Planning image I/O → `boards/planning/usePlanningImageIO.ts`

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/usePlanningImageIO.ts`
- Modify: `PlanningBoard.tsx` · `eslint.config.mjs`
- Test: `PlanningBoard.images.test.tsx` (unchanged — renders the real PlanningBoard)

- [ ] **Step 1: Confirm the seam.** Locate `imageExt` (module-level ≈92–100), `addImageFromBlob` (≈204–238), the `onWellPaste` callback + its registration effect (≈248–277), `onWellDragOver` (≈280–283), `onWellDrop` (≈285–295).

- [ ] **Step 2: Create the hook.** `usePlanningImageIO({ wellRef, toBoard, commit, beginChange, board }): { onWellDragOver, onWellDrop }` — register the paste effect internally; move `imageExt` + `addImageFromBlob` into the file. Follow `useTidyTile.ts` shape.

- [ ] **Step 3: Wire `PlanningBoard.tsx`.** Replace the removed code with:
```ts
const { onWellDragOver, onWellDrop } = usePlanningImageIO({ wellRef, toBoard, commit, beginChange, board })
```
Keep the `.pl-well` JSX handlers pointing at `onWellDragOver`/`onWellDrop`.

- [ ] **Step 4: Run tests.**
Run: `pnpm test PlanningBoard.images`
Expected: PASS (paste + drop + asset-error + bitmap sizing, unchanged).

- [ ] **Step 5: Lower the `PlanningBoard.tsx` pin.** `pnpm lint` → PASS.

- [ ] **Step 6: Commit.**
```bash
git add src/renderer/src/canvas/boards/planning/usePlanningImageIO.ts \
        src/renderer/src/canvas/boards/PlanningBoard.tsx eslint.config.mjs
git commit -m "refactor(planning): extract image I/O to usePlanningImageIO"
```

### Task 6.4: Extract the export popover → `boards/planning/ExportPopover.tsx`

**Files:**
- Create: `src/renderer/src/canvas/boards/planning/ExportPopover.tsx`
- Modify: `PlanningBoard.tsx` · `eslint.config.mjs`
- Test: Create `src/renderer/src/canvas/boards/planning/ExportPopover.test.tsx` (closes a gap)

- [ ] **Step 1: Confirm the seam.** Locate `exportOpen`/`exportPos`/`exportTriggerRef` state (≈300–305), `runExport` (≈306–331), the close-on-escape + position effects (≈332–357), and the portaled popover JSX inside `actions` (≈666–703).

- [ ] **Step 2: Write the failing test.** Render `<ExportPopover board={seedPlanningBoard()} />`, open it, click an export option, and assert `window.api.export.save` is invoked with the expected payload (mock `window.api.export.save` + the dynamic `import('./exportBoard')`).
```ts
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ExportPopover } from './ExportPopover'
// mock window.api.export.save; render; open; click PNG; assert save called.
```
Run: Expected FAIL (module not found).

- [ ] **Step 3: Create the component.** `ExportPopover({ board }: { board: PlanningBoardData })` owns `exportOpen`/`exportPos`/`exportTriggerRef` + `runExport` + both effects + the trigger button + the portaled menu. Self-contained.

- [ ] **Step 4: Wire `PlanningBoard.tsx`.** Replace the inline state/effects/JSX with `<ExportPopover board={board} />` inside the `actions` block. Remove the now-dead state + effects.

- [ ] **Step 5: Run tests.**
Run: `pnpm test ExportPopover PlanningBoard.interaction`
Expected: PASS.

- [ ] **Step 6: Lower the `PlanningBoard.tsx` pin** (shrank again). `pnpm lint` → PASS.

- [ ] **Step 7: Commit.**
```bash
git add src/renderer/src/canvas/boards/planning/ExportPopover.tsx \
        src/renderer/src/canvas/boards/planning/ExportPopover.test.tsx \
        src/renderer/src/canvas/boards/PlanningBoard.tsx eslint.config.mjs
git commit -m "refactor(planning): extract ExportPopover (+ unit test)"
```

- [ ] **Step 8 (lane close): full gate + e2e matrix (run `terminal.e2e.ts`, `terminalIO.e2e.ts`, `whiteboard.e2e.ts`, `textCreate.e2e.ts`), push, PR, merge.**

---

## Final verification (after all lanes merged)

- [ ] On `main`: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm test:e2e:matrix` — all green.
- [ ] Confirm each of the 8 god-files' pin is now lower than its PR1 freeze value (Canvas, TerminalBoard, usePreviewManager, PlanningBoard, canvasStore, pty; mcpOrchestrator). `mcpSmoke.ts` pin unchanged (deferred to Tier-2).
- [ ] Update `docs/research/2026-06-09-god-file-maintainability.md` status note: Tier-1 shipped; Tier-2/3 remain.
- [ ] Append the campaign to `docs/archive/build-history.md` and update `ACTIVE-WORK.md`.

---

## Out of scope (future plans — do NOT start here)

- **Tier 2 (medium):** `useOnNodesChange` · store `projectSlice` · `usePreviewMotion` · `mcpLifecycle` · `ptySession`/`ptyIpc` · `usePlanningContextMenu` · `TerminalPreviewPicker`, preceded by the deferred test gaps (`trackedChange` direct test · `history.test.ts` · `lastRecorded`/`idleOnMountIds` `beforeEach` reset).
- **Tier 3 (high-risk):** `useTerminalSpawn` · `mcpDispatchGate` (the 4× security gate — extract last with the existing suite unchanged as proof).
- **Rebrand #17 still merges LAST** — do not touch `chore/rebrand-expanse`.

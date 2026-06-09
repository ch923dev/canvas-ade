# Design — God-file maintainability (Tier 0 + Tier 1)

**Date:** 2026-06-09 · **Status:** design (approved in brainstorm; spec under user review)
**Companion research:** `docs/research/2026-06-09-god-file-maintainability.md` (root-cause + full per-file
seam tables + the ~21 security invariants). This spec is the *actionable plan* derived from it.
**Scope of THIS spec:** Tier 0 (size-ratchet guardrail) + Tier 1 (the low-risk extractions only).
Tier 2 (medium) and Tier 3 (high-risk: `useTerminalSpawn`, `mcpDispatchGate`) are **out of scope** —
each gets its own later spec.

---

## 1. Problem & goal

The 8 largest source files regrow after every split because there is **no size gate** — Wave-5 B5
split them (2026-06-05) and ~9 features since piled new concerns back in. The files are healthy
(tested, clean seams, invariants intact); the failure mode is *drift*, not rot.

**Goal:** install a durable guardrail that makes "split" stick, then take the low-risk extractions
that the guardrail will enforce. Behavior-preserving throughout — **no UX change, no API change, no
semantic change.**

**Success criteria:**
- A file-size lint rule is in the CI `check` gate; `main` is green on landing (no breakage).
- No source file can grow past its frozen pin; no new source file can cross the global cap.
- ~1,000 LOC moved off the hot files into focused, idiom-matching modules, each behind a real test
  (sum of the §4 extracts ≈ 1,070).
- Full gate + e2e matrix green after every lane merge.

---

## 2. The ratchet (Tier 0 — PR1, the trunk)

**Mechanism:** one ESLint `max-lines` rule added to the existing flat config (`eslint.config.mjs`),
riding the existing `pnpm lint` / CI `check` gate. No new tooling (Approach A).

- **Global cap:** `max-lines: ['error', { max: 700, skipBlankLines: true, skipComments: true }]` over
  `src/**/*.{ts,tsx}`. New source files cannot cross 700.
- **Tests exempt:** override `**/*.test.{ts,tsx}` + `**/*.integration.test.{ts,tsx}` → `max-lines:
  'off'`. Large test files are healthy (`canvasStore.test.ts` = 1524) and are not a maintainability
  target.
- **Per-file pins:** every source file whose **eslint-measured** count currently exceeds 700 gets an
  `error`-level override pinned at **its current count rounded up to the next 25** (small headroom so
  an incidental 1-line edit by an unrelated in-flight branch doesn't error, while real growth still
  hard-stops). Expected set ≈ the 8 god-files incl. `mcpSmoke.ts`. Counts are measured at freeze time
  by running lint once and reading each reported number — **not** `wc -l` (blanks/comments are skipped
  and these files are comment-dense).
- **Ratchet invariant:** a pin is only ever edited **downward**. Each Tier-1 lane that shrinks a file
  lowers that file's pin **in the same PR**.

**No-breakage guarantee:** pins freeze each file at its current size, so the moment PR1 lands every
file sits *at* its pin and `eslint .` is green. The rule only errors when a file later **grows past**
its pin (the intended behavior). Measure-then-pin every >700 file so nothing is over on day one.

**Config sketch** (appended after the existing blocks, before `eslintConfigPrettier`):
```js
// File-size ratchet — freeze today's large files, hard-cap new source at 700.
// Pins are edited DOWNWARD only; lower a file's pin in the same PR that shrinks it.
{
  files: ['src/**/*.{ts,tsx}'],
  ignores: ['**/*.test.{ts,tsx}', '**/*.integration.test.{ts,tsx}'],
  rules: { 'max-lines': ['error', { max: 700, skipBlankLines: true, skipComments: true }] }
},
// One pin per file currently >700 (measured at freeze, rounded up to next 25). e.g.:
{ files: ['src/renderer/src/canvas/Canvas.tsx'],
  rules: { 'max-lines': ['error', { max: /*frozen*/, skipBlankLines: true, skipComments: true }] } },
// …Canvas.tsx · mcpSmoke.ts · TerminalBoard.tsx · usePreviewManager.ts · PlanningBoard.tsx ·
//   mcpOrchestrator.ts · canvasStore.ts · pty.ts (and any other measured >700)…
```

**PR1 also carries** a short doctrine note in `docs/` (the 5 maintenance rules: ratchet ·
extract-on-touch · test-the-helper · invariants-never-scatter · close-gap-before-risky-extract) so
future feature work follows it. PR1 = ratchet + pins + doctrine note **only** (no extractions).

---

## 3. Integration strategy (A — trunk on main)

PR1 (ratchet) merges to `main` first — small, fast review, green by construction. The five extraction
lanes then fork off `main` and merge **sequentially**, each with a full gate + e2e re-run (repo rule:
board components interact even when files are disjoint). Parallelism buys **development throughput, not
merge speed**.

---

## 4. Extraction map (Tier 1 — 5 parallel-safe lanes, PR2–PR6)

Lanes are grouped so each **owns a disjoint set of host files** → they develop concurrently with zero
code collision. The only shared touch is each lane lowering **its own** pin line in
`eslint.config.mjs` (distinct lines → trivial sequential-merge resolve). New modules follow the repo
idiom: pure logic → `lib/*.ts`; renderer sub-hooks → `canvas/hooks/use*.ts` or
`boards/<type>/use*.ts`; reference shape = `canvas/hooks/useTidyTile.ts`.

| Lane | Owns (host files) | Extract → new module | ~LOC out | Risk |
|---|---|---|---|---|
| **PR2 MAIN** | `pty.ts` · `mcpOrchestrator.ts` | `main/ptyShells.ts` (shell discovery + `safeCwd`/`resolveShell`) · `main/mcpRegistry.ts` (`BoardRegistry` iface + `deriveStatus` + `ConnectorMirrorEntry`) | ~160 + ~90 | very low |
| **PR3 Canvas** | `canvas/Canvas.tsx` | `lib/canvasDecisions.ts` (`applyPush`/`planFullViewAction`/`planNodeRemovalCleanup` + types) · `canvas/hooks/useGroupInteractions.ts` (6 group state vars + 5 callbacks + cleanup effect) | ~102 + ~135 | low |
| **PR4 Preview** | `boards/usePreviewManager.ts` | `lib/previewGeom.ts` (geometry callbacks → pure fns taking `viewport`/`paneOffset` args) · `boards/preview/usePreviewEvents.ts` (`onPreviewEvent` handler) | ~140 + ~57 | low |
| **PR5 Store** | `store/canvasStore.ts` | `store/slices/groupSlice.ts` (7 group actions) · `store/slices/connectorSlice.ts` (`addConnector`/`removeConnector`) — Zustand slice pattern; `trackedChange` stays shared | ~99 + ~40 | low |
| **PR6 Boards** | `boards/TerminalBoard.tsx` · `boards/PlanningBoard.tsx` | `boards/terminal/useTerminalWebgl.ts` (WebGL budget + attach/detach + LOD effect) · `boards/planning/usePlanningImageIO.ts` (image paste/drop) · `boards/planning/ExportPopover.tsx` (export popover) | ~80 + ~93 + ~75 | low / low-med |

**Security invariants (MAIN lanes):** PR2 extracts only the *non-security* shell-discovery and
type/status helpers from `pty.ts`/`mcpOrchestrator.ts`. The dispatch gate, nonce/confirm/audit chain,
`isForeignSender` perimeter, kill-tree, and identity-guarded cleanup **stay in their files** and are
**not** touched in Tier 1 (they belong to Tier 3 / out of scope). See research Appendix A.

**Constraints carried into every lane:**
- Camera sync stays one `useOnViewportChange({onStart,onChange,onEnd})` (no second slot);
  `usePreviewManager` reconcile stays boards-reference-gated; `demoting` Set drains in `finally`
  (PR4 — memories `preview-camera-sync-rootcause`, `preview-reconcile-only-boards-subscription`).
- Planning full-view stays a camera fit, no portal/CSS-transform (PR6 — `planning-fullview-camera-fit`).
- Store extraction must not alter undo/persistence invariants; `reflectPresent:false` semantics on
  group/connector actions are preserved verbatim (PR5 — `undo-lastrecorded-phantom`).

---

## 5. Test strategy

Verbatim moves + **test the real extracted symbol, not a replica** (Rule 3).

| Lane | Test obligation |
|---|---|
| PR2 | `ptyShells` already exported + unit-tested in `pty.test.ts` → repoint imports. `mcpRegistry` → add a small `deriveStatus` unit test. |
| PR3 | `canvasDecisions` already tested (`Canvas.fullview.test`/`Canvas.pushundo.test`) → repoint imports. `useGroupInteractions` → add a unit test for the `reflowAddToGroup` drag-onto-box path (not e2e-covered today); `groups.e2e` covers the rest. |
| PR4 | `previewGeom` → new unit tests for the lifted pure fns (no DOM). `usePreviewEvents` → **new unit test (closes a real gap — `onPreviewEvent` has none today).** |
| PR5 | group + connector slices → existing `canvasStore.test` + `persistence.integration` drive the combined store, pass unchanged. |
| PR6 | `useTerminalWebgl` runtime-only, e2e covers (pure move). `usePlanningImageIO` → `PlanningBoard.images.test` covers. `ExportPopover` → **new light test for `runExport`** (closes a gap). Fix the `pasteIntoTerminal` replica → import the real export while in this file. |

**Deferred (Tier-2 prereqs, NOT in this spec):** direct `trackedChange` test · `history.test.ts` ·
`lastRecorded`/`idleOnMountIds` `beforeEach` reset. Tier-1 slices ride existing coverage, so these
don't block.

---

## 6. Process & gating

- **Per-lane worktree** off `main` via `.claude/tools/new-worktree.ps1` (junctions node_modules). One
  `ACTIVE-WORK.md` row per lane declaring its host-file zone. ~4-worktree cap → run PR2–PR5 concurrent,
  PR6 after one frees.
- **Each lane lowers its own eslint pin** in the same PR.
- **Gate per lane before push:** `typecheck` · `lint` (the lowered pin must pass) · `format:check` ·
  `vitest` · **e2e matrix (Win-native + Linux-Docker)**. Verify `git config core.hooksPath` == `.githooks`
  first (`pre-push-gate-hookspath-bypass`).
- **Sequential merge:** rebase onto current `main` → full gate + e2e → merge → update the ACTIVE-WORK
  integration tip → next lane rebases. Subagent-driven + per-extraction holistic review (Wave-5 B5
  cadence). Reply inline per Claude-reviewer comment with its disposition.
- **No design artifact** — pure refactor, no UI (CLAUDE.md design-artifact rule N/A).
- `mcpSmoke.ts` is **pinned (frozen)** by the ratchet but **not split** in Tier 1 — Tier-2 triage
  (it's a dev/smoke harness; confirm role before touching).
- **Rebrand #17 (`chore/rebrand-expanse`) still merges LAST** — don't touch it.

---

## 7. Out of scope (future specs)

- **Tier 2 (medium):** `useOnNodesChange` · store `projectSlice` · `usePreviewMotion` · `mcpLifecycle`
  · `ptySession`/`ptyIpc` · `usePlanningContextMenu` · `TerminalPreviewPicker` — preceded by the
  deferred test-gap closures.
- **Tier 3 (high-risk):** `useTerminalSpawn` (adopt/idle state machine) · `mcpDispatchGate` (the 4×
  security gate dedup — extract last, with the existing test suite unchanged as proof).

---

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| A non-god file measures >700 and isn't pinned → red main on PR1 | Measure-then-pin **every** file the rule reports over 700, not just the assumed 8. |
| Strict pins friction other in-flight branches | Pin at current **rounded up to next 25** (headroom). |
| Extraction silently changes behavior on a hot sync path (preview/whiteboard/PTY) | Verbatim moves; e2e matrix after each lane; carry the named constraints in §4. |
| Replica-test false green | Import the real extracted symbol; fix `pasteIntoTerminal` replica in PR6. |
| Sequential-merge conflicts on `eslint.config.mjs` pins | Lanes touch distinct pin lines → line-level resolve; rebase before each merge. |
| Lane count > worktree cap | Run PR2–PR5 concurrent, PR6 in a second wave. |

---

## 9. Deliverables checklist

- [ ] PR1 — `max-lines` ratchet (global 700 + measured pins) + doctrine note. Merged to `main`, green.
- [ ] PR2 — `ptyShells.ts` + `mcpRegistry.ts`; pty.ts/mcpOrchestrator.ts pins lowered.
- [ ] PR3 — `lib/canvasDecisions.ts` + `useGroupInteractions.ts`; Canvas.tsx pin lowered.
- [ ] PR4 — `lib/previewGeom.ts` + `usePreviewEvents.ts`; usePreviewManager.ts pin lowered.
- [ ] PR5 — `groupSlice.ts` + `connectorSlice.ts`; canvasStore.ts pin lowered.
- [ ] PR6 — `useTerminalWebgl.ts` + `usePlanningImageIO.ts` + `ExportPopover.tsx`; pins lowered;
      `pasteIntoTerminal` replica fixed.

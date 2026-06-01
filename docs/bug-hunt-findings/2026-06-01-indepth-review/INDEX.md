# In-depth Review — 2026-06-01 — Consolidated INDEX

**Method:** hybrid workflow. 40 prior finding cards re-verified adversarially (refute-first) + a
7-dimension fresh gap sweep (49 agents) → then **cross-checked against current `main` `ed1d551`**
("Fix 13 verified bugs #12") after pulling origin (33 agents). Sonnet subagents, opus synthesis.
**Review ran against `abd7fa2`; #12 landed upstream after.**
**Baseline:** abd7fa2 = 356 tests green · **ed1d551 (current) = 412 tests green** · typecheck + lint clean.

## ⚠ Cross-check vs current main (`ed1d551` / PR #12)

`Canvas.tsx`, FullViewModal, BoardFrame, TerminalBoard(this-finding), PlanningBoard, ChecklistCard,
NoteCard, FreeText, alignmentGuides, BrowserBoard were **NOT** in the #12 diff → those findings are
untouched. #12 hit main-process + store + preview-layer + edge.

**Closed by #12 (6):** PREV-1 (demoting drain, "Bug H1") · NEW-CAM-4 (same) · NEW-CAM-3 (rAF
idle-stop, "L4") · STATE-3 (lastRecorded dedup, "M3") · PERS-1 (project:flush quit-handshake, "M2") ·
PERS-2 (atomic MRU, "L5"). **→ 3 of the original 10 Medium gone + the contested demoting-drift.**

**Partially closed — residual remains (6):** **MBC-1 → residual still HIGH** (see below) · FV-3
(Esc-close fixed; `menuOpen` stuck-true residual, Low) · PREV-3 (union fixed; stale cast/comment,
Info) · PERS-4 (`.bak` rotation now guarded; incoming-doc still unvalidated, Low) · TQ-1 (projectIpc
tests added; `isForeignSender` still copy-pasted ×3, Low) · TQ-2 (4/5 fns tested; `selectLiveCount`
still untested, Info).

**🔴 The High SURVIVED #12.** MBC-1: #12 added a *lagging* heal effect (`Canvas.tsx:430` clears
`fullViewId` one React commit later) but the **synchronous window is still open** — `removeBoard`
fires `BrowserPreviewLayer`'s Zustand subscriber → `applyLiveness()` reads the **stale**
`fullViewIdRef.current` (only synced via a `[fullViewId]` effect that hasn't run yet) → closes ALL
other live Browser renderers. The key-delete (`Canvas.tsx:282-290`) and undo/redo (`411-420`) paths
still call neither `hardCloseFullView()` nor a synchronous `fullViewIdRef.current = null`.

**Open backlog on current main:** **1 High · 7 Medium** (FV-1, NEW-ORCH-2, PPD-1, STATE-1, SEC-2,
NEW-BOARD-2, NEW-A11Y-1) **· ~28 Low · ~10 Info.** All "Medium/Low/Info" rows below are AS-REVIEWED
on `abd7fa2`; subtract the 6 closed + apply the 6 residuals above for current-main status. Full
per-finding current-main verdicts: `CROSSCHECK-ed1d551.json`.

---

### (below: original review verdicts as of `abd7fa2`)

## Verdict roll-up

| Outcome | Count | Keys |
|---|---|---|
| **Dropped — false-positive** | 3 | PREV-2, STATE-2, STATE-4 |
| **Dropped — already fixed** | 1 | TQ-3 (Phase 4 `abd7fa2` tokenised the welcome CSS) |
| **Confirmed / partial (existing)** | 36 | the other 36 prior cards |
| **New (gap sweep)** | 26 | NEW-CAM/ALIGN/LEAK/ORCH/BUILD/A11Y/BOARD-* |
| **Total actionable** | **62** | |

Severity (actionable only): **1 High · 10 Medium · ~40 Low · ~11 Info.**

## Dropped cards — DO NOT FIX

| Key | Why dropped |
|---|---|
| PREV-2 | Stale-owner path structurally unreachable: `disposeAll()` empties `owner` + `views` atomically; `preview:attach` guards on `views.get(id)`. |
| STATE-2 | Shared-ref aliasing is hypothetical; every caller passes the OLD `boards` ref before producing a new array. No live defect. |
| STATE-4 | "Two undo entries" is false — only `addBoard` calls `recordPast`; one Ctrl+Z removes the whole push. |
| TQ-3 | Hardcoded welcome hex already replaced with tokens in `abd7fa2`. |

## High

| Key | Title | Files | Lot |
|---|---|---|---|
| **MBC-1** | RF delete-key / undo board removal leaves `fullViewId` stale → `BrowserPreviewLayer` synchronous Zustand subscriber closes ALL other live Browser renderers | `Canvas.tsx`, `BrowserPreviewLayer.tsx` | **R1** |

## Medium

| Key | Title | Files | Lot |
|---|---|---|---|
| FV-1 | Terminal LOD card paints opaque over live xterm during full-view zoom-out (`fullView` prop never passed to TerminalBoard) | `BoardNode.tsx`, `TerminalBoard.tsx` | R4 |
| PREV-1 | `demoting` set not cleared on early gesture-abandon → stale ids suppress `flushBatch` forever (board stuck mid-pan) | `BrowserPreviewLayer.tsx` | R2 |
| NEW-CAM-4 | `demoting` not cleared when `endMotion` fires before `capturePreview` resolves → native views skip rAF position updates (same root as PREV-1) | `BrowserPreviewLayer.tsx` | R2 |
| NEW-ORCH-2 | Reopen full-view during exit animation → `fullViewEntering` never re-cleared (settle timer fires once on mount) → Browser native view stays detached forever, shows stale snapshot | `Canvas.tsx`, `FullViewModal.tsx`, `BrowserPreviewLayer.tsx` | R1 |
| PPD-1 | Push-to-existing-browser calls `updateBoard` with no `beginChange` → silently destroys redo branch, push non-undoable | `Canvas.tsx`, `canvasStore.ts` | R3 |
| STATE-1 | PlanningBoard element-edit callbacks close over stale `elements` snapshot → concurrent edits clobber, loss persisted by autosave | `PlanningBoard.tsx`, `canvasStore.ts` | R4 |
| SEC-2 | `project:save` overwrites `canvas.json` + `.bak` with any payload — `isEnvelope` never run on the incoming doc (only on read) | `projectStore.ts`, `projectIpc.ts` | M1 |
| PERS-1 | `beforeunload`/quit save is fire-and-forget; `shutdown()` never awaits pending `project:save` → last ~1 s of edits can be lost on quit | `useAutosave.ts`, `main/index.ts`, `projectIpc.ts`, `preload/index.ts` | M1 |
| NEW-A11Y-1 | FullViewModal has no focus trap — Tab escapes into hidden background canvas | `FullViewModal.tsx` | R5 |
| NEW-BOARD-2 | URL bar stores bare `localhost:5173` verbatim → WHATWG parses `localhost:` as protocol → main rejects, shows "Couldn't load" with no guidance | `BrowserBoard.tsx`, `preview.ts` | M2 |

## Low (grouped by lot)

**R1 — full-view lifecycle (Canvas.tsx ∪ BrowserPreviewLayer ∪ FullViewModal ∪ BoardFrame):**
FV-2 (sync clear `fullViewId` on key-delete + undo/redo), FV-3 (Esc strands menu `menuOpen=true`),
FV-4 (redundant `setMenuOpen`), MBC-2 (e2e hook bypasses motion SM), MBC-3 (phantom `previewStore`
entry on reload-of-deleted), NEW-ORCH-1 (key-delete leaves `fullViewEntering/Closing` stale),
NEW-ORCH-3 (`duplicate` unconditionally exits full-view of a *different* board), NEW-ORCH-4 (rapid
sequential `openFullView` share stale settle timer), NEW-CAM-1 (post-`openPreview` guard misses
`r.exists`).

**R2 — preview rAF / native-view (BrowserPreviewLayer.tsx):** PREV-3 (stale `as string` cast +
wrong comment), PREV-4 (`closeBoard` doesn't reset `lastZoom`), NEW-CAM-2 (`boundsFor` computed
twice/board/frame), NEW-CAM-3 (full-view rAF never idle-stops).

**R3 — canvas store / undo (canvasStore.ts, history.ts):** STATE-3 (redo-then-drag needs two undos),
STATE-5 (every checklist tick is an undo step — confirm intended vs batch).

**R4 — board content (TerminalBoard, PlanningBoard, ChecklistCard):** MBC-4 (dual picker render),
PTY-2 (`launch()` missing disposed guard), PTY-3 (restored terminals auto-spawn — violates idle
contract), NEW-BOARD-1 (checklist drag over-grows board permanently), NEW-BOARD-3 (checklist
`onKeyDown` mutates list when non-select tool active).

**R5 — a11y chrome (BoardFrame, AppChrome, FullViewModal, TerminalConfig, ChecklistCard):**
NEW-A11Y-2 (no focus restore on close), NEW-A11Y-3 (`role=menu` w/o `menuitem`), NEW-A11Y-4 (missing
`aria-expanded`/`aria-haspopup`), NEW-A11Y-5 (TerminalConfig popover no focus-in), NEW-A11Y-6
(checklist toggle no `aria-checked`), NEW-A11Y-7 (progress-bar transition not reduced-motion gated),
NEW-A11Y-8 (FullViewModal no `role=dialog`/`aria-modal`).

**M1 — persistence/security/main (parallel to R):** PERS-2 (non-atomic `recentProjects.json`),
PERS-3 (`assertBoard` before `migrate` — latent), PERS-4 (`.bak` rotated before validate), SEC-1
(wildcard `targetOrigin` on PTY port + no `e.origin` guard), SEC-3 (dev-only bare `ws:` CSP —
prod already `'self'`), SEC-4 (preload contextIsolation fallback silently exposes API), PTY-4
(parked PTY sessions not reaped on project switch), PTY-5 (Unix kill doesn't await tree death),
PTY-6 (port handoff no `e.origin` — defense-in-depth).

**M2 — port-detect / browser-board (parallel):** PPD-2 (`borderPoint` NaN before nodes measured),
PPD-3 (implicit 80/443 serialised explicit), PPD-4 (ANSI regex misses OSC).

**W — isolated whiteboard / lib (parallel):** NEW-LEAK-1 (NoteCard document listeners no unmount
cleanup), NEW-LEAK-2 (FreeText same), NEW-ALIGN-1 (stale overlap tints when board removed mid-drag),
NEW-ALIGN-2 (resize-end never clears overlaps), NEW-ALIGN-3 (zero-gap distribution renders "0" pill),
NEW-ALIGN-4 (Case-B end-of-row fires while still overlapping).

**T — tests only (parallel):** TQ-1 (projectIpc frame-guard untested + dedupe `isForeignSender`),
TQ-2 (previewStore 5 fns untested), TQ-4 (terminalRuntimeStore untested), TQ-5 (`enumerateShells`
untested), TQ-6 (localServer + selfTest untested), TQ-7 (ChecklistCard 1 test only).

## Info (low-effort polish)

PPD-3, PPD-4, PREV-4, PTY-5, PTY-6, MBC-4, STATE-5, TQ-7, TQ-8 (DiagOverlay under `spike/` but
load-bearing — rename/move), NEW-BUILD-1 (`electron-updater` packed but never initialised — fold
into Phase 5), NEW-CAM-3.

## Parallel-fix plan

The renderer canvas is tightly coupled — `Canvas.tsx`, `BrowserPreviewLayer.tsx`,
`FullViewModal.tsx`, `canvasStore.ts` are touched by many cards, so the renderer work is **one serial
track (R)** subdivided R1→R5. Three other tracks are file-disjoint from R and from each other →
**run in parallel**:

| Track | Files (collision domain) | Order | Parallel? |
|---|---|---|---|
| **R** renderer canvas core | Canvas.tsx, BrowserPreviewLayer.tsx, FullViewModal.tsx, BoardFrame.tsx, canvasStore.ts, TerminalBoard.tsx, PlanningBoard.tsx, ChecklistCard.tsx, AppChrome.tsx, TerminalConfig.tsx, BoardNode.tsx | R1→R2→R3→R4→R5 | serial within; the High (MBC-1) + root-cause (NEW-ORCH-2) lead R1 |
| **M** main/persistence/security | projectStore.ts, projectIpc.ts, recentProjects.ts, boardSchema.ts, pty.ts, preload/index.ts, main/index.ts, preview.ts, BrowserBoard.tsx, portDetect.ts | M1, M2 | parallel to R/W/T |
| **W** whiteboard + align lib | NoteCard.tsx, FreeText.tsx, alignmentGuides.ts, AlignmentGuides.tsx, PreviewEdge.tsx | any | parallel |
| **T** test-only additions | *.test.ts(x) new files | any | parallel |

**Collision caveats inside R:** R1 and R2 both touch `BrowserPreviewLayer.tsx`; R1/R3 both touch
`Canvas.tsx`+`canvasStore.ts`; R4/R5 both touch `ChecklistCard.tsx`. Keep R strictly sequential.
M1 internal: PERS-1/PERS-4/SEC-2/TQ-1 all touch `projectIpc.ts` — sequence them.

**Recommended first PR:** R1 root-cause fix — make `fullViewId` clear *synchronously* on every
board-removal vector (key-delete, undo/redo) + update `fullViewIdRef` before the Zustand subscriber
fires + re-arm the FullViewModal settle timer on `fullViewId` change. That single change resolves
MBC-1 (High), FV-2, NEW-ORCH-1, NEW-ORCH-2, NEW-ORCH-4, and de-risks NEW-CAM-4/PREV-1.

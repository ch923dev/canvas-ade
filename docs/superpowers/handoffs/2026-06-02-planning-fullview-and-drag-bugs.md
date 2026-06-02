# Handoff — Planning board: full-view add-note + drag bugs (UNRESOLVED)

**Date:** 2026-06-02
**Branch / worktree:** `feat/whiteboard-w3` @ `Z:\canvas-ade-whiteboard-w3` (HEAD `65de803`). PR #23 → `feat/whiteboard`.
**Status:** Bug 1 (full-view add) has a **confirmed root cause + an attempted fix that is WRONG for large boards** — needs redo. Bug 2 (drag) **not reproduced in-harness yet** — needs in-app evidence. Do NOT mark these fixed.

---

## The two user-reported bugs (real mouse, on the FIXED build — verified by the user)

1. **Can't add a note in full view** — "nothing appears at all" when picking the note tool and clicking the well in full view. User confirmed full view IS scaled-to-fit (so the `65de803` scale fix loaded), yet adding still fails.
2. **Single-select drag moves other elements** — dragging one note (only that one had the blue selection ring, per the user) also moves the other notes + the checklist.
   - Plus an aside seen in the user's video (frame t14): both notes showed **selected text inside their textareas** — a `Ctrl+A` likely landed inside a note `<textarea>` instead of selecting elements. Possibly related to focus/selection, possibly a red herring.

User's repro context: project "bulkops", a Planning board whose content is a couple notes + a checklist; the board is **large (~2000px wide)** — content clustered top-left in full view with lots of empty space. **Board size matters** (see root cause).

---

## What was already done on `65de803` (the attempted fix — KEEP the checklist part, REDO the full-view part)

`65de803` "fix(whiteboard): full-view add-note coord space + draggable checklist body":
- **Checklist drag (GOOD, keep):** `ChecklistCard.tsx` — the whole card body is now a drag surface (press anywhere that isn't `input/button/textarea` → `onSelect`+`onDragStart`). This is correct and low-risk.
- **Full-view scale-to-fit (BROKEN for big boards, REDO):** `PlanningBoard.tsx` — added `useContext(BoardFullViewContext)`; in full view the well is wrapped in a `stage` (`position:absolute; inset:0; display:grid; placeItems:center`) and the well renders at intrinsic `board.w × (board.h-34)` with `transform: scale(fvFit); transform-origin: center`, where `fvFit` is measured from the stage via a `ResizeObserver`. On canvas the stage is a transparent `inset:0` passthrough (canvas behavior unchanged). Intent: keep board-local coords consistent so `lib/pen.screenScale` (rendered÷layout) reports the fit and `toBoard` stays correct.

There are also 3 e2e regression probes on `65de803` in `src/main/e2eSmoke.ts` (`fullview-add-note`, `fullview-delete`, `checklist-drag`). **WARNING: these pass but are FALSE GREEN** — they drive synthetic `dispatchEvent` pointer events, which bypass the CSS-transform hit-testing where the real bug lives. They must be converted to real input (see below) or they keep masking the bug.

---

## ROOT CAUSE of Bug 1 (confirmed via real-input diagnostic)

The `65de803` scale-to-fit works for a **small** board (786px) but is **wrong for a large board** (the user's case).

Evidence — real OS input (`win.webContents.sendInputEvent`) on a **2000×1300** board in full view, clicking the note tool then the well centre:
```
REALADD notesAfter=1 newNote=922,1119  well={x:537, y:373, w:1053, h:667}
```
- `fvFit` = 1053/2000 = **0.527** (well scaled down to fit).
- Click at well-centre (~1064, 673) → `toBoard` should give board-local ≈ **(999, 569)** → note top-left ≈ **(922, 549)**.
- The note's **x landed at 922 (correct)** but **y landed at 1119 (~570px too low / wrong).**

So `toBoard`'s **Y mapping is broken** when the well is scaled by `transform: scale()` with `transform-origin: center` AND the *unscaled* well (board.h−34 = 1266px tall) is LARGER than its stage container. The grid centres the **oversized unscaled** box, then scales from its centre; the resulting `getBoundingClientRect().top` no longer satisfies `screen = rect.top + local·fvFit` the way `toBoard` assumes. Net effect: a clicked note is created but lands far below the cursor → **off the visible (overflow:hidden) well area → "nothing appears."** (For small boards the unscaled well fits the stage, no overflow, mapping happens to stay correct — which is why the harness "passed".)

**Why the existing probes missed it:** synthetic `dispatchEvent` doesn't go through real hit-testing/transform mapping; only real input (`sendInputEvent`) or a real mouse exposes it.

### Fix direction for Bug 1 (for the next session)
The `transform-origin: center` + grid-centring of an oversized element is the problem. Options, simplest first:
1. **`transform-origin: top left` + manual centring.** Scale from the top-left so `screen = rect.left + local·s` and `screen = rect.top + local·s` hold exactly (then `toBoard` is correct by construction). Centre the scaled board by translating the well by the computed margins (`(stageW − board.w·s)/2`, `(stageH − contentH·s)/2`) instead of relying on grid-centring an oversized box. Verify with the real-input probe at multiple click points (corners, not just centre).
2. **Reconsider the model.** Scale-to-fit a *large mostly-empty* board shows a tiny content cluster in a big empty modal (bad UX — see the user's video). Consider **fit-to-content** (scale/centre the bounding box of the elements, not the whole board) so full view shows the content filling the modal and new notes land near it. Bigger change; needs a brainstorm.
3. **Abandon scaling; revert to the original stretched well** (well = modal size) and instead fix the *original* clip-on-exit by clamping/placing new full-view elements within `board.w×board.h`, or growing the board to encompass them on exit. Loses the "see it bigger" benefit but is simpler.

Recommend (1) first (smallest change to the existing approach), with the real-input probe asserting the note lands under the cursor (±a few px) for clicks at center AND off-center AND near edges, on BOTH a small and a large board.

---

## Bug 2 (drag moves others) — NOT yet reproduced; needs in-app evidence

- Synthetic-event harness DIAG: single-select drag moved only the grabbed note (`aMoved=60, bMoved=0`). Real-input (`sendInputEvent`) drag moved **nothing** (`aMoved=0, bMoved=0`) — a sendInputEvent **pointer-capture fidelity gap** (the synthetic move stream didn't drive the captured `onWellPointerMove`), so the harness can't yet reproduce the real drag at all. Neither method reproduced "moves others."
- User is certain: only one element had the selection ring, yet dragging it moved the others + checklist.
- Code paths to scrutinise (`PlanningBoard.tsx`):
  - `startElementDrag`: `movingIds = selectedIds.has(id) ? expandGroups(elements, selectedIds) : new Set([id])`, then locked-filter. With a single selection and no `groupId`, this should be `[id]` only.
  - **Candidate causes to check:** (a) the elements share a `groupId` unintentionally (then `expandGroups` pulls them — but then selecting one would ring ALL of them, which the user said didn't happen); (b) `selectedIds` actually holds multiple while only one ring is visible (selection/ring desync); (c) **snapping** (W2 magnet, ON by default) — dragging A near B/checklist draws guide lines + snaps A's edges to them; the user may perceive the guides/snap as "going to the other notes" (but snapping moves only A, not the others, so this does NOT explain *others moving*).
- **Next step:** add temporary `console.log` (or a main-process IPC log to a file the agent can Read) inside `startElementDrag` (log `id`, `selectedIds`, computed `movingIds`) and `onWellPointerUp` move branch (log `dragPos.ids`), have the user reproduce in the dev app, and capture which ids actually move. Renderer console isn't on the dev stdout, so log via a file or an existing main-side channel.

---

## How to verify (CRITICAL — synthetic events lie here)

- **Use real OS input**, not `dispatchEvent`. In `e2eSmoke.ts` (main side) you have `win: BrowserWindow` → `win.webContents.sendInputEvent({type:'mouseDown'|'mouseMove'|'mouseUp', x, y, button:'left', clickCount:1})`. Coordinates are page CSS px (same space as `getBoundingClientRect`). This goes through the real hit-test pipeline and exposed Bug 1.
- The real-input DIAG block used (now reverted) lived right after `const planId = seedBoard('planning')` in `e2eSmoke.ts`. Re-create it: it (a) sets a BIG board `patchBoard(planId,{w:2000,h:1300,elements:[]})`, full-views, real-clicks the `.fullview-host [title="note"]` button then the well, and asserts the new note's coords are **near the click's board-local mapping** (not just "a note exists"); (b) drags a `.pl-note-grip` and asserts only the grabbed note moved.
- `sendInputEvent` drag didn't drive pointer-capture reliably — may need to send `mouseMove` with the correct modifiers or investigate; OR drive Bug 2 via in-app logging instead.
- Run: `pnpm build` then `powershell -File C:\Users\De Asis PC\AppData\Local\Temp\run-e2e-w3.ps1` (sets `CANVAS_SMOKE=e2e; pnpm start`). **Kill stray electron first** (`Get-Process electron | Stop-Process -Force`) — concurrent instances cause the browser-trio + `seed` probes to flake (port 3000 contention), unrelated to these bugs.

## Environment / gotchas
- HMR caveat: the full-view fix adds React hooks to `PlanningBoard`; HMR may not hot-apply hook-count changes → a running `pnpm dev` can show stale behavior. **Hard-restart dev** (kill electron, fresh `pnpm dev`) after editing.
- Bash tool runs POSIX sh — PowerShell `$env:`/backticks get mangled. Use `powershell -File <script.ps1>` for `CANVAS_SMOKE=e2e; pnpm start`. ffmpeg is installed (Gyan.FFmpeg) at `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_...\bin\ffmpeg.exe` for extracting video frames (`fps=1,scale=960`).
- Repo-wide `format:check` red is a known pre-existing thing on this branch's base; not these bugs.

## Files in play
- `src/renderer/src/canvas/boards/PlanningBoard.tsx` — full-view well wrapper + `toBoard` + drag (`startElementDrag`/`onWellPointerMove`/`onWellPointerUp`).
- `src/renderer/src/lib/pen.ts` — `screenToBoard` / `screenScale` (the coordinate mapping; `screenScale` = rendered÷layout).
- `src/renderer/src/canvas/boards/planning/ChecklistCard.tsx` — checklist whole-body drag (keep).
- `src/renderer/src/canvas/FullViewModal.tsx` + `BoardNode.tsx` (`contentHost` portal into `.fullview-host`) + `fullViewContext.ts` (`BoardFullViewContext`).
- `src/main/e2eSmoke.ts` — probes (convert the 3 planning probes to real input).

## Suggested first move next session
1. Re-create the real-input DIAG (small + large board) and confirm Bug 1 (note lands off-cursor on big board).
2. Apply fix direction (1) (`transform-origin: top left` + manual centring); re-run the DIAG asserting the note lands under the cursor for center/off-center/edge clicks on both board sizes.
3. For Bug 2, add in-app logging of `movingIds`, have the user repro, capture which ids move.

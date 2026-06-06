# KICKOFF — Browser preview camera-sync fix

**Branch / worktree:** `fix/preview-camera-sync` @ `Z:\canvas-ade-preview-camera-sync` (off `main`).
**Created:** 2026-06-06. **Prereq read:** `docs/research/2026-06-06-browser-preview-camera-sync-rootcause.md`
(authoritative) → then skim `2026-06-06-browser-preview-layer-alignment.md` (earlier, superseded workflow research).

## The bug (one line)

A Browser board's native `WebContentsView` does not follow the camera on pan/zoom — it freezes while
the HTML frame moves, so the live white page floats out of bounds. Reproduced in the built app.

## Suspected root cause (PROVEN last session — your job is to independently RE-VERIFY, then plan)

`useOnViewportChange` is a **single-slot** React Flow store field, not additive. The app calls it twice
— `Canvas.tsx:674` (autosave) and `usePreviewManager.ts:671` (camera→native sync). The parent (Canvas)
registers last and **clobbers** the preview manager's `onStart`/`onChange`/`onEnd` (the autosave provides
only `onChange`, so `onStart`/`onEnd` are overwritten with `undefined`). Result: on a camera move the
preview manager's detach + reposition pump never fire. Measured: `pumps:0, beginMotions:0` on every pan
while the frame travels. Full evidence + the RF source quote are in the root-cause doc.

## Your mission (this session)

> The user's explicit ask: **deep-dive to MAKE SURE the root cause is correct, and deliver documented
> findings + an implementation PLAN.** Implementation may follow, but findings + plan are the deliverable.

1. **Re-verify the reproduction.** `pnpm build` then
   `pnpm exec playwright test e2e/preview-align.e2e.ts -g "CLEAN"`. Confirm `pumps:0` + native frozen
   while the frame moves.
2. **Prove the mechanism with a minimal change (decisive test).** Temporarily relocate/remove the
   autosave `useOnViewportChange` at `Canvas.tsx:674` (or merge both into one owner). Re-run the CLEAN
   diagnostic. **Expect `pumps>0`, `beginMotions>0`, and the native rect tracking `.bb-frame` (≤2px).**
   If that flips it green, the collision is confirmed as THE cause. If it does NOT fully fix it, dig
   further (there may be a second factor — see open questions in the root-cause doc) before planning.
3. **Rule out confounders** (root-cause doc §"Open questions"): other `useOnViewportChange` callers;
   effect-order determinism; whether `rf.fitView`/focus/tidy also leave the native un-pumped in real use.
4. **Write the verified findings** — update the root-cause doc with your confirmation (or correction) and
   the decisive-test result.
5. **Write the implementation plan** — pick the fix option (root-cause doc §"Proposed fix"; option 1 =
   move autosave off `useOnViewportChange`, recommended), list exact files + edits + risks, and the
   **test plan** (convert `e2e/preview-align.e2e.ts` into a hard-asserting regression test: native vs
   `.bb-frame` ≤2px after a REAL `sendInput` panOnScroll; keep it deterministic via `viewBounds`, not
   `capturePage` — mind `e2e-browser-trio-flake`). Use `superpowers:writing-plans` if helpful.

Then STOP for review before implementing the fix (unless the user says to proceed straight through).

## Scaffolding already on this branch (use it; don't rebuild)

- `e2e/preview-align.e2e.ts` — the diagnostic (2 tests; `-g "CLEAN"` is the clean panOnScroll proof).
- `src/main/preview.ts` `debugViewBounds` + `src/main/e2eMain.ts` `viewBounds` — read native bounds from main. **Keep.**
- `src/renderer/src/canvas/boards/usePreviewManager.ts` `previewDebug` counters (`window.__previewDebug`).
  **TEMPORARY — remove before the fix PR.**

## Constraints / repo rules

- **Stay on this worktree.** Zone: `usePreviewManager.ts` + `Canvas.tsx` (the `useOnViewportChange`
  collision). `Canvas.tsx` is shared/high-traffic — note the one-line autosave change on the coordination
  board before editing, and keep it surgical.
- **Remove the `previewDebug` instrumentation** before any fix lands. Keep the `viewBounds` getter + the
  spec (the spec becomes the regression guard).
- **Gate before handoff:** `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` (unit+integration)
  AND the e2e (`pnpm exec playwright test e2e/preview-align.e2e.ts` + the existing `e2e/browser.e2e.ts`).
  Memory: `gate-must-run-format-check`, `e2e-before-handoff`.
- `node_modules` is junctioned from main — no native rebuild needed. If `pnpm install` ran, `pnpm rebuild`
  (memory `node-pty-rebuild-after-install`).
- This is feature/fix work: it lives on THIS branch, never `main` (CLAUDE.md). Promote via the sequential
  merge once green.

## Commands

```
cd "Z:\canvas-ade-preview-camera-sync"
pnpm build
pnpm exec playwright test e2e/preview-align.e2e.ts -g "CLEAN"   # the proof
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test   # gate
```

## Deliverables checklist

- [ ] Reproduction re-confirmed (CLEAN diagnostic: `pumps:0`, native frozen).
- [ ] Decisive test run (relocate autosave `useOnViewportChange` → `pumps>0` + native tracks ≤2px).
- [ ] Confounders ruled out (open questions answered).
- [ ] Findings doc updated with the confirmation/correction.
- [ ] Implementation plan written (fix option, files, risks, regression-test design).
- [ ] (If greenlit) fix implemented, instrumentation removed, gate + e2e green, PR opened.

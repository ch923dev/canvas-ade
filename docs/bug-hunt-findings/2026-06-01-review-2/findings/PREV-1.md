# PREV-1: Full-view title-bar toggle closes live boards without snapshot → blank frame

- **Severity:** Low
- **Category:** preview / full-view LOD
- **Status:** CONFIRMED (high confidence)
- **Files touched:** `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`
- **Assigned:** _(blank)_

## Summary
Entering full view via the **title-bar maximize button** closes every other live Browser board's native
renderer **without first capturing a snapshot**. A second Browser board that was live but never demoted to a
snapshot (freshly attached, or `capturePreview` returned null on a GPU-contended host) renders a blank device
frame behind the scrim until full-view exit.

## Where
`BrowserPreviewLayer.tsx:569-573` — `applyLiveness` full-view branch:
```ts
else if (rec(g.id).exists) closeBoard(g.id)   // line 573: no snapshot guard
```
`closeBoard` (`437-448`) sets `exists=false` and calls `window.api.closePreview(id)` →
`preview.ts:505-508 disposeOne → webContents.close()` — tears down the renderer immediately, **no snapshot**.

The **over-cap** path (`line 604`) has the guard the full-view path lacks:
```ts
if (r.exists || rt?.snapshot) ...   // comment cites Bug #24: "never-captured board → blank device frame"
```

## Why the title-bar path specifically
`BoardFrame.tsx:523-528` maximize button → `onFull → requestFullView → openFullView(id)` **directly**, so
`previewStore.menuOpen` never becomes true and `beginMotion()` (`BrowserPreviewLayer.tsx:648`, which snapshots
all live boards via `capturePreview` before detaching) never fires. Entering full view via the **⋯ menu item**
(`line 258`) does set `menuOpen → beginMotion`, snapshotting first — so the bug only manifests on the direct
title-bar toggle.

## How it triggers
1. Have ≥2 live Browser boards; one freshly attached (not yet snapshotted).
2. Click the title-bar maximize on board A.
3. Board B's renderer is closed with no snapshot → blank frame, dimmed behind the 66% scrim.
4. Exits cleanly on full-view exit (reconcile reattaches).

## Verification evidence
Adversarially confirmed; severity corrected **down** to Low — transient, self-healing, only visible dimmed
behind the scrim, no crash/data-loss/security impact.

## Suggested fix direction
Mirror the over-cap guard on the full-view close path: capture a snapshot before `closeBoard` when the board
has no current snapshot, **or** route the title-bar toggle through `beginMotion()` like the ⋯-menu path so all
live boards are snapshotted before detach.

## Collision notes
Lane B (same file as ATTACH-1). Sequence the two edits in one branch.

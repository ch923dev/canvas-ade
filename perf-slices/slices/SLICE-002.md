# SLICE-002 — OSR: transferable ArrayBuffer for frame IPC

- **Dimension:** I/O & IPC payload / memory churn · **Severity:** high · **Effort:** M
- **Finding:** `osr-ipc-frame-payload` (high) + the IPC half of `mip-osr-tobitmap-per-frame-main`
- **Where:** `src/main/previewOsr.ts:346-352` (`emitFrame` → `owner.webContents.send`) + `:531`
  (`buffer: patch.toBitmap()`); renderer receive at `useOffscreenPreview.ts:75-104` (`applyFrame`).

## Baseline (measured, reproduced)

- `emitFrame` does an **unconditional** `webContents.send('preview:osrFrame', {buffer:
  patch.toBitmap()})` per paint. `webContents.send` uses structured-clone with **no transferables**,
  so the whole BGRA Buffer is **copied** main→renderer every paint.
- Frame size at S=2: desktop 1280×800 → 2560×1600×4 = **16,384,000 B (16.4 MB)**; mobile = 5.27 MB;
  tablet ≈ 11–15 MB. At `OSR_FRAME_RATE=30`: **~492 MB/s per desktop board**; at `MAX_LIVE=4` ≈
  **1.97 GB/s** crossing the boundary.
- Micro-bench (node, 16.384 MB buffer): structured-clone/serialize copy = **~3.92–4.65 ms/frame** →
  ~140 ms/s per board, **~560 ms/s (>0.5 core) at 4 boards**, before any paint/swizzle work.

## Target

Transfer the frame's `ArrayBuffer` as a **transferable** (zero-copy) instead of structured-cloning
it. Either move off `webContents.send` to a `MessageChannelMain` port for the frame plane (mirrors
the PTY data-plane pattern in CLAUDE.md), or otherwise neuter the renderer-side copy. **Target:
eliminate the ~3.9–4.65 ms/frame copy and the ~492 MB/s–1.97 GB/s of copied payload** (the alloc of
the source Buffer remains until SLICE-005 crops it).

## Validation

1. Instrument bytes/s and per-frame copy time over a continuously-painting preview (e.g. a CSS
   animation page) before/after; copy time → ~0, payload no longer duplicated in the renderer.
2. Confirm the buffer arrives **detached** on the main side / transferred (no second 16 MB resident
   copy) via `process.memoryUsage().arrayBuffers` sampling.
3. e2e `@preview` leg green (frame still blits, pixels correct).

## Invariant (must stay identical)

Rendered preview is pixel-identical; supersample crispness unchanged; frame cadence unchanged; no
use-after-transfer of the source buffer in MAIN.

## Files touched

- `src/main/previewOsr.ts` (`emitFrame` / send path).
- `src/renderer/src/canvas/boards/useOffscreenPreview.ts` (receive + blit; adopt the transferred
  buffer).
- Possibly `src/preload/index.ts` if the frame plane moves to a MessagePort.

## Collisions

- **`previewOsr.ts` shared with SLICE-005**, **`useOffscreenPreview.ts` shared with SLICE-006** →
  land 002 first (lower risk), 005/006 rebase.

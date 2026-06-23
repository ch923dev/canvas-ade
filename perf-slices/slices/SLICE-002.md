# SLICE-002 — OSR: transferable ArrayBuffer for frame IPC

> ## ⛔ VERDICT (2026-06-23): NOT ACHIEVABLE as specified — re-scoped, no code shipped.
>
> The slice's premise — "transfer the frame's ArrayBuffer as a **transferable** (zero-copy)" — is
> **false across the main→renderer boundary**. Transferables avoid a copy only **within one process**
> (renderer↔worker — which SLICE-006 already does for the swizzle). MAIN and the renderer are
> **separate OS processes**; every Electron channel between them structured-clones (copies) the
> payload. Verified against the installed **Electron 42** typings (`node_modules/electron/electron.d.ts`):
> *every* `postMessage`/`send` transfer list is `MessagePort[]` / `MessagePortMain[]` —
> **none accepts an `ArrayBuffer`**:
> - `WebContents.postMessage(channel, message, transfer?: MessagePortMain[])`
> - `MessagePortMain.postMessage(message, transfer?: MessagePortMain[])`
> - `ipcRenderer.postMessage(channel, message, transfer?: MessagePort[])`
>
> So moving the frame plane to `MessageChannelMain` (the PTY pattern) would **still copy** the BGRA
> buffer at the v8 serialization boundary — it would add a security-sensitive preload port-forwarding
> surface for **zero** byte-savings. The cross-process copy of a CPU bitmap is **irreducible** here.
>
> **What already shrank this (so the residual is small for the common case):**
> - **SLICE-005** crops partial paints to the damage rect → caret/scroll/typing frames now cross as
>   **KB**, not 16.4 MB. The full-frame copy only remains for **full-repaint** previews (video, full-page
>   animation, initial load / resize).
> - **SLICE-006** moved the BGRA→RGBA swizzle into a worker and the renderer already **transfers** the
>   IPC-delivered buffer to that worker (zero-copy, in-process) — there is **no second renderer-side
>   copy left to neuter**.
>
> **The only real zero-copy frame path** is **shared-texture OSR** (`webPreferences.offscreen.useSharedTexture:
> true` → the `paint` event delivers an `OffscreenSharedTexture` **GPU handle** instead of a CPU
> bitmap). Consuming it means importing a GPU texture into a **WebGL/WebGPU** canvas and rewriting the
> entire blit / dirty-rect / clear / evict / `osrCanvasNonBlank` pipeline (all built on a 2D canvas +
> `putImageData`) — a large, platform-specific, occlusion-invariant-touching initiative (OSR "OS-4"
> tier), **not a perf slice**. Filed as a future option; **out of scope for this wave.**
>
> Net: the wave's other 12 slices stand; 002 is **closed as not-achievable** (its measured win was
> already captured by 005+006 for everything but full-repaint video, where the copy is fundamental).

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

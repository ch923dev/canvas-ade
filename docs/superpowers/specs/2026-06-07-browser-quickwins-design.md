# Browser board quick-wins — design

**Date:** 2026-06-07
**Branch:** `feat/browser-quickwins`
**Status:** Design (approved verbally; pending written-spec review)

## Goal

Four small, high-value improvements to the Browser board (native `WebContentsView`
preview). All reuse existing durable props and IPC patterns — **no schema bump**, no
new board/element types, no security-invariant changes.

1. **Auto-reconnect on refused** — a Browser board pointed at a dev server that isn't
   running yet stops dead on "Couldn't load". Keep retrying until it connects.
2. **Auto-push detected port → linked board** — a dev server that prints its URL into a
   terminal should populate a wired Browser board automatically (today it is a manual
   globe-button tap).
3. **Open-in-OS-browser** — one click to open the current preview URL in the real
   system browser (for real DevTools, extensions, etc.).
4. **Screenshot-to-canvas** — capture the live preview to the clipboard **and** the
   project `assets/` folder.

## Non-goals (explicitly deferred)

- **Image element on Planning board** — screenshot drop-onto-canvas needs a new schema
  element type (render/resize/persist/export). Deferred to a separate feature. This
  bundle does clipboard + file only.
- **Console / network capture panel** — separate medium-tier feature.
- **CDP / element-pick → agent context** — separate AI-native feature.
- **Custom viewport width / rotate** — separate feature.

## Current behaviour (baseline)

- `preview.ts` (main): owns N native `WebContentsView`s keyed by board id. A dead/refused
  main-frame load latches `failed` (`preview.ts:198`) and emits `did-fail-load`; the
  renderer sets `status: 'load-failed'` (`usePreviewManager.ts:1020`). **Nothing retries.**
- `previewStore.ts`: `requestReload(id)` bumps a monotonic `reloadNonce` — the
  push-to-preview signal. `usePreviewManager.reconcile` re-navigates when `url` OR the
  nonce changed (`usePreviewManager.ts:848`), so a same-URL push reloads and **can
  recover a load-failed view**. The nonce path was built for exactly this (`previewStore.ts:32`).
- Port detection: `parsePortsFromOutput` (`portDetect.ts`) parses buffered raw PTY output;
  exposed via `terminal:detectPorts` IPC (`pty.ts:433`), invoked **only** by the manual
  globe button (`terminalPreview.ts`). No automatic push.
- `previewSourceId` on a Browser board (canvasStore) links it to a source terminal and is
  the source of truth for the on-canvas preview edge.
- `updateBoard(id, patch)` (`canvasStore.ts:456`) is a plain setter; undo is recorded only
  via the separate `beginChange`. So a programmatic `updateBoard` adds **no** undo step.
- `openExternalSafe(url)` (`preview.ts:108`) opens an allowlisted (http/https/mailto) URL in
  the OS browser; today used only by the `setWindowOpenHandler` (`window.open`) path.
- `capturePage()` is used for the LOD/motion snapshot (`preview.ts:468`, returns a data URL)
  and for e2e PNG capture (`debugCaptureViewPng`, e2e-only). `capturePage` is **blank for a
  detached / off-screen view** — a real screenshot needs the view attached + on-screen.
- `clipboard.writeText/readText` are wired (`clipboardIpc.ts`); **no `writeImage`** yet.
- `getCurrentDir()` (`projectStore`) gives the open project directory; `assets/` lives at
  the project root (CLAUDE.md: heavy blobs in `assets/` by path).

## Architecture

### Sub-feature 1 + 2: the auto-connect engine

Reconnect and auto-push are the same loop — *"board not connected → keep trying until it
is"* — so they share one engine.

**Chosen approach: renderer timer + pure policy function (Approach A).**

Rejected alternatives:
- **B — main-side retry/streaming:** more main complexity + security surface, duplicates the
  nonce logic, harder to unit-test. Works when a view is detached, but reconnect via the
  nonce already re-navigates on the next reconcile/attach, so that edge is covered.
- **C — hybrid (reconnect in main, push in renderer):** split brain across processes.

**New files (renderer):**
- `src/renderer/src/lib/autoConnect.ts` — **pure** decision function (no React, no IPC):

  ```ts
  export type AutoConnectPlan =
    | { kind: 'idle' }
    | { kind: 'reload' }          // bump reloadNonce to re-navigate the current url
    | { kind: 'detect' }          // poll detectPorts on the linked terminal, push first hit

  export interface AutoConnectInput {
    status: PreviewStatus          // 'idle' | 'connecting' | 'connected' | 'load-failed'
    hasUrl: boolean                // board.url is a non-empty http(s) URL
    hasSource: boolean             // board.previewSourceId is set (linked terminal)
    attemptsSinceChange: number    // for backoff gating (see cadence)
  }

  export function planAutoConnect(i: AutoConnectInput): AutoConnectPlan
  ```

  Rules (per approved decisions):
  - `status === 'connected'` → `idle`. (Stops both loops once connected.)
  - `status === 'load-failed'` or `status === 'connecting'` (stale), `hasUrl` → `reload`.
  - not-connected, `!hasUrl` (or never connected) **and** `hasSource` → `detect`.
  - otherwise → `idle`.

  Note: per "only if board not connected", `detect`/`reload` are gated to the
  not-connected states only — a `connected` board is never reloaded or re-pushed, so a
  working preview / a route the user navigated to is never clobbered.

- `src/renderer/src/canvas/boards/useBrowserAutoConnect.ts` — the React hook that drives
  the policy. Mounted **once** next to `usePreviewManager` inside `BrowserPreviewLayer`
  (sibling, returns `void`). Per tick (single shared interval, see cadence):
  - read browser boards from `canvasStore` (imperative `getState`, like the manager) +
    their `previewStore` runtime;
  - for each not-connected board, call `planAutoConnect`:
    - `reload` → `usePreviewStore.getState().requestReload(id)` (reconcile re-navigates).
    - `detect` → `await window.api.detectPorts(board.previewSourceId)`; if a URL is found
      whose **origin** differs from `board.url`, `updateBoard(id, { url: origin })` (no
      `beginChange` → no undo step). The reconcile then navigates to it.
  - When a board reaches `connected`, its attempt counter resets and it falls to `idle`.

**Cadence / backoff:** one shared `setInterval` at a 1s base tick. Per board, gate work by
an attempt counter so retries back off `1s → 2s → 4s`, capped at `4s` (skip ticks until the
next due time). Reset the counter whenever the board's `status` changes (so a fresh
load-failed restarts fast). The interval only runs while ≥1 browser board is not-connected;
it is cleared when all are connected/absent (cheap idle).

**UI:** in the load-failed / connecting state, show "Reconnecting…" as the `bb-state` sub-text
(instead of the bare error) while the engine is actively retrying, so the board reads as
*alive*, not broken. (`DeviceContent` in `BrowserBoard.tsx`; the manual reload button stays.)

### Sub-feature 3: open-in-OS-browser

- **Main:** new IPC `preview:openExternal` (frame-guarded via `isForeignSender`):
  `(id) => openExternalSafe(liveUrl ?? boardUrl)`. The handler reads the view's current URL
  (`webContents.getURL()`) when available, else falls back to the id's last-known URL passed
  from the renderer. Simplest: renderer passes the URL string it already has
  (`runtime.liveUrl ?? board.url`); handler re-validates with `isAllowedExternal` before
  `shell.openExternal`. Signature: `preview:openExternal(url: string)`.
- **Preload:** `openExternalPreview(url: string): Promise<boolean>`.
- **Renderer:** a URL-bar button (after reload) → `window.api.openExternalPreview(runtime.liveUrl ?? board.url)`.

Security: scheme stays allowlisted at the boundary (`isAllowedExternal`); nothing new can
reach the OS handler that couldn't already via `window.open`.

### Sub-feature 4: screenshot-to-canvas (clipboard + assets/)

- **Main:** new IPC `preview:screenshot` (frame-guarded): for board `id`,
  `capturePage()` → `nativeImage`. If empty (detached/off-screen/un-composited) → return
  `{ ok: false, reason: 'not-live' }`. Else:
  - `clipboard.writeImage(img)`;
  - write `img.toPNG()` to `<projectDir>/assets/screenshot-<YYYYMMDD-HHmmss>.png` via
    `write-file-atomic` (create `assets/` if missing). If no project is open
    (`getCurrentDir()` null) → still copy to clipboard, return `{ ok: true, path: null }`.
  - return `{ ok: true, path }`.
  - `Date.now()` / timestamp formatting is fine in main (only Workflow scripts forbid it).
- **Preload:** `screenshotPreview(id: string): Promise<{ ok: boolean; path: string | null; reason?: string }>`.
- **Renderer:** a URL-bar camera button, enabled only when `runtime.live` (capturePage is
  blank otherwise). On click → call IPC → toast:
  - `ok && path` → "Screenshot copied + saved to assets/"
  - `ok && !path` → "Screenshot copied to clipboard" (no project open)
  - `!ok` → "Open the preview to screenshot it" (not live).
  - Feedback reuses the existing `.ca-preview-note` pattern (TerminalBoard:809 — a
    `role="status"` note with a Dismiss button): a local `useState<string | null>` note in
    `BrowserBoard`, auto-cleared after ~2.5s (or dismissed). No new toast subsystem.

## Data flow

```
dev server starts          board points at dead URL
   │ prints Local: URL          │ load-failed
   ▼                            ▼
terminal raw buffer        useBrowserAutoConnect tick
   │ detectPorts(sourceId)      │ planAutoConnect → reload
   ▼                            ▼
updateBoard(url=origin)    requestReload(id) → nonce++
   └──────────► reconcile (usePreviewManager) ──► navigatePreview / openPreview
                                                       │
                                            did-finish-load → status: connected → engine idles
```

## Error handling

- `detectPorts` rejects / returns `[]` → treat as "nothing yet", keep ticking (backoff).
- `capturePage` rejects / empty → screenshot returns `not-live`; toast guides the user.
- File write fails (ENOSPC/EPERM/read-only) → screenshot still copied to clipboard;
  return `{ ok: true, path: null }` with a logged warning (do NOT silently swallow — the
  clipboard copy is the success, the file is best-effort).
- Board deleted mid-tick → guarded by reading live `getState()` each tick (no stale id).
- All new IPC handlers reject foreign senders (`isForeignSender`) and re-validate URLs.

## Testing

- **Unit (renderer):** `autoConnect.test.ts` — `planAutoConnect` truth table (every status
  × hasUrl × hasSource); backoff scheduler (attempt counter → due-time gating, reset on
  status change).
- **Unit (main):** screenshot filename/timestamp formatting; `preview:screenshot` +
  `preview:openExternal` handler tests (frame-guard rejects foreign sender; scheme-gate;
  empty-capture → not-live; no-project → clipboard-only). Reuse `ipcTestHarness` /
  injected-deps pattern (`clipboardIpc.test.ts` style) so Electron isn't mocked wholesale.
- **E2E (Playwright `_electron`):**
  - reconnect: seed a Browser board at a refused port → assert `load-failed` → start the
    local server at that port (or point at `localUrl`) → assert it auto-reaches `connected`
    without a manual reload.
  - screenshot: seed + connect a board → call `screenshotPreview` → assert the returned
    path `fileExists` and the file is non-empty PNG bytes.
- Gate (`typecheck · lint · format:check · unit+integration`) **and** the e2e
  Win-native + Linux-Docker matrix green before handoff (memory: e2e-before-handoff,
  gate-must-run-format-check).

## Files touched

| File | Change |
|---|---|
| `src/renderer/src/lib/autoConnect.ts` | **new** — pure `planAutoConnect` + backoff helper |
| `src/renderer/src/canvas/boards/useBrowserAutoConnect.ts` | **new** — engine hook |
| `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx` | mount the new hook |
| `src/renderer/src/canvas/boards/BrowserBoard.tsx` | open-external + screenshot buttons; "Reconnecting…" state |
| `src/main/preview.ts` | `preview:openExternal`, `preview:screenshot` handlers |
| `src/main/clipboardIpc.ts` *(or preview.ts)* | `clipboard.writeImage` use (keep clipboard logic where it fits best) |
| `src/preload/index.ts` + `index.d.ts` | `openExternalPreview`, `screenshotPreview` |
| tests | `autoConnect.test.ts`, main handler tests, e2e specs |

## Security review (no invariant weakened)

- `contextIsolation`/`sandbox`/`nodeIntegration` untouched; new IPC is frame-guarded.
- Open-external stays scheme-allowlisted (`isAllowedExternal`).
- Screenshot writes only inside the open project dir (`getCurrentDir()` + `assets/`).
- Auto-push uses **origin only** from detected URLs; detected/previewed content never
  reaches the PTY write channel and never auto-drives an MCP dispatch.
- `updateBoard` programmatic url-set adds no undo step (plain setter), so auto-push can't
  corrupt the undo stack.

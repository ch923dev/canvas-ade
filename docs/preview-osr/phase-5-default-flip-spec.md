# OS-3 Phase 5 — Default-flip to OSR (+ OSR e2e harness + OSR screenshot)

Status: implemented on `feat/osr-phase5-flip`. Per the doc lifecycle this spec retires with the
final OS-3 PR (the 5C native-path deletion). Prior phases: `phase-{1,2,3,4}-*.md` in this folder.

## Decisions (locked)

- **OSR becomes the default preview engine.** `VITE_PREVIEW_OSR` is read default-ON
  (`!== '0'`). A `VITE_PREVIEW_OSR=0` build still yields the legacy native `WebContentsView`
  engine — kept as a runtime **escape hatch**.
- **The native path is NOT deleted in this PR.** Its full removal (`preview.ts` /
  `usePreviewManager` / `previewPlan` / native IPC + preload / native e2e probes /
  `selfTest.testPreview`) + removing the flag entirely is the **5C** follow-up, once the new
  default has soaked. (User decision, 2026-06-16.)
- **No design artifact.** OSR introduces no new visible chrome (same device frame + nav bar,
  validated through Phases 1–4); it only changes the rendering engine. Phase-3 precedent.
- **Screenshot stays a shipped feature.** The camera button, disabled in OSR until now, gets an
  OSR capture path so the default experience does not regress.

## Problem

The e2e suite builds the bundle **once** (`pretest:e2e` = `electron-vite build`) with the flag
unset, so today every `@preview` spec tests the **native** engine via native-only probes
(`captureView`, `live` attach/detach). Flipping the default makes that build OSR — so the flip can
only land honestly alongside an **OSR e2e harness** + migrated specs, or it would ship OSR-as-default
untested in the gate (the deferred "flag-on OSR e2e" item, now required).

## Design

### 1. The flip
Invert the 3 renderer read-sites (`=== '1'` → `!== '0'`): `BrowserBoard.tsx`,
`BrowserPreviewLayer.tsx`, `useBrowserAutoConnect.ts`; update `env.d.ts`. No `electron.vite.config.ts`
change (Vite auto-exposes `import.meta.env.VITE_*`). `selfTest.ts` builds both engines'
probes flag-independently — left alone.

### 2. OSR e2e harness
- **`osrCanvasNonBlank(id)`** (renderer hook, `e2eHooks.ts`) — `getImageData` readback of
  `[data-bb-frame] canvas.bb-live`; true iff ≥1 opaque pixel AND non-uniform. The faithful OSR
  replacement for native `captureView → {empty}` (proves the offscreen frame reached the visible
  DOM canvas). The canvas is renderer-`putImageData`-filled → not tainted → readable.
- **`debugCrashOsr(id)`** (MAIN, `previewOsrCapture.ts`; registered in `e2eMain` as `crashOsr`) —
  SIGKILLs `getOsrWindow(id).webContents.getOSProcessId()` (NOT `forcefullyCrashRenderer`, a
  container-kernel no-op). Mirrors `debugCrashView`.
- **`captureOsrToFile(id, absPath)`** (MAIN, `e2eMain`) — `captureOsrPng` → disk; the OSR evidence
  primitive, and a cross-leg proof the screenshot `capturePage` path is non-blank.
- **Deterministic reset teardown** — `preview:osrCloseAll` IPC + `closeAllOsr` preload, called from
  `disposeLiveResources` so OSR windows + their `preview-osr-${id}` sessions don't leak across
  specs / project switches (per-board unmount cleanup races React commit timing).
- New MAIN capture/crash helpers live in **`previewOsrCapture.ts`** (extracted to keep
  `previewOsr.ts` under the 700-line lint ratchet), reaching the window via `getOsrWindow`.

### 3. e2e spec migration (10 specs — the flip's real blast radius, wider than the 7 `@preview`)
| Spec | Disposition |
|---|---|
| `browser.e2e.ts` | PORT connect→`osrCanvasNonBlank`; keep refused→load-failed; **DELETE** gesture- & focus-detach (native attach/detach only). |
| `browserCrash.e2e.ts` | PORT via `crashOsr`; drop the native `viewWebContentsId` stability assert (reconnect is the contract). |
| `browserReconnect.e2e.ts` | unchanged (status-only; `useBrowserAutoConnect` is engine-agnostic). |
| `browserScreenshot.e2e.ts` | PORT — engine-agnostic IPC; gate on `osrCanvasNonBlank` before capture. |
| `fullview.e2e.ts` | **DELETE** other-board native-detach; **REPLACE** same-wc with "canvas keeps painting across the portal relocation"; keep mobile-aspect + Esc-close. |
| `preview-align.e2e.ts` | **DELETE** entire file (native rect-tracking + occlusion-demote — both inherent/absent in OSR). |
| `previewLink.e2e.ts` | unchanged (port-detect + picker; engine-agnostic). |
| `boardKeyboard.e2e.ts` | **DELETE** the A3 native-focus-return test (OSR never takes OS keyboard focus — routes through the renderer proxy textarea). |
| `commandPalette.e2e.ts` | **DELETE** the ADR-0002 palette-detaches-native-preview test (OSR canvas is a clipped DOM node the modal renders over). |
| `evidence.e2e.ts` | PORT `captureViewToFile` → `captureOsrToFile`. |

Unit/integration follow-ons: `BrowserBoard.test.tsx` mocks the OSR engine hooks (chrome tests) +
fixes 2 engine-specific assertions (reload CTA → `reloadOsrPreview`; camera gate → status:connected);
`disposeLiveResources.test.ts` + `AppChrome.switchto-error.integration.test.tsx` add the `closeAllOsr`
mock.

### 4. OSR screenshot (no regression)
`preview:screenshot` capture is now engine-agnostic: native `captureViewPng(id)` first, then
`captureOsrPng(id)` (`osrWin.webContents.capturePage()`), reusing the existing asset-save pipeline.
The camera button re-enables in OSR, gated on `status === 'connected' && osrAlive`. Fallback if the
hidden-window capture is blank on the software-GL Linux leg: a renderer-canvas `toBlob` path (the
e2e `captureOsrToFile` proves which is needed — both legs must be green).

### 5. Ride-along nit
`sanitizeOsrSize` now hard-caps each logical dimension at 4096px (deferred since Phase 1).

## Tests / acceptance
- Gate: typecheck (3 tiers) · lint (`max-lines` ratchet honored via the `previewOsrCapture.ts`
  extraction) · format · unit (+ the new sanitize-cap + `closeAllOsr` + OSR-default chrome assertions).
- Full e2e matrix **both legs** — now the **OSR-built** bundle by default.
- Native escape-hatch sanity: `VITE_PREVIEW_OSR=0` build compiles + boots the native engine.
- **Manual (user):** OSR renders Browser boards by default (occlusion-free); the screenshot button
  works + a PNG lands. Title-stamped dev check.

## Out of scope → 5C
Delete the native engine + remove the flag and the 3 read-site branches entirely (the §7 cleanup);
then `BrowserBoard.test.tsx` drops the native-branch mocks. Plus any residual P2 polish.

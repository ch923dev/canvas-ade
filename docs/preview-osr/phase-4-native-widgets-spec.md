# OS-3 Phase 4 — OSR preview native widgets & dialogs (`<select>` · date/color · dialogs · file · downloads · mute)

> Slice spec for `feat/osr-phase4-widgets`. Fourth phase of OS-3 (OSR Browser-preview
> productionization). Per the doc-lifecycle this file is **deleted on the FINAL OS-3 PR** (the
> build-history line is the residue, #150 backdrop precedent). Authoritative gap register: the spike
> spec `docs/reviews/2026-06-14-electron-to-flutter-assessment/preview-offscreen-spike-spec.md` › §8c —
> the remaining P1 rows this phase closes: **native `<select>`/date/color popups**, **`alert`/`confirm`/
> `prompt` dialogs**, **`<input type=file>`**, **downloads**, and **`<video>/<audio>` mute**. Builds on
> Phase 1 (#155 sizing), Phase 2 (#159 paint-gating/MAX_LIVE), Phase 3 (#163 input fidelity).

## Decisions locked

- **Rollout (unchanged):** OSR stays **flag-gated** (`VITE_PREVIEW_OSR`); the default-flip + native-path
  deletion is **Phase 5**. This phase only changes behaviour behind the flag.
- **Scope = ALL five §8c rows** (user call, 2026-06-15): mute · dialogs · downloads · file picker · the
  native popup overlays (`<select>` **and** date **and** color). No deferral.
- **JS dialogs = faithful modal** (user call): a board-anchored modal returns the user's real choice via
  CDP `handleJavaScriptDialog` (not auto-dismiss). Closes the **freeze/hang** bug either way.
- **Downloads = allow + save to OS Downloads + toast** (user call): `item.setSavePath(Downloads/name)`
  (no parented-dialog freeze) with start/done/fail toasts + a **Show** (reveal-in-folder) action.
- **No schema change.** Manual mute is **ephemeral** (per session, resets on reload); auto-mute-when-frozen
  is automatic and separate. Keeps Phase 4 off S4's `schemaVersion` bump (10→11) — file-disjoint lanes.
- **Design artifact:** signed off 2026-06-15 — `.claude/mocks/osr-phase4-widgets-mock.html` →
  `osr-phase4-widgets-mock.png` (+ per-section `p4-{1..4}-*.png`), built with `index.css` tokens.

## Why the page can't do this itself (grounded)

The OSR producer renders the page in a hidden, never-shown offscreen `BrowserWindow` and streams BGRA
frames to a DOM `<canvas>` (`previewOsr.ts`). A flat bitmap + a never-OS-focused window breaks every
**native/OS-composited** affordance:

- **`<select>`/date/color popups never render** — Chromium composites these as OS popup widgets, which an
  offscreen window cannot draw (electron #34095). The list/calendar/swatch simply never appears.
- **`alert`/`confirm`/`prompt` FREEZE** — a blocking JS dialog tries to show a native modal parented to a
  hidden window; it can't, and the renderer's main thread blocks (electron #10510).
- **`<input type=file>`** — the native file chooser is un-parented / may not surface.
- **Downloads** — unhandled → Electron's default behaviour (silent save or a parented save-dialog freeze).
- **`<video>/<audio>`** — audio plays from an invisible window with no way to mute it.

All levers are **MAIN-side CDP over the already-attached `wc.debugger`** (ADR 0002 pre-authorizes the
attach; renderer sandbox untouched) + the per-board session (`partition: preview-osr-${id}`). The chrome
they need is HTML, so it clips/rounds inside `.bb-frame` like the canvas — no occlusion.

## Design

### Module layout

- `src/main/previewOsrWidgets.ts` (**new**) — all Phase 4 MAIN wiring + pure helpers, so `previewOsr.ts`
  stays focused. `ensureOsr` calls `attachOsrWidgets(e, emit)` once after the debugger attaches.
- `src/renderer/src/store/osrWidgetStore.ts` (**new**) — per-board pending **dialog** + pending **popup**
  (Zustand); fed by the `preview:event` consumer, read by the overlay layer.
- `src/renderer/src/canvas/boards/osr/` (**new**): `OsrWidgetLayer.tsx` (coordinator, mounted in
  `.bb-frame`) + `OsrJsDialog.tsx` · `OsrSelectOverlay.tsx` · `OsrDatePicker.tsx` · `OsrColorPicker.tsx`.
- `src/renderer/src/lib/osrWidgets.ts` (**new**, pure) — `pageRectToCanvas` (page CSS px → canvas-local px,
  the same supersample/preset scale `useOffscreenInput` already computes), `monthGrid(year,month)` (6×7
  day matrix), `hsvToHex`/`hexToHsv`, `clampPopupRect` (keep the overlay inside the frame). Unit-tested.

### 4A — Audio mute (`wc.setAudioMuted`)

- **Toggle:** a speaker button in the URL-bar cluster (between Reload and Screenshot), shown **only while
  the board is audible**. `preview:osrSetMuted(id, muted)` → MAIN `wc.setAudioMuted(muted)`. Manual mute is
  ephemeral renderer state (`previewStore` per board) — no schema field.
- **Audible detection:** MAIN listens `wc.on('audio-state-changed' | 'media-started-playing' |
  'media-paused')` and emits `preview:osrAudible(id, audible)` (diff-skipped) → the button mounts/unmounts.
- **Auto-mute when not live:** when `applyOsrPaint(false)` (off-screen/below-LOD) OR a MAX_LIVE evict, set
  `wc.setAudioMuted(true)`; on resume restore the **effective** state (`manualMuted`). So a frozen board is
  silent without losing the user's choice. The manual flag lives on the `OsrEntry`.

### 4B — JS dialogs (CDP `Page.javascriptDialogOpening` / `handleJavaScriptDialog`)

- On attach: `Page.enable`. A `wc.debugger.on('message')` handler catches `Page.javascriptDialogOpening`
  `{type: alert|confirm|prompt|beforeunload, message, defaultPrompt, url}` and emits
  `preview:osrDialog(id, {type, message, defaultPrompt})`. The dialog is now **CDP-owned** → the renderer
  no longer blocks; nothing shows until we respond.
- `beforeunload` is auto-accepted in MAIN (no UI — a preview reload/nav shouldn't prompt). `alert`/`confirm`/
  `prompt` raise the **board-anchored modal** (`OsrJsDialog`) over the device stage with a `--scrim` dim:
  - `alert` → message + single **OK**.
  - `confirm` → message + **Cancel** / **OK**.
  - `prompt` → message + a focused text input (pre-filled with `defaultPrompt`) + **Cancel** / **OK**.
- The user's choice → `preview:osrDialogRespond(id, {accept, promptText?})` → MAIN
  `Page.handleJavaScriptDialog({accept, promptText})`. Enter = OK, Esc = Cancel. The modal is **board-scoped**
  (dims only that board's stage; other boards stay interactive — a page can't lock the whole canvas).
- **Untrusted text** (`message`, `defaultPrompt`) renders as React text (escaped), length-capped.

### 4C — File picker (CDP `Page.setInterceptFileChooserDialog` + `DOM.setFileInputFiles`)

- On attach: `Page.setInterceptFileChooserDialog({enabled:true})`. `Page.fileChooserOpened`
  `{backendNodeId, mode}` (`mode` ∈ `selectSingle|selectMultiple`) → MAIN `dialog.showOpenDialog(win, {
  properties: mode==='selectMultiple' ? ['openFile','multiSelections'] : ['openFile'] })` (parented to the
  **main** window, so it's a real on-screen dialog) → on pick, `DOM.setFileInputFiles({files, backendNodeId})`
  (resolve the node via `DOM.getDocument`/the backendNodeId directly). Cancel → set no files (release).
- No new in-app chrome (the native OS dialog is the UI). `dialog` is MAIN-only (matches `projectIpc.ts`).

### 4D — Downloads (`session.on('will-download')`)

- The per-board session (`preview-osr-${id}`) handles `will-download`: `item.setSavePath(join(downloadsDir,
  safeName))` where `safeName = sanitizeDownloadName(item.getFilename())` (pure: `path.basename`, strip
  control/reserved chars, de-collide with ` (n)`). `downloadsDir = app.getPath('downloads')`.
- `item.on('updated')`/`'done'` → emit `preview:osrDownload(id, {state, name, savePath, received, total})`.
  The renderer shows a **toast** (existing `showToast`, board-scoped id so repeats collapse):
  start `Downloading <name>…` (+ percent when total is known), done `… — saved · [Show]` (Show →
  `shell.showItemInFolder` via a tiny `preview:osrRevealDownload` IPC), fail `Download failed`.
- **Abuse guard:** a token-bucket limiter (the `createOpenExternalLimiter` pattern) caps download starts;
  over-budget downloads are cancelled with a single throttle toast (a scripted page can't disk-bomb).

### 4E — Native popup overlays (`<select>` · date · color) — injected hook + React overlay

The §8c lever: *MAIN-side CDP-driven React overlay*. A bitmap can't draw the native popup, so we **detect**
the interaction in the page and **render our own** overlay positioned over the canvas.

1. **Inject** `OSR_WIDGET_SCRIPT` via `Page.addScriptToEvaluateOnNewDocument` (every nav) **and** once
   immediately on attach (`Runtime.evaluate` for the already-loaded page). The script (page main world,
   MAIN-authored, read-only except on our command):
   - capture-phase `pointerdown` on `document`: if `target.closest('select, input[type=date|datetime-local|
     month|week|time|color]')`, `preventDefault()` (suppress any native popup attempt) and report
     `{kind, rect: el.getBoundingClientRect(), value, options?[], min?, max?, step?}` via a
     `Runtime.addBinding('__osrWidget')` call (JSON). It also tracks the **active element** so we can write
     the value back.
   - exposes nothing the page can abuse beyond the binding (which only ferries data to our overlay; we
     validate + cap option count/label length renderer-side; labels render as text).
2. MAIN `Runtime.bindingCalled` (`__osrWidget`) → emit `preview:osrPopup(id, payload)`.
3. Renderer (`OsrWidgetLayer`) maps `rect` (page px) → canvas-local px via `pageRectToCanvas` and renders:
   - **`<select>`** → `OsrSelectOverlay` (option list; ✓ + accent-wash on selected, hover highlight,
     keyboard ↑/↓/Enter/Esc, optgroup labels; scrolls if long; `clampPopupRect` flips above if it would
     overflow the frame bottom).
   - **date/month/week/time/datetime-local** → `OsrDatePicker` (`monthGrid`, ‹/› month nav, today =
     accent ring, selected = accent fill; time row when the type includes time).
   - **color** → `OsrColorPicker` (SV square + hue slider + hex field, `hsvToHex`/`hexToHsv`).
4. Commit → `preview:osrPopupCommit(id, value)` → MAIN `Runtime.evaluate` calls the injected
   `window.__osrSetWidgetValue(value)` which sets the **active** element's `value` and dispatches
   `input` + `change` (so React/controlled forms update). Dismiss (click-away / Esc) →
   `preview:osrPopupDismiss(id)` (no write). The overlay closes on commit/dismiss/board-blur.

### Key routing interaction (Phase 3)

`useOffscreenInput` keeps owning pointer/wheel/keyboard on the canvas/proxy. A popup is open ⇒ the overlay
captures its own keyboard (↑/↓/Enter/Esc) and the proxy keydown is suppressed while a popup/dialog is
active for that board (read the `osrWidgetStore` active flag) so Esc closes the overlay, not the page.

## Files

| File | Change |
|---|---|
| `src/main/previewOsrWidgets.ts` (new) | `attachOsrWidgets(e, emit)` (Page.enable + dialog/file/binding listeners + script inject); `applyOsrMuted`; `respondOsrDialog`; `setOsrWidgetValue`; `setOsrFiles`; `registerOsrDownloads(session, deps)`; pure `sanitizeDownloadName`; `OSR_WIDGET_SCRIPT` |
| `src/main/previewOsr.ts` | call `attachOsrWidgets` in `ensureOsr`; audio-state emit; auto-mute in `applyOsrPaint`/evict; register the new frame-guarded IPC handlers (`osrSetMuted`/`osrDialogRespond`/`osrPopupCommit`/`osrPopupDismiss`/`osrPickFiles`(internal)/`osrRevealDownload`) |
| `src/main/index.ts` | nothing new (handlers register via `registerPreviewOsrHandlers`) |
| `src/preload/index.ts` (+ `index.d.ts`) | `osrSetMuted`, `osrRespondDialog`, `osrCommitPopup`, `osrDismissPopup`, `osrRevealDownload`; events `onOsrDialog`, `onOsrPopup`, `onOsrAudible`, `onOsrDownload` |
| `src/renderer/src/store/osrWidgetStore.ts` (new) | per-board `{dialog, popup, audible, muted}`; actions to set/clear |
| `src/renderer/.../osr/OsrWidgetLayer.tsx` (new) | subscribes the store for this board; renders the active dialog + popup; mounts in `.bb-frame` |
| `src/renderer/.../osr/{OsrJsDialog,OsrSelectOverlay,OsrDatePicker,OsrColorPicker}.tsx` (new) | the four chrome surfaces (tokens per the mock) |
| `src/renderer/.../boards/useOffscreenPreview.ts` | consume `preview:osrDialog`/`osrPopup`/`osrAudible`/`osrDownload` → `osrWidgetStore` + `showToast` (downloads) |
| `src/renderer/.../boards/useOffscreenInput.ts` | suppress proxy keydown while a popup/dialog is active for the board |
| `src/renderer/.../boards/BrowserBoard.tsx` | mute toggle in the URL-bar cluster (audible-gated); mount `<OsrWidgetLayer>` in `.bb-frame` |
| `src/renderer/src/lib/osrWidgets.ts` (new, pure) | `pageRectToCanvas`, `monthGrid`, `hsvToHex`/`hexToHsv`, `clampPopupRect`; unit-tested |
| `src/renderer/src/index.css` | `.bb-osr-dialog`/`-scrim`, `.bb-osr-dropdown`/`-opt`, `.bb-osr-picker`, `.bb-osr-color`, mute-btn audible dot (additive) |

## Tests

- **`osrWidgets.test.ts` (pure):** `monthGrid` (leading/trailing days, leap Feb); `hsvToHex`↔`hexToHsv`
  round-trip + clamp; `pageRectToCanvas` maps under a supersample+preset scale; `clampPopupRect` flips/edges.
- **`previewOsrWidgets.test.ts` (main):** `sanitizeDownloadName` strips traversal/control/reserved + de-collides;
  `applyOsrMuted` calls `setAudioMuted`; `respondOsrDialog` sends `Page.handleJavaScriptDialog` (accept +
  promptText); download token-bucket cancels over budget; dialog/binding message parsing maps to the emitted
  payloads (drive a fake `debugger`); a forged/oversized binding payload is rejected (cap option count/length).
- **e2e (`@preview`, flag ON):** against a tiny local page — `confirm()` shows the modal, OK resolves true
  (page records it); a `<select>` click opens the overlay, picking an option updates the page's value; a
  download saves to a temp dir + emits the toast. (Real CJK/audio are manual.) Tag per `docs/testing/TESTING.md`.

## Acceptance (Phase 4) — manual dev check, flag ON, title-stamped

`$env:VITE_PREVIEW_OSR='1'; $env:CANVAS_DEV_TITLE='PR#NNN OSR Phase 4'; pnpm dev` against a small page with a
`<select>`, `<input type=date>`, `<input type=color>`, a `confirm`/`prompt` button, an `<input type=file>`, a
download link, and a `<video>`:

- **`<select>`** — click opens our dropdown over the canvas; ↑/↓/Enter picks; the page value updates (a
  bound React form reflects it). **date** — calendar opens, pick a day → input updates. **color** — picker
  opens, choose → input + swatch update.
- **confirm/prompt** — the modal appears (no freeze); OK/Cancel return the right value to the page; prompt
  returns the typed text; Esc = Cancel.
- **file** — `<input type=file>` opens the native OS dialog (parented, on-screen); the chosen file's name
  shows in the page.
- **download** — clicking a download link saves the file to the OS Downloads folder; start + done toasts;
  **Show** reveals it.
- **mute** — play the `<video>`; the speaker button appears; click → audio stops; pan the board off-screen →
  it auto-mutes; bring it back → restores your manual state.
- **No regression** — typing/clipboard/wheel (Phase 3), sizing (Phase 1), paint-gating (Phase 2) all still
  work; confirm the window title reads this PR's stamp.

Full gate green; **FULL e2e matrix at the pre-merge gate** (touches `src/main` → Linux leg required).

## Security (never weaken)

- All new IPC handlers are `isForeignSender` frame-guarded; sandbox/contextIsolation/nodeIntegration on the
  OSR window unchanged; `simple-git`/PTY untouched; Browser content still never reaches the PTY.
- **Injected script** runs in the *previewed* page's world (already untrusted), authored by MAIN; it only
  reports widget data + sets values on our command. The `__osrWidget` binding is data-only; renderer
  validates + caps (option count ≤256, label ≤256 chars, rendered as text — no HTML).
- **Dialog/option/filename text is untrusted** → escaped React text, length-capped; download filenames are
  `basename`-sanitized into the Downloads dir (no traversal); download starts are token-bucket throttled.
- `Page.enable` dialog ownership means we MUST answer every dialog (incl. `beforeunload` → auto-accept) so a
  page can never wedge the renderer.

## Risks / handoffs

- **`<select>` native-popup suppression** — `preventDefault` on capture `pointerdown` stops the native popup
  attempt on Chromium; if a platform still flashes it, also `blur()` the element after reporting. Offscreen
  it generally never renders anyway (the bug we're fixing).
- **Popup rect under camera zoom** — `pageRectToCanvas` must use the SAME live scale as the input transform;
  re-anchor on `preview:osrPopup` only (popups are transient; no per-frame reposition — closes on camera move
  via board-blur is acceptable, matches a real browser closing a select on scroll).
- **`audio-state-changed` availability** — prefer the event; fall back to `media-started-playing`/`-paused`
  + `wc.isCurrentlyAudible()` if the event is absent on Electron 42.
- **No headless audio/IME** — pure helpers are unit-tested; CDP/overlay wiring verified by the manual check
  (same posture as Phases 2–3). The e2e covers dialog + select + download happy-paths.

## Out of scope (Phase 5)

The **default-flip** (`VITE_PREVIEW_OSR` on by default) + native `WebContentsView`-path deletion (attach/
detach/occlusion/`setBoundsBatch` across `preview.ts`/`usePreviewManager`/`previewPlan`/`BrowserBoard`) +
P2 polish (worker/`OffscreenCanvas`/WebGL frame path, 60fps focused cap, custom-cursor DoS rate-limit,
`page-title`/favicon → chrome, `requestFullscreen` → full view, native right-click menu) + the first
`@preview` flag-on OSR e2e harness build + the `sanitizeOsrSize` 4096-cap nit.

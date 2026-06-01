# Research — agent self-smoke-testing the app at runtime

> Deep-research output (2026-05-29), verified + cited. **Plan only — not built yet**
> (decided "just the report for now"). When we build it, follow the staged plan below.
> Goal: let an agent boot the app, drive each board, and assert results (incl. the
> native preview layer) **without a human eyeballing the GUI**.

## TL;DR — two layers, use both

1. **Keep the in-process harness** (`src/main/selfTest.ts` + `CANVAS_SMOKE`). Zero new
   deps, node-pty/native-module friendly, handles the spaced repo path. Already does the
   PTY-sentinel readback + per-view `WebContentsView` lifecycle. Best for non-UI checks
   and the native-view layer.
2. **Add Playwright `_electron`** for real rendered-UI interaction. `electron.launch()` →
   `ElectronApplication`; `firstWindow()` → a DOM `Page` (click/keyboard/mouse/locator);
   `electronApp.evaluate()` runs code in MAIN. Spectron is dead (deprecated 2022-02-01,
   archived, depends on Electron's removed `remote` module); Playwright is Electron's
   recommended successor. Agent reads pass/fail from the process exit code + console
   markers — no human eyeball.

## The key finding — the Browser native-view gap

A child `WebContentsView` paints in its **own** WebContents. Two confirmed blind spots:

- `mainWindow.webContents.capturePage()` **cannot see it** (separate native layer) — the
  exact gap hit during Phase 2 integration.
- Playwright's `connectOverCDP` **collapses every `partition: preview-<id>` session into
  ONE `BrowserContext`** → the per-board native views are **not** exposed as Playwright
  pages. Feature request **closed "not planned"** by a Playwright maintainer (2025-02-19,
  microsoft/playwright#34815). Will not be fixed.

**Fix — assert the native layer from MAIN** via `electronApp.evaluate()`: walk
`mainWindow.contentView.children`, filter `WebContentsView`, call each
`view.webContents.capturePage()` (per-view PNG) and/or `view.webContents.debugger.attach()`
for per-view CDP. `webContents.fromDevToolsTargetId(targetId)` exists in Electron 33 (PR
#29399), added specifically to fix Playwright's multi-WebContents support.

## Per-board coverage

| Board | Drive | Assert |
|---|---|---|
| Terminal | `page.keyboard` into the focused xterm (crosses MessagePort→node-pty) | read echo via **`@xterm/addon-serialize`** `serialize()` (official, scriptable framebuffer→string; beats DOM scraping). xterm.js itself tests with Playwright + `page.evaluate`. |
| Browser | click viewport segments + edit URL bar via `Page` | **per-view `capturePage()` from MAIN** (gap fix) + the `preview:event` states (connecting/connected/load-failed) |
| Planning | chained `page.mouse.move/down/up` with the `steps` arg (d3-drag needs ≥2 moves) for pen/arrow/drag | DOM for notes/checklist; pen-stroke shape |

React Flow "needs to measure nodes … relies on rendering DOM elements" → needs a **real-DOM
driver (Playwright)**, not jsdom.

## Gotchas (verified)

- **Windows headless = non-issue** on the dev machine — launch a real/background window
  (xvfb is Linux-only; no true headless requirement here).
- `webContents.sendInputEvent()` requires the window **focused** → fragile unattended.
  Playwright's CDP input path does **not** → prefer Playwright for driving input.
- `capturePage()` returns a **blank** image for detached/occluded/hidden views → capture
  **while on-screen** (matches our LOD detach+snapshot model: capture *before* detach, or
  use `stayHidden`).
- Playwright Mouse fires **mouse**, not **pointer** events; perfect-freehand listens for
  pointer events. Electron's CDP path *should* yield trusted pointer events, but **verify
  pen/drag empirically** (a refuted claim warns custom-canvas drag can silently no-op —
  microsoft/playwright#38370).
- **Don't hardcode coordinates** (a viewport-relative-CSS-pixel claim was refuted, 1-2) —
  derive targets from rendered element boxes + the live camera transform; verify.
- **Spaced path** (`Z:\Expanse`) does **not** break Playwright; the known spaced-path
  hazard is node-pty's winpty build, already mitigated by the pinned beta. Quote/absolute
  paths in launch args.
- To enumerate live preview views from `evaluate()` **without weakening** `sandbox:true`/
  `contextIsolation:true`: an **env-gated test-only global registry in MAIN** (e.g.
  `CANVAS_E2E=1`) — a registry, not a security change.

## Staged build plan (when we do it)

1. **In-process first (zero deps):** extend `selfTest.ts` — env-gated MAIN registry of the
   preview `WebContentsView`s + per-view `capturePage()` + a scripted boot→add-each-board
   check emitting `RENDERER_SMOKE`/`SELFTEST_DONE`-style markers. Gives self-verify today.
2. **Then Playwright:** add devDeps `@playwright/test` + `playwright`; `electron.launch({
   args: ['out/main/index.js'] })` against the built app; drive UI via `firstWindow()`;
   read the terminal via in-renderer `serialize()`; screenshot native Browser boards via
   per-view `webContents.capturePage()` inside `electronApp.evaluate()`.

## Open questions (resolve at build time)

- Test against the electron-vite **dev server** (HMR, :5173) or the **built** `out/main`?
  Does node-pty (Electron ABI) behave identically under a Playwright-launched process on
  the spaced path?
- Does Playwright `page.mouse`/`keyboard` reliably trigger RF v12 pan/zoom/drag/resize +
  a perfect-freehand stroke without pointer shims, or is a CDP `Input.dispatch*`
  (pointer-type) fallback needed? At which zoom levels do coordinate computations hold?
- Can `fromDevToolsTargetId` drive a specific Browser-board view end-to-end from a
  Playwright-attached CDP session, or is per-view CDP only practical via the in-process
  `view.webContents.debugger` path (programmatic-debugger vs DevTools-frontend are
  mutually exclusive on one target)?

## Key sources (primary unless noted)

- Playwright `ElectronApplication` — https://playwright.dev/docs/api/class-electronapplication
- Playwright `connectOverCDP` partition-collapse (closed not-planned) — https://github.com/microsoft/playwright/issues/34815
- Spectron deprecation — https://www.electronjs.org/blog/spectron-deprecation-notice
- Electron `webContents` (`capturePage`, `sendInputEvent` focus, `debugger`) — https://www.electronjs.org/docs/latest/api/web-contents
- `webContents.fromDevToolsTargetId` (PR #29399) — https://github.com/electron/electron/pull/29399
- `@xterm/addon-serialize` — https://www.npmjs.com/package/@xterm/addon-serialize ; xterm Playwright tests — https://github.com/xtermjs/xterm.js/issues/3446
- React Flow testing (needs real DOM) — https://reactflow.dev/learn/advanced-use/testing
- Playwright Mouse (drag chain; mouse-not-pointer) — https://playwright.dev/docs/api/class-mouse ; #38370
- wdio-electron-service (heavier alt; needs `EnableNodeCliInspectArguments` fuse) — https://webdriver.io/docs/wdio-electron-service/

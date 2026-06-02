# Electron E2E Testing: Landscape, Fit, and an Improvement Plan for Expanse

> **Provenance:** deep-research workflow (2026-06-03) — 5 web-search angles + 3 codebase
> readers → 12 sources fetched → 208 claims extracted → synthesis. 57 agents.
> **Verification caveat:** the 3-vote adversarial verify phase misfired (verifier agents
> failed to emit StructuredOutput under the WebSearch + forced-schema combo), so the
> "12/12 survived" count is hollow — refutation did not actually run. Load-bearing
> **landscape facts are anchored to primary sources** (electronjs.org, playwright.dev,
> GitHub issues); claims tagged *"Context (not independently verified)"* below are
> single-source community findings — treat as unverified. The **codebase analysis
> (§4) is firsthand** (read of our actual probe files), not web-sourced.
>
> Related: [`self-smoke-testing.md`](self-smoke-testing.md) (the deferred Stage-2 plan
> this report's P1-4 builds on).

## 1. Executive summary

- **Spectron is dead; do not consider it.** The Electron team officially deprecated Spectron effective February 1, 2022, after over a year of minimal maintenance, no full-time maintainers, and Electron 14 moving the `remote` module out of core (which would have required a full rewrite). Electron now points users to Playwright and WebdriverIO ([Spectron Deprecation Notice](https://www.electronjs.org/blog/spectron-deprecation-notice)).
- **The two viable out-of-process drivers are Playwright `_electron` and WebdriverIO (`wdio-electron-service`).** Cypress is the weakest fit — it has no first-class Electron-app target, only an open, uncommitted feature request ([Cypress #4964](https://github.com/cypress-io/cypress/issues/4964)).
- **Electron explicitly blesses a custom in-process driver as a legitimate, supported approach** — "lower overhead and lets you expose custom methods to your test suite" ([Automated Testing | Electron](https://www.electronjs.org/docs/latest/tutorial/automated-testing)). Our `CANVAS_SMOKE=e2e` harness is exactly this pattern, not a hack.
- **For Expanse's native-layer surface, the in-process harness is the right primary tool and out-of-process drivers are structurally weaker.** Playwright models Electron only at the BrowserWindow/WebContents-as-Page level with no documented WebContentsView API, has documented Electron screenshot defects, and hangs on teardown when IPC handlers spawn child processes that outlive the test — the exact shape of our node-pty terminal boards.
- **Our biggest internal gap is real input.** `webContents.sendInputEvent` is used **nowhere** in the harness; every simulated interaction uses synthetic `dispatchEvent`/`click`, which bypasses CSS-transform hit-testing and can false-green on the scaled/transformed canvas — the exact failure mode our own memory `e2e-sendinputevent-vs-dispatchevent` recorded (a full-view add-note bug that three synthetic probes missed).
- **CI now genuinely gates merges, but only recently and only on Windows.** The `smoke` job runs the harness and fails on non-zero exit, but it became a real gate only after PR #21/#22; the known `browser`/`browser-gesture`/`focus-detach` capturePage flake has no retry/quarantine, so CI can red-light on a non-regression.
- **Coverage is happy-path and shallow.** Exactly four boards, one of each type, mutation-coupled probes in a load-bearing order, no real on-disk persistence assertions, shallow whiteboard coverage, and no negative/error-path breadth beyond a dead URL.
- **Recommended direction: harden the in-process harness first (cheap, high-leverage), then add a thin Playwright `_electron` Stage-2 layer for the renderer-DOM/launch-lifecycle slice it does well** — not as a replacement, because the native-layer assertions must stay in-process.

---

## 2. Electron E2E landscape, 2025–2026

Electron does not ship or actively maintain a first-party test framework; its official guidance documents third-party tools instead ([Automated Testing | Electron](https://www.electronjs.org/docs/latest/tutorial/automated-testing)). The current field:

### Spectron — deprecated, do not use
Spectron was deprecated by the Electron team beginning February 2022. The deprecation notice cites three reasons: the project had "very little maintenance and improvements for well over a year," it had no full-time maintainers, and the `remote` module moving outside Electron core into an external module (`@electron/remote`) in Electron 14 would have required a major rewrite ([Spectron Deprecation Notice](https://www.electronjs.org/blog/spectron-deprecation-notice)). The repo is archived. This is a settled, permanent fact.

### Playwright `_electron` — maintained, fast, officially "experimental"
Playwright supports Electron via the `_electron` namespace: `electron.launch({ args: ['main.js'] })` returns an `ElectronApplication`, and `await electronApp.firstWindow()` yields the first BrowserWindow as a `Page`. *Context (not independently verified in the verified-claims set):* Playwright's docs label this support "experimental" and version-gate it (Electron v12.2.0+/v13.4.0+/v14+), with a `nodeCliInspect`-fuse launch-timeout caveat ([Electron | Playwright](https://playwright.dev/docs/api/class-electron)). `electronApp.evaluate(fn)` runs code in the **main** process with `require('electron')` passed as the first argument — the bridge to `BrowserWindow`, `ipcMain`, `app`, and `dialog` ([ElectronApplication | Playwright](https://playwright.dev/docs/api/class-electronapplication)). Maturity: modern auto-waiting test runner, tracing, video; widely treated as production-ready despite the "experimental" label. Maintenance: excellent (Microsoft).

### WebdriverIO (`wdio-electron-service`) — maintained, the "spiritual successor" to Spectron
WebdriverIO is a Node.js test-automation framework for WebDriver and is documented by Electron as an E2E option ([Automated Testing | Electron](https://www.electronjs.org/docs/latest/tutorial/automated-testing)). Scaffold via `npm init wdio@latest ./` (generates `wdio.conf.js`); the setup wizard offers "Desktop Testing - of Electron Applications" and uses the service name `electron`. It exposes `browser.electron.execute()` to run code in the main process with the `electron` module available (e.g., `electron.BrowserWindow.getFocusedWindow()`, `electron.dialog.showMessageBox()`), plus standard browser APIs (`browser.keys()`, `$()` selection, `.toHaveText()`). *Context (search findings, not in the verified set):* the actively maintained package has moved into the WebdriverIO org as `@wdio/electron-service`; it auto-matches Chromedriver to the app's Electron version for v26+ (Expanse is on 33, so no manual pinning), auto-detects electron-builder app paths, offers Vitest-like Electron-API **mocking** (`browser.electron.mock(...)`, no Playwright equivalent), supports multiremote, and offers automatic Xvfb on Linux (WDIO 9.19.1+) ([wdio-electron-service](https://github.com/webdriverio-community/wdio-electron-service)).

### Cypress — not a fit
Cypress tests web apps in a browser; Electron-desktop-app support is an open, uncommitted feature request ([Cypress #4964](https://github.com/cypress-io/cypress/issues/4964)). Skip it.

### Consensus recommendation
Electron officially recommends **Playwright and WebdriverIO** as the Spectron alternatives ([Spectron Deprecation Notice](https://www.electronjs.org/blog/spectron-deprecation-notice)). *Context:* community guidance frames the trade-off as Playwright for fast, low-config Chromium-only suites with built-in debugging vs. WebdriverIO when you need Cucumber/Appium/cloud-grid breadth or Electron-API mocking ([WebdriverIO vs Playwright | BrowserStack](https://www.browserstack.com/guide/webdriverio-vs-playwright-2026)).

---

## 3. Recommended approach for an app like ours

Expanse has three properties that bend the standard "just use Playwright" advice: **native `WebContentsView` layers**, **main-process IPC for node-pty/preview/simple-git**, and **an embedded xterm/node-pty terminal that spawns child-process trees**. Each one is a place where an out-of-process driver loses to an in-process probe harness.

**Where the in-process harness wins (and should stay authoritative):**

1. **Native-layer assertions.** A `WebContentsView` paints above all renderer HTML and has no z-index relative to it ([Migrating from BrowserView to WebContentsView | Electron](https://www.electronjs.org/blog/migrate-to-webcontentsview)); this is our own ADR-0002 "occlusion is inherent" finding. The only reliable way to assert what's on a preview view is a **per-view `webContents.capturePage()` from MAIN** — which is exactly what our harness does via `debugCaptureView`. Playwright surfaces only BrowserWindow-backed Pages, has no documented WebContentsView API, and has documented Electron screenshot defects (on-failure screenshots not written; full-page screenshots broken) — so its page-level screenshot pipeline can't see native preview content.
2. **Terminal lifecycle / IPC teardown.** Playwright tests **hang until timeout** on Linux/Windows when an IPC handler spawned a subprocess that outlives the test, and Microsoft closed that issue as "not planned" — the only working mitigation was an OS-level `taskkill /f /t`. That is precisely the shape of our terminal boards, and our documented Windows tree-kill (`taskkill /PID <pid> /T /F`) is the mitigation Playwright lacks. An in-process harness controls its own lifecycle and `app.exit(code)`.
3. **Custom domain methods.** Electron explicitly endorses the custom in-process driver for "lower overhead" and the ability to "expose custom methods to your test suite" ([Automated Testing | Electron](https://www.electronjs.org/docs/latest/tutorial/automated-testing)) — e.g., reading the real xterm framebuffer (`term.buffer.active`), polling `getRuntime()` for `status==='connected'&&live`, and capturing per-view pixels. An external driver can't reach these without weakening the sandbox.

**Where an out-of-process driver wins (and is worth adding as a thin layer):**

1. **Real OS input through the transform stack.** Playwright/WDIO drive genuine input that respects CSS-transform hit-testing — the gap our synthetic `dispatchEvent` probes have. (Note: in-process, `webContents.sendInputEvent` gives us the same real-input fidelity without adopting a whole driver — see §6.)
2. **Launch/lifecycle and cross-window coverage.** `electron.launch()` + `firstWindow()` exercises the real packaged-startup path and main-process state via `evaluate()`; WDIO additionally offers native Electron-API **mocking** for things like the project-open `dialog.showOpenDialog` flow.
3. **Cross-platform CI breadth.** Our smoke job is Windows-only today; a driver with auto-Xvfb (WDIO) or `xvfb-run` (Playwright) gives a path to macOS/Linux runtime E2E.

**Recommendation:** keep the in-process harness as the **primary** surface for native-layer, terminal, and IPC assertions; add a **thin Playwright `_electron` Stage-2** for the launch-lifecycle and real-input/renderer-DOM slice. Note the caveat that any adopted out-of-process driver inherits the experimental-support, screenshot, and IPC-teardown limitations above — so it augments, it does not replace.

---

## 4. Our harness today

Three surfaces cover the app, all driven from MAIN.

**(A) The `CANVAS_SMOKE=e2e` probe harness (main).** `src/main/index.ts` reads `process.env.CANVAS_SMOKE`; when `=== 'e2e'` it loads the renderer with `?e2e=1` (installs `window.__canvasE2E`), suppresses the HTML-screenshot path and the 800 ms self-test quit, and on the first `did-finish-load` runs `runE2ESmoke(mainWindow, localServer.url)`. The returned number becomes `process.exitCode`, then `flushRenderer()` + an idempotent `shutdown()` drains autosave/PTY/preview/local-server, then `app.exit(code)` (deliberately not `app.quit`, which ignores `process.exitCode` on Windows).

- **Runner** (`src/main/e2e/index.ts`): builds a shared `E2ECtx` (`context.ts`) carrying `evalIn` (executeJavaScript in the main world), `poll`, `delay`, MAIN-side debug accessors the renderer can't see (`debugTerminalPid`/`debugWriteTerminal` from `pty.ts`; `debugCaptureView`/`debugViewIds`/`debugViewWebContentsId` from `preview.ts`), a **mutable `ids` bag** (termId/browserId/planId/deadId/browserOk) that seed probes write and later probes read, and string sentinels. It first polls up to 8 s for `window.__canvasE2E`; if absent it emits a single failing `hook` part and returns exit 1.
- **Registration/order**: probes are hand-listed in one `PLAYLIST` (24 entries) and run sequentially. **Order is a load-bearing contract** — probes share seeded ids and undo each other's mutations (menu-chrome shrinks the terminal to w:150; preview-connect-gesture widens it back to 360; the final seed probe asserts the board count is back to 4).
- **Results** (`src/main/e2eReport.ts`, pure/unit-tested): `summarizeE2E(parts)` → `ok = parts.length>0 && every part ok` (**empty parts = failure**), `exitCode = ok?0:1`. Prints one `E2E_<NAME> {json}` per part plus an `E2E_DONE` summary. 24 entries but `fullview-preview` emits two parts, so **25 `E2E_*` markers** — the documented 25/25 baseline.

**What the probes actually cover:**
- **Terminal**: live PTY↔xterm sentinel read; `config-nowheel` (Configure popover carries React Flow's `nowheel`); `terminal-lod` (zoom 0.2 keeps the board mounted — PTY not killed at LOD); `terminal-respawn` (relaunch under the same id, fresh sentinel, no stale onExit reap); `terminal-adopt` (delete→undo keeps the **same pid** + replayed scrollback).
- **Terminal full-view**: open/close keeps the same PTY pid + scrollback (portal relocation, not remount); `fullview-close` (chrome-less; Escape from a focused xterm textarea still closes).
- **Browser / native WebContentsView**: seed at the in-process localServer, force zoom ≥ LOD to attach, poll `status==='connected'&&live`, assert a **non-blank per-view `capturePage`** (the gap `mainWindow.capturePage` can't see); verdict stored in `ids.browserOk` and gates the next two — `browser-gesture` (detach-all to snapshot, reattach) and `focus-detach` (focusing a terminal detaches a Browser elsewhere, reattaches on unfocus); `browser-deadurl` ends `load-failed` not `connected`.
- **Browser full-view**: `fullview-preview` (a mutation while a *different* board is full-viewed must not re-attach the native view over the scrim); `fullview-preserve` + `fullview-self-preserve` (webContents id survives — no close, no reset to `board.url`); `fullview-emulator` (Mobile preset renders aspect-correct ~390/844, letterboxed).
- **Planning + checklist**: seed planning, `addChecklist`, assert element kinds include `checklist` AND `roundTripOk()` (in-memory schema serialize/deserialize).
- **Preview link**: `preview-edge-stale` (edge solid while terminal runs, dashed when down); `duplicate-keeps-link`; `preview-connect-gesture` (print a dev-server URL → port detection; long-press/right-click open the connect picker; Connect links + sets the detected URL; a plain tap does *not* open the picker).
- **Layout**: `tidy('smart')` and `tile('cols-2')` via deterministic store paths (immune to the capturePage flake).
- **Board `...`-menu chrome**: `board-menu` (popover portals to `<body>`; Duplicate +1 / Delete −1 via real pointerdown+click); `menu-chrome` (clamp on-screen, icon color/stroke at rest); `menu-preview-detach` (open menu over a Browser detaches the native layer, reattaches on close).
- **Seed invariant**: exactly 4 boards remain at the end.

**(B) Renderer smoke** (`src/renderer/src/smoke/`): `useRendererSmoke.ts` (always-mounted) logs `RENDERER_SMOKE {reactflow,xterm,webgl}` and `RENDERER_FONTS` — the load-bearing assertion for the headless gate. `e2eRegistry.ts`/`e2eHooks.ts` install `window.__canvasE2E` and the `e2eTerminals` Map (lets `readTerminal` scrape the real xterm framebuffer). `FlowSmoke.tsx`/`TerminalSmoke.tsx`/`PreviewSmoke.tsx` are **manual/interactive** surfaces (multi-view manager, LOD/cap-4, preset reflow, leak cycle) — not asserted by the headless gate.

**(C) Main `selfTest.ts`**: `testPty` spawns a real node-pty shell, echoes a split-concatenated `CANVAS_PTY_OK` sentinel (6 s timeout), reports pid/shell, kills. `testPreview` creates a throwaway `WebContentsView` with locked security prefs, `loadURL`, passes on `did-finish-load`, tears down via `removeChildView` + `webContents.close()` (no `destroy()` — matches the leak rule). It does **not** cover camera-sync `setBounds`, zoomFactor reflow, capturePage snapshots, the cap-4/LOD detach lifecycle, or per-board partitions.

**(D) CI** (`.github/workflows/build.yml`): `check` (ubuntu: typecheck + lint + format:check + test + build) → `smoke` (windows-latest: `pnpm build` then `CANVAS_SMOKE=e2e pnpm start`, gates on exit code) and `package` (4-row unsigned electron-builder matrix), both `needs: check`.

---

## 5. Gap analysis

1. **No real input driver where one is needed (the central gap).** `webContents.sendInputEvent` is used **nowhere**. `menu.ts` (Duplicate/Delete `PointerEvent`s), `previewLink.ts` (globe `MouseEvent`s, lines ~121–149), and `fullview.ts` (Escape `KeyboardEvent`, line ~202) all use synthetic `dispatchEvent`/`click` via `executeJavaScript`. Synthetic events bypass CSS-transform hit-testing and can false-green on the scaled/transformed canvas — memory `e2e-sendinputevent-vs-dispatchevent` records a real full-view add-note bug that three synthetic probes missed. The harness fits/zooms-to-1 to mitigate but never tests *through* the real transform stack. This matches the documented non-flaky pattern: real OS input + state-based waits.

2. **CI gating is recent, narrow, and flake-exposed.** The chain became a genuine gate only after PR #21/#22 fixed a masking `format:check` failure (memory `ci-green-2026-06-02`); before that, `smoke needs:check` meant it never ran on main. It is **Windows-only** — no runtime E2E on macOS/Linux (those targets are exercised only by `package` build success). `smoke` and `package` both only `needs: check`, so they run **concurrently** — a green package artifact can exist while smoke fails. And the known `browser`/`browser-gesture`/`focus-detach` capturePage flake (memory `e2e-browser-trio-flake`) has **no retry/quarantine**: one failing part fails the whole run (exit 1), so a non-regression can red-light CI and require a manual rerun.

3. **Native-compositor pixels are largely unverifiable.** `focus-detach` itself notes the occluding pixel "isn't code-assertable" — it checks only the detach/reattach invariant. Browser correctness is a *non-blank* capturePage, **not** responsive-reflow verification: the `W ∈ {390,834,1280}` `fitScale`/`setZoomFactor` reflow math, the 0.25 zoom floor, and `setBounds` batching/diff-skip are unasserted.

4. **Coverage is happy-path and topology-shallow.** Exactly 4 boards (one terminal, one browser, one planning, one dead-url browser). No many-boards case, **no `~4-live-view` cap / over-cap close+recreate**, no multiple terminals or planning boards, no nested/overlapping layouts beyond what tidy/tile synthesize.

5. **Whiteboard coverage is thin.** Only checklist-add + in-memory round-trip. No notes/text/arrows/freehand-pen, eraser, marquee select, or whiteboard keyboard shortcuts — even though memory `e2e-whiteboard-probes` documents the technique (real DOM keydown + PointerEvent on `.pl-well`, screen coords via well-rect × scale, dispatch wrapped in try/catch, assert off `getBoards()`).

6. **Persistence is only in-memory.** `roundTripOk()` validates schema serialize/deserialize, **not** on-disk atomic write (`write-file-atomic`), the `canvas.json` + `.bak` parse-fail fallback, the ~1 s debounced autosave, the blur/`before-quit` flush, or `schemaVersion` migrations. Worse, the harness uses `app.exit` (which bypasses `before-quit`) and runs `flushRenderer()` only *after* the playlist — so the autosave-on-quit path is exercised incidentally, never asserted.

7. **Mutation-coupled, fixed-order, no isolation.** Probes thread one mutable `ctx.ids` bag and rely on each other to undo mutations; a failure or reorder mid-playlist leaves dirty state that can cascade into false failures downstream. There is no per-probe setup/teardown/reset.

8. **Determinism via fixed delays.** Heavy reliance on `ctx.delay(150..700ms)` alongside `poll()`; on a slow/contended host these can under-wait and produce flake independent of the capturePage trio.

9. **Negative/error-path breadth is thin.** Beyond `browser-deadurl` there is no PTY spawn failure, localServer bind-failure graceful-degrade, refused-then-recovered reconnection, kill-the-tree for deep child trees, resize-over-MessagePort, or `setWindowOpenHandler` deny-in-app-nav security assertion.

10. **Brittle sentinel matching.** `selfTest` PTY match is `buf.includes` with a split-concatenation trick to dodge the shell echo — brittle if echo behavior changes. `readTerminal`/`terminalMounted` depend on `TerminalBoard` registering into `e2eTerminals` under `isE2E()`; a registration regression returns null/false rather than a clear signal.

---

## 6. Prioritized improvement plan

Effort: **S** ≤ ½ day · **M** ~1–2 days · **L** ~3+ days. Each item names the risk it buys down.

### P0 — correctness of the gate itself

**P0-1 · Replace synthetic input with `webContents.sendInputEvent` on the transform-sensitive probes. (M)**
Convert the globe gesture (`previewLink.ts` ~121–149), the `...`-menu Duplicate/Delete clicks (`menu.ts` ~36/46), and the full-view Escape (`fullview.ts` ~202) from `dispatchEvent`/`click` to real OS input via `mainWindow.webContents.sendInputEvent`, computing screen coords from `getBoundingClientRect()` × camera transform (the well-rect × scale technique in memory `e2e-whiteboard-probes`). *Buys down:* the #1 structural false-green risk — synthetic events bypass CSS-transform hit-testing (memory `e2e-sendinputevent-vs-dispatchevent`; the missed add-note bug). Caveat: `sendInputEvent` requires window focus, so gate it behind a focus/`poll` readiness check, not a sleep.

**P0-2 · Quarantine/retry the known capturePage flake instead of failing the whole run. (S)**
Tag `browser`/`browser-gesture`/`focus-detach` and add a bounded in-probe retry (capture→await→re-capture, e.g. up to 3 attempts with a readiness poll) before emitting a fail; on persistent fail, mark the part `flaky` so `summarizeE2E` can downgrade it from a hard exit-1 to a reported soft-fail (memory `e2e-browser-trio-flake` proves it's an env capturePage flake, not a regression). *Buys down:* CI red-lighting on a non-regression and the manual-rerun tax. Touch `e2eReport.ts` (add a soft/flaky bucket) + the three probes.

**P0-3 · Make `package` depend on `smoke`, or surface smoke as a required check. (S)**
In `.github/workflows/build.yml`, either add `needs: [check, smoke]` to `package` or mark `smoke` a required status check on `main`. *Buys down:* the gap where a green, shippable installer artifact can be produced while the e2e gate is red (they currently run concurrently off `check`).

### P1 — close the highest-value coverage holes

**P1-1 · Assert the responsive-reflow math and the cap-4/LOD lifecycle. (M)**
Add probes that drive each `W ∈ {390,834,1280}` preset and assert the resulting `setBounds` width and `setZoomFactor` (including the 0.25 floor) via the MAIN `debugViewIds`/preview accessors, plus a probe that seeds >4 Browser boards and asserts over-cap views are closed and recreated on demand. *Buys down:* gap #3/#4 — the core Browser value prop (true responsive reflow, the ~4-live cap) is entirely unasserted today.

**P1-2 · Add real on-disk persistence + crash-safety probes. (M)**
Point the project at a temp folder; mutate; force the debounced autosave; assert `canvas.json` exists and parses; corrupt it and assert the `.bak` fallback loads; bump `schemaVersion` and assert the migration pipeline. Add an explicit `before-quit`/blur-flush assertion rather than relying on the incidental `app.exit` path. *Buys down:* gap #6 — persistence is only round-trip-in-memory; the atomic-write/`.bak`/migration/flush paths have zero runtime coverage.

**P1-3 · Broaden whiteboard coverage using the documented `.pl-well` technique. (M)**
Add notes/text/arrows/freehand-pen, eraser, marquee-select, and shortcut probes per memory `e2e-whiteboard-probes` (real keydown + PointerEvent on `.pl-well`, coords via well-rect × scale, try/catch around dispatch, assert off `getBoards()`, reuse `planId`). *Buys down:* gap #5 — Planning is a first-class board type with only checklist-add covered.

**P1-4 · Add a thin Playwright `_electron` Stage-2 lane for launch-lifecycle + real-input DOM. (L)**
Stand up `electron.launch({ args: ['out/main/index.js'] })` + `firstWindow()` for renderer-DOM and main-process `evaluate()` assertions, with MAIN-side per-view `capturePage` kept in-process for native layers (the planned Stage-2 shape, memory `self-smoke-test-plan`). Pin and verify the Electron-33/Playwright pair on Linux CI (`npx playwright install --with-deps`, `xvfb-run`), and use `taskkill /f /t` teardown to dodge the IPC-handler hang. *Buys down:* gap #1's structural fragility at the harness level and gap #2's Windows-only narrowness — gives a maintained, cross-platform real-input lane. Note this lane inherits Playwright's experimental-support/screenshot/teardown limits, so scope it to launch + DOM, not native-layer pixels.

### P2 — robustness and breadth

**P2-1 · Replace fixed `ctx.delay(...)` with state-based polls. (S→M)**
Audit `e2e/probes/*` for `ctx.delay(150..700)` used as a settle and convert each to a `poll()` on an observable readiness signal (mount flag, `getRuntime()` live, non-blank capture). *Buys down:* gap #8 — host-contention under-wait flake independent of the capturePage trio. Matches the canonical "ban fixed timeouts, wait on state" guidance ([rwoll.dev](https://rwoll.dev/posts/understanding-flaky-tests-and-avoiding-timeouts-with-playwright)).

**P2-2 · Add negative/security/error-path probes. (M)**
PTY spawn failure; localServer bind-failure graceful-degrade (the path in `index.ts`); refused-then-recovered reconnection; kill-the-tree for a deep child tree (`taskkill /T /F` vs negative pgid); resize-over-MessagePort; and a `setWindowOpenHandler` deny-in-app-nav assertion (external links → `shell.openExternal`). *Buys down:* gap #9 — error/security breadth is currently a single dead-URL probe.

**P2-3 · Decouple probe mutations / add lightweight per-probe reset. (M)**
Snapshot the `ids`/board state at playlist start and assert (or restore) the baseline between themed groups, so a mid-playlist failure can't cascade into false downstream fails. *Buys down:* gap #7 — fixed-order, mutation-coupled fragility.

**P2-4 · Extend runtime E2E to macOS/Linux via auto-Xvfb. (M)**
Add a Linux `smoke` leg using the in-process harness under `xvfb-run`/`xvfb-maybe` ([Testing on Headless CI | Electron](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci)), with node-pty rebuilt against the Electron ABI first (`electron-rebuild -w node-pty`) to avoid `NODE_MODULE_VERSION` mismatch ([electron/rebuild](https://github.com/electron/rebuild)). *Buys down:* gap #2 — board *behavior* on non-Windows targets is currently unverified at runtime.

---

## 7. Sources

- Spectron Deprecation Notice | Electron — https://www.electronjs.org/blog/spectron-deprecation-notice
- Automated Testing | Electron — https://www.electronjs.org/docs/latest/tutorial/automated-testing
- Electron | Playwright (class-electron) — https://playwright.dev/docs/api/class-electron
- ElectronApplication | Playwright (class-electronapplication) — https://playwright.dev/docs/api/class-electronapplication
- WebdriverIO vs Playwright | BrowserStack — https://www.browserstack.com/guide/webdriverio-vs-playwright-2026
- wdio-electron-service (GitHub) — https://github.com/webdriverio-community/wdio-electron-service
- Add support for testing Electron.js applications · Cypress #4964 — https://github.com/cypress-io/cypress/issues/4964
- Multiple browsers in Electron · Playwright #15576 — https://github.com/microsoft/playwright/issues/15576
- Tracing does not work with Electron · Playwright #13180 — https://github.com/microsoft/playwright/issues/13180
- Electron not launching in GitHub Actions (Process failed to launch) · Playwright #12139 — https://github.com/microsoft/playwright/issues/12139
- Leaky Electron IPC handlers cause tests to hang · Playwright #39248 — https://github.com/microsoft/playwright/issues/39248
- Screenshots on failure not working in Electron · Playwright #12125 — https://github.com/microsoft/playwright/issues/12125
- Full page screenshots don't work on Electron · Playwright #11041 — https://github.com/microsoft/playwright/issues/11041
- Migrating from BrowserView to WebContentsView | Electron — https://www.electronjs.org/blog/migrate-to-webcontentsview
- Continuous Integration | Playwright — https://playwright.dev/docs/ci
- Testing on Headless CI Systems | Electron — https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci
- Native Node Modules | Electron — https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
- electron/rebuild (GitHub) — https://github.com/electron/rebuild
- The matrix strategy in GitHub Actions — https://runs-on.com/github-actions/the-matrix-strategy/
- How to Avoid Flaky Tests in Playwright | Semaphore — https://semaphore.io/blog/flaky-tests-playwright
- Fixing a Flaky Test and Avoiding Sleeps with Playwright | rwoll.dev — https://rwoll.dev/posts/understanding-flaky-tests-and-avoiding-timeouts-with-playwright
- electron-playwright-helpers | npm — https://www.npmjs.com/package/electron-playwright-helpers

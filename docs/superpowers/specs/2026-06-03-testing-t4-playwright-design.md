# Testing T4 — Playwright `_electron` harness · design

**Date:** 2026-06-03 · **Branch:** `testing-strategy` (single branch for the whole initiative; PR #37) · **Status:** design, pre-plan
**Parent:** `docs/superpowers/specs/2026-06-03-testing-strategy-design.md` §T4
**Research backing:** `docs/research/2026-06-03-testing-strategy.md` (§4 tooling, §7 hard surfaces) · `docs/research/self-smoke-testing.md` (the deferred Playwright `_electron` + MAIN-side `capturePage` prior art)

---

## Goal

Replace the brittle homegrown `CANVAS_SMOKE=e2e` harness with **`@playwright/test` `_electron`**, port
the real-instance keep-set, and **retire the `CANVAS_SMOKE=e2e` code once parity is reached** — all on
PR #37. T4 does **not** re-enable the CI gate or add auto-update (that is T5).

T4 is the **riskiest phase** of the initiative: the first new dependency, and the first phase that
drives a real Electron instance from an external runner.

### Non-goals
- **No CI gate re-enable.** The `smoke` job stays `if: false`; removing it is T5. T4 leaves `.github/`
  untouched.
- **No auto-update e2e.** Needs Phase 5 packaging/electron-updater — T5.
- **No new branch.** Commit on `testing-strategy`; push updates PR #37.
- **No security weakening.** See the locked constraint below — this is non-negotiable.

---

## 🔒 Locked security constraint (the central T4 trap)

Playwright's / `electron-playwright-helpers`' **renderer-side** IPC helpers require
`contextIsolation:false` + `nodeIntegration:true`, which **violates this codebase's locked sandbox**
(CLAUDE.md "never weaken"). T4 uses **MAIN-process helpers only**:
`electronApp.evaluate(({ BrowserWindow }) => …)`, `ipcMainInvokeHandler`, `ipcMainEmit`, and an
**env-gated MAIN-side global registry** (a registry, NOT a security change — endorsed by
`self-smoke-testing.md`). **Never flip the sandbox to make a test pass.**

Both production seams T4 adds (`src/main/e2eMain.ts`, `window.__canvasE2E.reset()`) are **test-only,
env-gated**, and leave `contextIsolation:true` / `sandbox:true` / `nodeIntegration:false` exactly as
they are.

---

## Decisions (from brainstorming, 2026-06-03)

| Decision | Choice | Why |
|---|---|---|
| Probe driver | **Reuse `window.__canvasE2E`** + the MAIN dbg accessors | The proven renderer seam (`seedBoard`/`getBoards`/`readTerminal`/`patchBoard`/`fitView`/`getRuntime`/`exportBoard`/`openFullViewAnimated`/`enterCameraFullView`/`debugViewWebContentsId`/…). Only the *driver* changes; probe logic survives. |
| Test isolation | **Per-spec Electron instance + new `reset()`** | Balances boot cost vs native-resource bleed. ~6 boots (one per spec file), `reset()` between `test()`s. |
| Terminal tier | **All terminal coverage stays in Playwright e2e** | respawn/LOD/adopt need the real renderer+store+MessagePort+ConPTY; only the bare echo could move and ABI must match. One source of truth; defer any shrink. |
| Launch target | **Built `out/`** (not the dev server) | Matches the native node-pty ABI to the runner; deterministic; no HMR/:5173 coupling. |
| Runner config | **`workers: 1`, `fullyParallel: false`** | Native `WebContentsView` + PTY + GPU serialize cleanly; also dampens the known browser-trio contention flake. |
| Gate placement | **Separate `test:e2e` command** | Vitest `pnpm test` (680) stays the `check` gate, untouched. Playwright is its own command/job. |
| New dep | **`@playwright/test` only** (devDependency) | Sanctioned first dep of the initiative. Nothing else. |

---

## Architecture

### Directory layout (new `e2e/`; homegrown `src/main/e2e/` deleted at the end of T4)

```
playwright.config.ts          # root: testDir e2e/, workers 1, fullyParallel false, no webServer
e2e/
  fixtures.ts                 # launch/close + page + reset() beforeEach — the shared seam
  helpers.ts                  # driver helpers (evalIn→page.evaluate, main→electronApp.evaluate, poll, sendInput, capture)
  terminal.e2e.ts             # terminal · terminalFullview · terminalLod · terminalRespawn · terminalAdopt · configNowheel
  browser.e2e.ts              # browser · browserGesture · focusDetach · browserDeadUrl
  fullview.e2e.ts             # fullviewPreview · fullviewPreserve · fullviewSelfPreserve · fullviewEmulator · fullviewClose
  menu.e2e.ts                 # menuChrome · menuPreviewDetach
  previewLink.e2e.ts          # previewConnectGesture
  whiteboard.e2e.ts           # whiteboardFullviewAdd · whiteboardPasteImage · whiteboardExport
```

The `seed` probe is **dissolved**: per-test seeding + a board-count invariant (asserted in the spec
that needs it) replaces the standalone scaffolding probe. No shared `ctx.ids`, no cross-test
mutation, no ordered playlist.

### The driver seam — port the four `ctx` members

The homegrown `E2ECtx` (`src/main/e2e/context.ts`) has exactly four capabilities. Each maps to a
Playwright primitive; nothing else about the probes changes:

| homegrown `ctx` | Playwright equivalent |
|---|---|
| `ctx.evalIn<T>(expr)` — `win.webContents.executeJavaScript` in the renderer main world | `page.evaluate(() => window.__canvasE2E.*)` |
| `ctx.win` — MAIN-side `BrowserWindow` access | `electronApp.evaluate(({ BrowserWindow }) => …)` |
| `ctx.dbg.*` — `terminalPid` / `writeTerminal` / `captureView` / `viewIds` / `viewWebContentsId` (preview+pty internals the renderer can't see) | `electronApp.evaluate(() => globalThis.__canvasE2EMain.<fn>(…))` via the new MAIN registry |
| `ctx.poll(fn, ms)` | `expect.poll(fn, { timeout }).toBe(true)` / `expect(locator).toPass()` |
| real OS input (`win.webContents.sendInputEvent`, for transform-dependent probes) | `electronApp.evaluate((_, args) => win.webContents.sendInputEvent(...))` |

`helpers.ts` wraps these so the ported probe bodies stay close to the originals (e.g. a `evalIn(page,
expr)` and a `mainCall(app, fnName, ...args)`).

### Two new production seams (test-only, env-gated)

1. **`src/main/e2eMain.ts` — env-gated MAIN registry.** When `CANVAS_E2E` is set, `index.ts` installs
   `globalThis.__canvasE2EMain = { terminalPid, writeTerminal, captureView, viewIds,
   viewWebContentsId }` (the five accessors currently imported by `context.ts` from `preview.ts` /
   `pty.ts`). `electronApp.evaluate` runs in MAIN and reads this global — the only way to reach
   preview/pty internals without weakening the sandbox. A no-op when the env flag is absent. This is
   `self-smoke-testing.md`'s "env-gated test-only global registry in MAIN" verbatim.

2. **`window.__canvasE2E.reset()` — store/runtime teardown.** Added to `e2eHooks.ts` (behind the
   existing `isE2E()` gate). Clears `boards` / `past` / `future` / `selectedId` / focus / full-view
   state, tears down every native preview `WebContentsView`, and parks+kills any live PTYs → returns
   the app to an empty canvas. Drives `beforeEach` isolation so each test starts clean. JSON-safe
   return (a small summary) so it survives `page.evaluate`.

Everything else the slivers need is already on the hook — no other hook additions.

### Fixtures & lifecycle (`e2e/fixtures.ts`)

- `test.beforeAll`: `_electron.launch({ args: ['out/main/index.js'], executablePath: <electron from
  node_modules>, env: { ...process.env, CANVAS_E2E: '1' } })`; `page = await
  electronApp.firstWindow()`; wait for `window.__canvasE2E` to install (gate like `runE2ESmoke` does —
  poll `!!window.__canvasE2E`, 8 s).
- `test.beforeEach`: `await page.evaluate(() => window.__canvasE2E.reset())`, then each test seeds
  exactly what it needs via `seedBoard(...)`.
- `test.afterAll`: `await electronApp.close()`.
- **Per-spec instance**: each `*.e2e.ts` owns one launch (its own `beforeAll`/`afterAll`), so a spec's
  native-view/PTY churn can't bleed into another spec.

### capturePage / non-blank-frame

A child `WebContentsView` paints in its own WebContents → `mainWindow.capturePage()` **cannot see
it** (the Phase-2 gap; `self-smoke-testing.md`). Assert the native layer from MAIN: the preview
manager's **per-view** capture (`debugCaptureView`, surfaced through `__canvasE2EMain`), captured
**while on-screen** (a detached/occluded view captures blank — memory + research). Non-blank verdict =
the homegrown `browser` probe's existing check (byteLength / pixel-variance threshold).
`whiteboardExport` PNG uses the hook's existing `exportBoard(id, 'png')` → assert
`byteLength`/`imageCount`.

### Real OS input (transform-dependent probes)

`whiteboardFullviewAdd` and the gesture probes need a real `webContents.sendInputEvent` through the
**live camera transform** — a synthetic `dispatchEvent` false-greens (memory
`e2e-sendinputevent-vs-dispatchevent`). Reach it via `electronApp.evaluate`. Note the synthetic-
modifier nuance: `sendInputEvent` mouse `modifiers:['alt']` does **not** reach `e.altKey` (memory
`e2e-modifier-keys-synthetic`) → modifier-gesture probes drive a synthetic PointerEvent with
`altKey`/`shiftKey` flags through `page.evaluate` instead. Real Ctrl+V for `whiteboardPasteImage`
goes through `sendInputEvent` (`webContents.paste()` is a no-op on the non-editable well — memory
`paste-fires-at-document`).

---

## The keep-set ported (parity target)

Every probe below is genuinely real-instance (rationale in `docs/testing/TESTING.md` §E2E push-down).
Parity = each runs green on Playwright before the homegrown harness is deleted.

| Spec file | Ported probes |
|---|---|
| `terminal.e2e.ts` | `terminal` (node-pty/ConPTY spawn→echo via framebuffer) · `terminalFullview` · `terminalLod` (zoom-out must not unmount→kill PTY) · `terminalRespawn` (same id, fresh sentinel) · `terminalAdopt` (same pid + scrollback after undo) · `configNowheel` |
| `browser.e2e.ts` | `browser` (native `WebContentsView` attach + non-blank capture) · `browserGesture` · `focusDetach` · `browserDeadUrl` |
| `fullview.e2e.ts` | `fullviewPreview` (+`fullviewPreserve`) · `fullviewSelfPreserve` (webContents-id survival) · `fullviewEmulator` · `fullviewClose` — native view rebind, detach-not-close (memory `fullview-detach-not-close`) |
| `menu.e2e.ts` | `menuChrome` (real title-bar layout + viewport clamp + CSS-var rest colour) · `menuPreviewDetach` (native detach lifecycle) |
| `previewLink.e2e.ts` | `previewConnectGesture` (live port-detect IPC + long-press timer + dev-server URL into a real node-pty) |
| `whiteboard.e2e.ts` | `whiteboardFullviewAdd` (real OS click through the live camera transform) · `whiteboardPasteImage` (real Ctrl+V) · `whiteboardExport` (PNG raster) |

`whiteboardFullviewAdd` currently seeds the shared `planId` the homegrown slivers read; under
per-test seeding each whiteboard test seeds its own planning board (no shared id).

---

## Retire (same phase, after parity green)

1. Confirm `git grep` shows **nothing** imports `src/main/e2e/` outside that directory.
2. Delete `src/main/e2e/**` (`index.ts`, `context.ts`, `types.ts`, `probes/*`).
3. Remove the `CANVAS_SMOKE=e2e` branch + `runE2ESmoke` wiring from `selfTest.ts` / `index.ts`.
4. **Keep:** the `CANVAS_SMOKE=1|exit` self-test (separate, still useful), `e2eHooks.ts`,
   `e2eRegistry.ts`, and the new `e2eMain.ts` (all now driven by Playwright).
5. `e2eReport.ts` + its test go only if nothing else references them (verify; the homegrown harness is
   the sole consumer of `summarizeE2E`).

---

## Gate (must be green before finishing)

- `pnpm test` → still **680** (Vitest unchanged; Playwright is separate).
- `pnpm typecheck` clean · `pnpm lint` 0 errors · `pnpm run format:check` clean.
- `pnpm test:e2e` → the ported keep-set green locally (Windows). The
  `browser`/`browserGesture`/`focusDetach` trio may flake on a contended host (memory
  `e2e-browser-trio-flake`) — **rerun for a clean pass, not a regression**.
- Old `CANVAS_SMOKE=e2e` harness deleted; `git grep` confirms no imports of `src/main/e2e/`.

---

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| node-pty ABI mismatch under a Playwright-launched Electron | Launch the **built `out/`** against the `node_modules` electron so the native build matches the runtime. Spaced path safe (winpty-free beta — CLAUDE.md Stack). |
| `capturePage` returns a blank frame for a detached/occluded view | Capture **while on-screen** (capture→await→detach), per-view via the preview manager, not `mainWindow.capturePage`. |
| GPU / native-view contention flake (browser-trio) | `workers: 1`, `fullyParallel: false`; rerun-for-clean is an accepted env flake, not a regression. |
| `sendInputEvent` needs the window focused | Playwright launches a real focused window; `page.bringToFront()` / focus before input-dependent probes. |
| `__canvasE2E` not yet installed at first drive | Poll `!!window.__canvasE2E` (8 s) in `beforeAll`, mirroring `runE2ESmoke`. |
| Hidden order-coupling lost in the port (a probe silently depended on a prior probe's mutation) | `reset()` + per-test seed makes dependencies explicit; any probe that fails standalone reveals a real coupling to fix, not to port. |

---

## Cadence & finish

Plan → `docs/superpowers/plans/2026-06-03-testing-t4-playwright.md` (writing-plans next). Execute via
sonnet implementers (never haiku — memory `workflow-model-sonnet-not-haiku`) or inline executing-plans.
Commit design + plan first (docs-only), then implement. On green parity + harness deleted: push PR #37
(`finishing-a-development-branch`), update memory `testing-strategy` with "T4 shipped" + the launch/
driver recipe, and note T5 (re-enable smoke gate + process-tree-kill + auto-update, gated on Phase 5)
is next.

---

## Open questions (resolve in the T4 plan)

- Exact `reset()` teardown order (kill PTYs before or after clearing boards, to avoid a park/adopt
  race) — settle against `deleteBoard`'s existing park path during the plan.
- Whether `_electron.launch` needs an explicit `cwd` / args quoting beyond `executablePath` on the
  spaced path — verify empirically in the first plan step.
- `electronApp.evaluate` serialization limits for the capture verdict (return a byteLength/boolean,
  never the raw PNG buffer across the boundary).
</content>
</invoke>

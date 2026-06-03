# Testing — Canvas ADE

How we test. This is the source of truth for **which tier a test belongs to** and **where it lives**.
Backed by `docs/research/2026-06-03-testing-strategy.md` and the roadmap in
`docs/superpowers/specs/2026-06-03-testing-strategy-design.md`.

## Model — the Testing Trophy

We follow Kent C. Dodds' Testing Trophy: **mostly integration**, a solid unit base, a **thin** e2e
top, on a static base (TypeScript strict + ESLint). Not the unit-heavy pyramid. Ratios are
directional (~integration-heavy), never a quota.

## The three tiers (+ static)

| Tier | What it is | Runs in | Naming |
|---|---|---|---|
| **Static** | `tsc --noEmit` + ESLint | CI `check` | — |
| **Unit** | One pure function / module in isolation; collaborators mocked. No DOM render, no app, no real IPC. | Vitest `unit` project | `*.test.ts` / `*.test.tsx` |
| **Integration** | Multiple real units together: a rendered component tree (jsdom), a registered IPC handler, or logic that mocks `electron`. No real app boot. | Vitest `integration` project | `*.integration.test.ts` / `*.integration.test.tsx` |
| **E2E** | The real, booted app. The ONLY tier allowed to touch the native layer. | Playwright `_electron` (`pnpm test:e2e`) | separate harness |

## The decision rule — which tier do I write?

Ask, in order:

1. **Can I prove it by calling a function with inputs and asserting outputs, with collaborators
   mocked?** → **unit** (`*.test.ts`). Most logic lives here: pure helpers, store reducers, layout
   math, parsers, schema (de)serialize.
2. **Does it render a component tree (jsdom), wire several real units together, register an IPC
   handler, or need `electron` mocked?** → **integration** (`*.integration.test.ts(x)`). Component
   render tests count as integration (they exercise a real tree).
3. **Does it only reproduce in the real, booted app** — native `WebContentsView`, a node-pty
   spawn→echo roundtrip, OS process-tree kill, auto-update, or genuine cross-platform/OS behavior?
   → **e2e**. Keep this tier thin (see below).

If a behavior is provable at a lower tier, write it there — duplicating it as e2e is redundant
(slower, flakier) and is not allowed.

## What each tier MAY touch

- **Unit:** pure code + mocked collaborators. No `electron`, no DOM render, no fs (use temp/mocks).
- **Integration:** real units + jsdom render + `electron`/IPC mocked (`electron-mock-ipc` or a fake
  `ipcMain` that captures handlers). **Never boots the app.**
- **E2E:** the real instance. **MAIN-process helpers only** — Playwright's renderer-side IPC helpers
  require `contextIsolation:false` + `nodeIntegration:true`, which **violates our locked sandbox**.
  Never weaken the security model to make a test pass.

## E2E keep-set (thin top)

E2E is reserved for surfaces that ONLY reproduce in the real app:
**core happy-path boot · node-pty/terminal · native `WebContentsView` (browser preview, full view) ·
auto-update · OS process-tree kill / cross-platform.** Everything else pushes down to
integration/unit. (Roadmap T3 migrates the redundant probes down; T4 moves the keep-set onto
Playwright; T5 re-enables it as a gate.)

## Security boundaries → tier map

Electron's security checklist is asserted at the **unit/integration** tier, not via broad e2e:

| Checklist item | Where asserted |
|---|---|
| #3 context isolation / #4 sandbox | unit — `src/main/windowSecurity.test.ts` (`buildMainWindowWebPreferences`) |
| #13 navigation limits / #14 new-window | unit — `windowSecurity.test.ts` (`navDecision` / `windowOpenDecision`) |
| #17 validate IPC sender / #20 no Electron APIs to untrusted content (Browser↛PTY) | integration — `pty.integration.test.ts`, `preview.integration.test.ts`, `projectIpc.integration.test.ts` |

## Running

- `pnpm test` — both projects (the CI `check` gate).
- `pnpm test:unit` — fast unit project only (use while iterating).
- `pnpm test:integration` — integration project only.
- `pnpm test:e2e` — Playwright `_electron` e2e (built app; separate from the Vitest `check` gate).
- `pnpm typecheck` · `pnpm lint` — the static tier.

## Adding a test

1. Apply the decision rule → pick the tier.
2. Name the file for its tier (`*.test.ts` vs `*.integration.test.ts`) and colocate it with the code.
3. `.ts` runs in node, `.tsx` in jsdom (handled by `environmentMatchGlobs`) — pick the extension to
   match what the test needs.

## MAIN IPC integration — the harness

MAIN-process IPC handlers are integration-tested **without booting Electron** via
`src/main/ipcTestHarness.ts`. It captures the channels a `register*Handlers(ipcMain, …)` call
registers, so a test invokes a handler directly with a chosen sender:

- `createIpcCapture()` → `{ ipcMain, handlers, invoke, invokeAs }`. Pass `cap.ipcMain` to the
  production `register*Handlers`; then `cap.invoke('channel', …args)` calls the handler as a trusted
  internal caller, and `cap.invokeAs(foreignEvent, 'channel', …args)` calls it as a given sender.
- Sender fixtures: `internalEvent` (no `senderFrame` → trusted), `foreignEvent` (a non-main frame →
  must be rejected, checklist #17/#20), `mainWin` (a `getWin` resolving to the trusted main frame).

Reference template: `src/main/projectIpc.integration.test.ts` (happy-path handlers with `vi.mock`
collaborators + foreign-sender rejection). Copy its shape for new MAIN-IPC integration tests.

The renderer-facing preload bridge is contract-tested in `src/preload/preloadApi.integration.test.ts`:
every `api.*` method is asserted to invoke the right `ipcRenderer.invoke` channel with the right args.

## E2E push-down (T3) — what migrated, what stayed

T3 moved redundant `CANVAS_SMOKE=e2e` probe coverage down to Vitest and deleted the migrated
probes. The homegrown harness was trimmed to only the irreducible native/real-instance **slivers**,
which T4 ported to the Playwright `_electron` keep-set (the `CANVAS_SMOKE` harness has since been
deleted):

- **Migrated to Vitest:** whiteboard interactions (erase/shortcut/marquee/multidrag/shift-add/snap/
  alt-dup/lock/group/align/group-align → `PlanningBoard.interaction.test.tsx`); board-menu contracts
  (items/dup+delete/stroke-width → `BoardMenu.integration.test.tsx`); tidy span + planning checklist/
  round-trip (→ `canvasStore.test.ts`); preview-edge stale styling (→ `PreviewEdge.test.tsx`). The
  paste reload/dedup/gc + SVG/image-embed parts were already covered by `projectStore.test.ts` +
  `whiteboardExport.test.ts`, and `duplicate-keeps-link` by `canvasStore.test.ts`.
- **Ported to Playwright keep-set (T4):** `whiteboardFullviewAdd` (real OS click through the live
  camera transform), `whiteboardPasteImage` (real Ctrl+V clipboard), `whiteboardExport` (PNG raster),
  `menuChrome` (real title-bar layout + viewport clamp + CSS-var rest colour), `menuPreviewDetach`
  (native `WebContentsView` detach), `previewConnectGesture` (live port-detect IPC + long-press).
  These need real OS input, a native view, or the renderer's raster pipeline — jsdom can't reproduce
  them. The `planning`/`layout` probes were deleted outright; `whiteboardFullviewAdd` now seeds the
  shared `ctx.ids.planId` the slivers read (the deleted `planning` probe used to).

## E2E — Playwright `_electron` (T4)

The e2e tier is `@playwright/test` `_electron`, driving the BUILT app (`out/main/index.js`).
Run with `pnpm test:e2e` (the `pretest:e2e` hook builds first). It is **separate** from the
Vitest `check` gate (`pnpm test` stays unit + integration only). Re-enabling it as a CI gate is
**T5**.

**Boot mode:** launched with `CANVAS_E2E=1`, which loads the renderer with `?e2e=1` (installs the
`window.__canvasE2E` hook) and installs the MAIN-side `globalThis.__canvasE2EMain` registry, WITHOUT
self-running or auto-quitting — Playwright drives and closes the app.

**Two seams (both env-gated, test-only — the sandbox is NEVER weakened):**
- `window.__canvasE2E` (renderer) — driven via `page.evaluate`. Seeds boards through the real store,
  reads board/runtime/terminal state, and `reset()`s the canvas between tests.
- `globalThis.__canvasE2EMain` (MAIN, `src/main/e2eMain.ts`) — driven via `electronApp.evaluate`.
  Exposes the preview/pty internals the renderer can't see (`captureView`, `terminalPid`, view ids),
  real OS input (`sendInput`), and the project/clipboard helpers the whiteboard slivers need.

**Layout:** `e2e/fixtures.ts` (per-spec Electron launch + `reset()` `beforeEach`), `e2e/helpers.ts`
(`evalIn`/`mainCall`/`pollEval`/`seed`), and one spec per subsystem: `terminal` · `browser` ·
`fullview` · `menu` · `previewLink` · `whiteboard` (20 tests total). Each test seeds its own boards
— no shared ordered state.

**MAIN-helpers only:** Playwright's renderer-side IPC helpers require `contextIsolation:false` +
`nodeIntegration:true`, which violates the locked sandbox. We use `electronApp.evaluate` + the MAIN
registry exclusively. Never flip the sandbox to make a test pass.

**CI gate (T5):** the Playwright suite is wired back as a CI gate — the `smoke` job runs
`pnpm test:e2e` on a **windows-latest + ubuntu-latest** matrix in `pr.yml` + `staging.yml`
(`needs: check`, separate from the Vitest gate). Linux runs under `xvfb-run -a` with CI-gated
`--no-sandbox` + `--disable-dev-shm-usage` on the test launch only (the spike proved capturePage is
non-blank on both runners — **no GL flag needed**; the app sandbox is untouched). Flake policy:
`retries: 2` on CI, `workers: 1`. Process-tree-kill is covered by `killTreeCommand` (unit, both
platforms — Windows `taskkill /T /F`, POSIX negative-pgid) + `e2e/processTree.e2e.ts` (a real spawned
child prints its pid; the probe asserts that exact pid is reaped after `deleteBoard` + `disposeAllPtys`,
robust against OS pid reuse). *Verification: both legs are proven green + stable post-fix — Windows on
the dev machine (21/21) and the ubuntu-latest leg green ×2 consecutive locally via Docker
(`Dockerfile.e2e`, see below). The GitHub Actions `smoke` job is wired and will run automatically once
Actions billing is restored (paused 2026-06-03); the matrix itself already caught + verified-fixed a
Windows-only `RangeError`/pid-reuse bug.*

### Local Linux e2e without GitHub Actions (`Dockerfile.e2e`)

The ubuntu-latest leg can be reproduced locally — no Actions minutes — with the repo's `Dockerfile.e2e`
(a `node:22-bookworm` image: Xvfb + `xauth` + the Electron shared libs; `pnpm install` rebuilds node-pty
for the Electron ABI). Run:

```bash
docker build -f Dockerfile.e2e -t canvas-e2e-linux .
docker run --rm -t canvas-e2e-linux        # CMD = xvfb-run -a pnpm test:e2e (CI=1 → --no-sandbox)
```

**Gotcha:** use `docker run -t` (allocate a TTY). Without it the Playwright reporter block-buffers on a
non-TTY pipe and the run *looks* hung with zero output. `-t` line-buffers and the per-test output streams.

**Still owed (deferred to Phase 5):** an **auto-update** e2e — electron-updater / packaging / signing
don't exist yet, so the update flow can't be e2e-tested. It is the one remaining e2e-only surface.

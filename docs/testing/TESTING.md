# Testing — Canvas ADE

How we test. This is the source of truth for **which tier a test belongs to** and **where it lives**.
The why/history of how the suite got here (T0–T5) is compiled in
`docs/archive/2026-06-03-testing-strategy-initiative.md` (per-phase specs/plans/research were collapsed
there; originals in git history).

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
integration/unit.

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

## Testing requirements by feature area

Apply the decision rule per change, but each area has a **default tier** for its logic and a small set
of **mandatory e2e slivers** (real-instance surfaces that only reproduce in the booted app). When you
build in an area, cover the logic at the stated tier and keep its e2e sliver green; only add a NEW e2e
test when you introduce a genuinely new native/real-instance surface (see "E2E keep-set").

| Area | Logic tier (most coverage) | Mandatory e2e slivers (real instance) |
|---|---|---|
| **Terminal board** (node-pty/ConPTY) | unit — state machine, output parse, `killTreeCommand`, ring buffer, shell resolve | spawn→echo · full-view relocate (same pid) · LOD survives · config respawn · park+adopt on undo · **process-tree kill (no orphan)** |
| **Browser board / preview** (`WebContentsView`) | unit — `cameraBounds`/`canvasView` bounds+scale math, `portDetect`, `previewEdges` | native attach + non-blank capturePage · gesture detach/reattach · focus detach · dead-URL load-failed · port-detect→connect gesture · drag-to-create board (real drag through the camera) · click-spawn default · Esc cancel (e2e/placement.e2e.ts) |
| **Full view** (native rebind) | unit — fit math; jsdom — Planning camera-fit | webContents survives (no restart) · self-preserve · letterboxed emulator · chrome-less Esc-close |
| **Planning / whiteboard** (notes/arrows/pen/checklist; shapes·mermaid = in-flight research, not shipped) | **integration (jsdom)** — render the real `PlanningBoard`; unit for pure geometry (snapping/tools/layout) | only the transform/real-OS-input slivers: full-view add-note (real click through live camera) · real Ctrl+V paste · PNG export raster. New shapes/mermaid → cover in jsdom; add an e2e ONLY if it needs real OS input or the native raster pipeline. |
| **Persistence / migrations** (`canvas.json`, schema) | unit — `boardSchema` (de)serialize, migration pipeline, atomic-write contract, scene/session split | none (no native surface) — never e2e what a schema round-trip proves |
| **MAIN / IPC & security** (`index.ts`, pty/preview/projectIpc, `localServer.ts`) | **integration** via `ipcTestHarness` (no app boot) + unit `windowSecurity` | none — assert the Electron security checklist at unit/integration (see Security map). Foreign-sender rejection is REQUIRED for every new guarded handler. |
| **MCP swarm layer** (`@expanse-ade/mcp`, hosted in MAIN) | unit — orchestrator lifecycle/dispatch logic (`mcpOrchestrator` · `dispatchGuard` · `auditLog` · `ptyOutput` · `boardStatus` · `orchestrationEdges` · `resolveConnectTarget` · `useMcpCommands`); integration — IPC registration + **foreign-sender rejection** (`auditIpc` · `mcpConfirm` · `mcpCommand` `.integration`) + viewer/modal render (`AuditLogViewer` · `ConfirmModal` `.integration`). The Host-header DNS-rebind guard is tested in the sibling pkg repo. | `CANVAS_SMOKE=mcp` (`mcpSmoke.ts`) — the live tier-enforcement + real `handoff_prompt`→PTY smoke against the built app (two real loopback MCP clients, drives the confirm modal). The **one surviving `CANVAS_SMOKE` exception**; a Playwright `_electron` port (`e2e/mcp.e2e.ts`) is a tracked follow-up. |
| **Feature Workspaces / git worktrees** (deferred; `simple-git` in MAIN) | integration — worktree create/remove, dirty-on-delete prompt logic, `git init` opt-in/reuse/never-nest rules (mock `simple-git`) | one real-instance test of an actual worktree create→remove only if logic can't prove it. |
| **Context subsystem** (`.canvas/` memory, digest) | unit — digest build, memory read/write, serialization | none. |
| **Packaging / auto-update** (Phase 5) | — | **the one outstanding e2e-only surface**: an auto-update flow e2e once electron-updater/packaging/signing exist. Deferred until then. |

**Rules of thumb:** if a behavior is provable by calling a function (collaborators mocked) it is **unit**;
if it needs a rendered component tree, a registered IPC handler, or mocked `electron`, it is
**integration**; reserve **e2e** for the native layer (`WebContentsView`, node-pty roundtrip, OS
process-tree kill, real OS input through the live camera transform, auto-update). Duplicating a
lower-tier-provable behavior as e2e is not allowed.

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

> The T3 push-down and T4 Playwright migration history is compiled in
> `docs/archive/2026-06-03-testing-strategy-initiative.md`.

## E2E — Playwright `_electron`

The e2e tier is `@playwright/test` `_electron`, driving the BUILT app (`out/main/index.js`).
Run with `pnpm test:e2e` (the `pretest:e2e` hook builds first). It is **separate** from the
Vitest `check` gate (`pnpm test` stays unit + integration only). It runs as a local pre-push
gate (see below) rather than in GitHub Actions.

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
`fullview` · `menu` · `previewLink` · `processTree` · `whiteboard` (see `e2e/` for the current test count). Each test seeds its own boards
— no shared ordered state.

**MAIN-helpers only:** Playwright's renderer-side IPC helpers require `contextIsolation:false` +
`nodeIntegration:true`, which violates the locked sandbox. We use `electronApp.evaluate` + the MAIN
registry exclusively. Never flip the sandbox to make a test pass.

**The e2e gate (T5) — LOCAL pre-push, not GitHub Actions.** e2e was billing-blocked in Actions and
the native/Docker e2e is cheaper + faster on the dev box, so e2e runs as a **`pre-push` hook** that
executes the full **Windows-native + Linux-Docker matrix** (`.githooks/pre-push` →
`pnpm test:e2e:matrix`). It moved commit→push on 2026-06-06 so local commits stay fast — `git commit`
has no push-intent signal, so gating "work that reaches origin" belongs on push (the hook is
origin-only and skips docs-only pushes). The Actions `smoke` job was **removed** from `pr.yml` + `staging.yml`; the
Actions CI gate is now the `check` job only (typecheck · lint · format · unit + integration).
Process-tree-kill is covered by `killTreeCommand` (unit, both platforms — Windows `taskkill /T /F`,
POSIX negative-pgid) + `e2e/processTree.e2e.ts` (a real spawned child prints its pid; the probe asserts
that exact pid is reaped after `deleteBoard` + `disposeAllPtys`, robust against OS pid reuse). Both legs
proven green: Windows on the dev machine, the Linux leg ×2 via Docker. The spike confirmed
capturePage is non-blank on both with `--no-sandbox` + `--disable-dev-shm-usage` (Linux) — **no GL flag
needed**; the app sandbox is untouched.

### The git hooks + the local e2e matrix

Both hooks are enabled per-clone by the `package.json` `prepare` script (`git config core.hooksPath
.githooks`, run on install).

- **`.githooks/pre-commit` — cheap trio, every commit.** Runs `typecheck · lint · format:check`
  (~seconds; docs-only commits run `format:check` alone). Bypass a WIP commit with
  `git commit --no-verify`.
- **`.githooks/pre-push` — the e2e matrix, origin pushes only.** Runs the full matrix on `git push`
  to `origin`; skips non-origin remotes, no-op pushes, and docs-only pushes (the changed set is
  diffed across the pushed ref range). It checks Docker is up first (the Linux leg needs it) and sets
  `E2E_PRECOMMIT=1` so Playwright uses `retries:2` (the documented browser-trio env flake can't
  false-block a push). Bypass a WIP push with `git push --no-verify`.

Run the legs directly:

| Command | Leg | How |
|---|---|---|
| `pnpm test:e2e` | **Windows** | native (real ConPTY + WebContentsView on this OS) |
| `pnpm test:e2e:linux` | **Linux** | Docker (`Dockerfile.e2e`: `node:22-bookworm` + Xvfb + `xauth` + Electron libs; `pnpm install` rebuilds node-pty for the Electron ABI; `CI=1` → `--no-sandbox`) |
| `pnpm test:e2e:matrix` | **both** | the Windows leg then the Linux leg; both must pass (what the hook runs) |

The Docker image's CMD builds then runs `xvfb-run -a … --reporter=line` — the `line` reporter streams
without a TTY, so `docker run` works from a pnpm pipe. (The default `list` reporter does tty
cursor-control that blocks on a non-TTY stdout → the run looks hung with zero output; that's why the
container forces `line`.)

**Still owed (deferred to Phase 5):** an **auto-update** e2e — electron-updater / packaging / signing
don't exist yet, so the update flow can't be e2e-tested. It is the one remaining e2e-only surface.

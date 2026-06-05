# T9 — Electron 33 → 42 (EOL bump) Implementation Plan

> **Status: PREPARED, NOT EXECUTED.** This task CANNOT run in a junctioned worktree (it needs a token'd `pnpm install`, a node-pty native ABI rebuild, a full `electron-vite` build, and the Win+Linux e2e matrix). Execute it in a **provisioned checkout** — either CI with `NODE_AUTH_TOKEN`, or a local checkout where `pnpm install` resolves the private `@expanse-ade/mcp` GitHub-Packages dep. Do a **fresh worktree off `main`** (`fix/electron-bump`), AFTER the Wave 2 hardening PR (SCA) lands so the new `pnpm audit` step gates the result.

**Goal:** Get Electron off EOL (project is on 33; only 40/41/42 are supported as of June 2026, 39 and earlier are EOL) and clear the audit's CVE findings, without breaking the terminal (node-pty) or the native preview (`WebContentsView`).

**Target versions (June 2026):**
- `electron` `^33` → **`^42`** (latest stable, 42.3.x; support runway to ~Oct 2026; do NOT target 40 — it EOLs June 30 2026 — and 41 EOLs Aug 25). Confirm the exact latest 42.x at execution time.
- `vitest` `2.1.9` → **`^4.1.0`** (critical CVE GHSA — dev-server file read/exec; `@vitest/*` move in lockstep). This is a major vitest jump (2→4) — expect config/API changes; verify the whole unit suite still runs.
- `tar` highs (×7, transitive under `@electron/rebuild` > `@electron/node-gyp`) → bump **`@electron/rebuild`** to its latest (pulls tar ≥7.5.x), or add a pnpm `overrides` for `tar` `>=7.5.0` if the transitive isn't lifted.
- Re-check `electron-vite`, `electron-builder`, `electron-updater`, `@electron-toolkit/*` for Electron-42 compatibility and bump as needed.

**Risk ranking:** (1) **node-pty ABI** — highest; (2) vitest 2→4 — medium (test config); (3) Electron 33→42 main/renderer API breakage — medium; (4) build/packaging tool compat — low/medium.

---

## Pre-flight (provisioned env)
- [ ] Fresh worktree off **current `main`** (post-SCA-merge): `pwsh .claude/tools/new-worktree.ps1 -Name electron-bump -Branch fix/electron-bump -Base main`. **De-junction** its `node_modules` (this task needs a REAL install, not the shared junction): `cmd /c rmdir "Z:\canvas-ade-electron-bump\node_modules"` (remove the junction — do NOT `rm -rf` the target), then a real `pnpm install` below.
- [ ] Ensure `NODE_AUTH_TOKEN` (read:packages) is set so `@ch923dev:registry=https://npm.pkg.github.com` resolves. Verify: `pnpm install --frozen-lockfile` succeeds on the UNCHANGED tree first (baseline green) before any bump.
- [ ] Baseline: `pnpm typecheck && pnpm lint && pnpm test && pnpm build` green, and `pnpm test:e2e:matrix` green, on the unchanged tree — so any post-bump failure is attributable to the bump.

## Step 1 — vitest 2 → 4 first (isolate the test-runner change)
*Do this BEFORE Electron so a test failure isn't conflated with the Electron bump.*
- [ ] Bump `vitest` + `@vitest/*` (coverage/ui if present) to `^4.1.0`; `pnpm install`.
- [ ] Read the vitest 3 + 4 migration notes (config keys, `environment`, `deps.inline`→`server.deps`, jsdom setup, mock API). Apply config changes in `vitest.config.ts`.
- [ ] `pnpm test` — fix breakages. Target: the full **~1141+ unit+integration** suite green again. Commit `chore(test): vitest 2 → 4 (clear critical CVE)`.

## Step 2 — Electron 33 → 42
- [ ] Bump `electron` to `^42` (+ `@electron-toolkit/*`, `electron-vite`, `electron-builder`, `electron-updater` to Electron-42-compatible versions). `pnpm install`.
- [ ] **node-pty ABI rebuild (the critical step):** `pnpm rebuild` (= `electron-rebuild -w node-pty`). The repo pins `node-pty@1.2.0-beta.13` (winpty-free) SPECIFICALLY because the repo path `Z:\Canvas ADE` has a space and node-pty ≤1.1's winpty build (`GetCommitHash.bat`) hard-fails on spaced paths (see CLAUDE.md › Stack). Verify the beta still builds clean against Electron 42's ABI. If it FAILS:
  - First try a newer `node-pty` 1.2.x stable if one now exists that is winpty-free (check — the beta was a stopgap).
  - If node-pty can't build against Electron 42 ([node-pty #728](https://github.com/microsoft/node-pty/issues/728) tracks latest-Electron breakage), STOP and escalate — do NOT downgrade Electron back toward EOL, and do NOT relocate the repo without sign-off. This is the gating unknown.
  - Confirm `**/*.node` is still `asarUnpack`ed (electron-builder.yml) and node-pty stays in `dependencies` (not bundled by Vite).
- [ ] **Breaking-change sweep (33→42, 9 majors):** review the Electron breaking-changes docs for each major 34–42. Focus on the surfaces this app uses:
  - `WebContentsView` API (preview.ts) — bounds/zoom/`setBackgroundColor`/session/`webContents` lifecycle; the detach+snapshot + `setZoomFactor` flow.
  - `session` / `setPermissionRequestHandler` / `setWindowOpenHandler` / `will-navigate`/`will-frame-navigate` signatures (index.ts, windowSecurity.ts, preview.ts) — verify the T10/T11 guards still bind.
  - `app`/`BrowserWindow` lifecycle, `webPreferences` defaults, `nativeImage`/`capturePage` (LOD snapshots), `MessageChannelMain`/`postMessage` (the PTY MessagePort data plane), `contextBridge`.
  - Node version jump bundled with Electron 42 (check the matching Node major) — any Node API the MAIN process uses that changed/removed.
  - Deprecations surfaced as console warnings on boot (run the smoke).
- [ ] Smoke: `pnpm build` then `$env:CANVAS_SMOKE='exit'; pnpm start` (expect `SELFTEST_DONE`/`RENDERER_SMOKE`); and `$env:CANVAS_SMOKE='mcp'; pnpm start` (MCP tier) if the MCP dep is present.
- [ ] Commit `chore(runtime): Electron 33 → 42 (off EOL) + node-pty ABI rebuild`.

## Step 3 — supply-chain tail
- [ ] Bump `@electron/rebuild` (clears the tar ×7 highs) or add pnpm `overrides: { tar: '>=7.5.0' }`. `pnpm install`, re-rebuild node-pty, re-smoke.
- [ ] Run `pnpm audit --audit-level=high` — target a CLEAN result (0 high/critical). Commit.
- [ ] **Flip the SCA gate to hard** (the `TODO(T9)` from the Wave-2 hardening PR): in `.github/workflows/pr.yml`, remove `continue-on-error: true` + `|| true` from the audit step so it now blocks. Commit `ci(security): make pnpm audit a hard gate (tree clean post-Electron-42)`.

## Step 4 — full verification (the whole point of T9)
- [ ] `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build` — all green.
- [ ] **`pnpm test:e2e:matrix`** (Win-native + Linux-Docker) — green. This is mandatory: it's the only thing that proves the terminal (real PTY spawn + tree-kill), the native preview (`WebContentsView` bounds/zoom/detach), and boot actually still work on the new Electron. The `browser`/`browser-gesture`/`focus-detach` trio is a known env flake (memory `e2e-browser-trio-flake`) — rerun for clean, not a regression.
- [ ] Manual: launch the packaged build (`pnpm pack:dir`), open a terminal board (PTY spawns + agent launchCommand), open a browser board (preview loads + reflows), confirm the file:// nav pin (T10) didn't break the packaged app's own reload (Wave 0 recovery button → `location.reload()` must still work — it does per the pin's pathname compare, but verify on the real packaged file:// load).

## Step 5 — finish
- [ ] PR `fix/electron-bump` → `main`. After merge, re-run the full gate + e2e (sequential-merge rule). Tear down the worktree.
- [ ] Update CLAUDE.md › Stack (the `electron 33` + node-pty pinning notes) and the `electron-builder.yml` Phase-5 notes if anything changed.

## If blocked
- node-pty won't build on Electron 42 → escalate (don't downgrade toward EOL; don't relocate the spaced repo without sign-off). Options to research: a maintained node-pty fork with prebuilt Electron-42 binaries, or `@homebridge/node-pty-prebuilt-multiarch`, weighed against the winpty-free/spaced-path constraint.
- vitest 4 breaks a swathe of tests beyond config → consider a separate dedicated PR for the vitest jump before the Electron bump.

## Notes
- Pairs naturally with **Phase 5 (packaging/signing)** — the audit grouped them. Doing the Electron bump here de-risks Phase 5; signing/notarize + the electron-updater feed remain Phase 5.
- Sources: [endoflife.date/electron](https://endoflife.date/electron) (40/41/42 supported, 39- EOL, June 2026) · [node-pty #728](https://github.com/microsoft/node-pty/issues/728) (latest-Electron ABI breakage) · audit `docs/reviews/2026-06-04-main-branch-full-audit.md` (`electron-33-eol-no-security-backports`).

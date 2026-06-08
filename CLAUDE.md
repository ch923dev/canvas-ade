# CLAUDE.md — Canvas ADE

Guidance for any agent/session working in this repo. Keep it current as decisions land.

## What this is

An infinite, zoomable desktop canvas (Figma/tldraw-style) for AI-assisted development.
Each item is a resizable **board**. A **project = one canvas**. Board types:

- **Terminal** — a live CLI coding agent (any agentic CLI) running in a real shell.
- **Browser** — a responsive preview of the user's running localhost app in a device frame.
- **Planning** — whiteboard: notes, arrows, text, freehand, **and checklists** (interactive task cards).
- **Checklist** — NOT a separate board type. A first-class **element inside a Planning board** (toggleable
  items + progress bar), alongside notes/arrows/text/pen. (Decided 2026-05-29; was previously framed as its
  own type — see `docs/archive/build-history.md` › Phase 2.)

## Authoritative design reference

`design-reference/` is the AUTHORITATIVE UX/visual contract (exported from Claude Design).
- `design-reference/project/DESIGN.md` — the implementation contract (tokens, board chrome).
- `design-reference/project/*.jsx` — the visual prototype (recreate the look, not the code).
- `design-reference/chats/chat1.md` — design intent + the checklist/duplicate/full-view additions.

**On conflict: the design wins on UX; this brief/architecture wins on the stack.** Calm/dense
Linear-Raycast feel. One accent (blue `#4f8cff`), functional only. No glassmorphism/gradients/glow.

## Stack (locked)

- **Electron 42** + **TypeScript** + **React 18**; **electron-vite 5** / **vite 7** (dev/build), **electron-builder 26** + **electron-updater** (package/update). (Bumped 33→42 off EOL in T9; toolchain went vite 5→7 / electron-vite 2→5 / vitest 2→4 to clear a critical vitest CVE.)
- **Canvas engine: `@xyflow/react` (React Flow) v12** — NOT tldraw (see ADR 0001). Each board = a custom React Flow node.
- **Whiteboard: custom** — vendored `perfect-freehand` (pen) + React Flow edges/bezier for arrows. NOT Excalidraw (see ADR 0001).
- **Terminal: `@xterm/xterm` ≥5.5** (+ fit + webgl addons) ⇄ **`node-pty`** in MAIN.
- **`node-pty` 1.2.0-beta.13** (pinned) — winpty-free / ConPTY-only. REQUIRED: the repo path `Z:\Canvas ADE` has a space, and node-pty ≤1.1 bundles winpty whose build (`GetCommitHash.bat`) hard-fails on spaced paths. The beta drops winpty and builds clean. Do not downgrade without relocating the repo to a space-free path. **Build prereq (Windows, since Electron 42):** the Electron-42 ABI has no node-pty prebuilt, so node-pty SOURCE-compiles, and its `binding.gyp` sets `SpectreMitigation: 'Spectre'` → the build needs the **MSVC x64/x86 Spectre-mitigated libs** VS component installed (we keep the hardening rather than patch it off). Linux/macOS unaffected.
- **Preview: Electron `WebContentsView`** (NOT iframe/webview). Multiple views, synced to the camera by a PreviewManager.
- **State: Zustand** (app/ephemeral). **Persistence: JSON per project** (see below).
- **Git: `simple-git`** in MAIN for per-agent worktrees. **`write-file-atomic`** for saves.

## Architecture

### Process model & security (never weaken)
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, thin `preload` + `contextBridge`.
- `node-pty` runs ONLY in MAIN. Renderer never touches Node/native.
- External links → `shell.openExternal` via `setWindowOpenHandler` (deny in-app nav).
- Treat all terminal/launchCommand input as trusted-user-only; Browser-board content must never reach the PTY write channel.

### Terminal bridge
- **Data plane = MessagePort** (`MessageChannelMain`): main transfers a port to the renderer via `webContents.postMessage('pty:port', {id}, [port2])`. Preload re-posts it into the main world with `window.postMessage(..., e.ports)` (MessagePorts can't cross `contextBridge`). Renderer reads `event.ports[0]`.
- **Control plane = IPC** (`ipcRenderer.invoke`): `pty:spawn`, `pty:kill` (+ resize/write over the port).
- **Spawn the SHELL, not the agent.** Shell is user-selectable (Win: pwsh>powershell>cmd; *nix: $SHELL then zsh>bash). If a `launchCommand` is set, write it as the first PTY line (`pty.write('claude\r')`) so the agent inherits PATH/profile/auth. `launchCommand` is free-text → any agentic CLI.
- **Kill the tree.** Agents spawn child processes: Windows `taskkill /PID <pid> /T /F`; *nix kill the negative pgid.

### Browser preview (the Phase 1 gate)
- A `WebContentsView` is a NATIVE OS layer: it paints ABOVE all HTML, cannot be clipped/rounded/rotated, has no z-index vs HTML, and has **no `destroy()`** — you MUST `view.webContents.close()` per removed board or leak a renderer.
- **Sync** each view's `setBounds()` + scale to React Flow's camera transform (`translate(x,y) scale(z)` on `.react-flow__viewport`) via a single rAF loop driven by `useOnViewportChange` — never from React re-renders. Coalesce to one IPC batch/frame, diff-skip no-ops.
- **Responsive trick:** hold the page at a fixed CSS width W∈{390,834,1280}; `fitScale = nodePx/W`; `setZoomFactor(fitScale*camZoom)` + `setBounds(width: W*fitScale*camZoom)` → true reflow at the breakpoint, scaled as a unit.
- **LOD / occlusion strategy (decided): detach + snapshot.** During pan/zoom and below ~40% zoom, detach the live view and show a `capturePage()` snapshot card; reattach exact bounds on `onMoveEnd`. Capture WHILE on-screen (capture→await→detach) or the snapshot is blank. **Cap ~4 live views**; close far/over-cap ones and recreate on demand.
- Build as real `WebContentsView` so CDP attach can be added later (deferred — do NOT build it now).
- **Occlusion is inherent (gate finding, ADR 0002):** a native view paints above ALL HTML → it covers other boards and any in-canvas chrome it overlaps. Mitigate: LOD/motion snapshots (HTML, clippable) carry most cases; keep app chrome in a bar OUTSIDE the canvas pane (views are bounded to the pane); Full view renders a Browser board via snapshot. **Per-board session** (`partition: preview-<id>`) is REQUIRED for independent zoom (responsive presets). The `setZoomFactor` floor (0.25) caps how far the desktop preset reflows at heavy zoom-out — pick board world-sizes that keep presets unclamped in the working-zoom band.

### Persistence
- Project = a user-chosen folder. Whole canvas = single `canvas.json` at root + `canvas.json.bak` (parse-fail fallback). Heavy blobs in `assets/` by path, not inlined.
- Atomic write (`write-file-atomic`), debounced autosave ~1s + sync flush on blur/`before-quit`. Root integer `schemaVersion` + migration pipeline.
- App config + recent-projects list live in `app.getPath('userData')`, NEVER in the project folder.
- **Scene/session split (whiteboard + boards):** only `{schemaVersion, viewport, boards}` is
  serialized (`boardSchema.toObject`). Ephemeral session state — selected tool/element, in-flight
  draft/erase, hover — stays in React/Zustand and is NEVER routed into `elements[]` or a board patch
  key (`PATCHABLE_KEYS`). Borrowed from Excalidraw's `cleanAppStateForExport` discipline.

### Git / worktrees — DEFERRED (re-scoped 2026-05-30)
Worktrees are **deferred to a post-MCP phase** under a better model: **Feature Workspaces** — a
worktree backs a *feature zone* (a cluster of boards: terminal + browser + planning), **not a single
board**. Gated on the `canvas-ade-mcp` swarm layer. See `docs/roadmap.md` › Deferred › Feature
Workspaces. What replaced the worktree-coupled "per-board ports" idea: runtime **port detection →
push to preview** (Slice C′, shipped — see `docs/archive/build-history.md` › Phase 3-C′).
Still-valid locked safety rules **for when it is built** (do not re-decide):
- `git init` is **opt-in**; reuse an existing repo; NEVER auto-init when nested inside a parent repo.
- On delete with a dirty worktree: **keep on disk + prompt** (commit/stash/discard/keep). Never
  silent `--force`. Always `git worktree remove`, never `rm -rf`.
- `simple-git` runs ONLY in MAIN, behind frame-guarded IPC; never weaken sandbox/isolation.

## Locked decisions

| Topic | Decision |
|---|---|
| Canvas engine | React Flow (MIT) — tldraw rejected (license key + watermark + ~$6k/yr). ADR 0001. |
| Whiteboard | Custom (vendored perfect-freehand + RF edges) — Excalidraw rejected on technical fit. ADR 0001. |
| Agentic CLI | Open / agent-agnostic; user-configurable `launchCommand`. |
| Shell | User-selectable per board; OS-aware default. |
| Tweaks panel | Cut entirely. Ship fixed default tokens (blue / dots / compact / soft). |
| Preview URL | Editable URL bar, persisted per board. |
| git init / worktrees | **Deferred** to the Feature Workspaces phase (post-MCP). When built: opt-in toggle; reuse-if-exists; never nest-init. |
| Dirty worktree on delete | Keep on disk + prompt (rule stands for the deferred Feature Workspaces phase). |
| Per-board ports | **Re-scoped** → runtime port **detection** (parse server-printed URL) + push-to-preview, NOT static assignment/injection. Slice C′. |
| Preview liveness | Detach + snapshot while moving/LOD; cap ~4 live. |
| Browser board scale | Scales WITH the camera (snapshot scales as a unit), not 1:1. Locked in 1-D. |
| Preview zoom isolation | One in-memory session per board (`partition: preview-<id>`) — Chromium zoom is per-host per-session, so a shared session syncs all presets. ADR 0002. |
| Checklist | A Planning **element** (card inside a Planning board), not a 4th board type / dock button. Decided 2026-05-29. |
| Phase 2 shape | Foundation 2.0 (sequential, 4 steps A–D) → then board types **in parallel** (Terminal · Browser · Planning+Checklist). `docs/archive/build-history.md`. |
| Build matrix | Full: win + mac + linux × x64/arm64 (CI). Local verify = Windows x64 only here. |
| Target | Single-user desktop (no multiplayer). |

## Repo structure

```
src/
  main/      index.ts (secure window + lifecycle) · pty.ts · preview.ts · localServer.ts · selfTest.ts
  preload/   index.ts (contextBridge + MessagePort forwarding) · index.d.ts
  renderer/  index.html · src/{main.tsx, App.tsx, index.css, env.d.ts} · src/smoke/*
design-reference/   authoritative design bundle (read-only)
docs/        README.md (map) · roadmap.md · feature-proposals.md · decisions/ (ADRs 0001-0002) ·
             reviews/ (all hunts+reviews; README index + newest = open backlog) · research/ ·
             archive/ (build-history.md + git pointers for collapsed per-slice/handoff docs)
.github/workflows/build.yml   6-target CI matrix (unsigned until Phase 5)
electron.vite.config.ts · electron-builder.yml · tsconfig.{json,node,preload,web}.json
```

## Commands

```
pnpm dev            # electron-vite dev (HMR)
pnpm build          # bundle main/preload/renderer → out/
pnpm typecheck      # tsc across node + preload + web
pnpm pack:dir       # build + electron-builder --dir → release/win-unpacked/
pnpm build:win|mac|linux
pnpm rebuild        # electron-rebuild -w node-pty (manual native rebuild)
# headless smoke: $env:CANVAS_SMOKE='exit'; pnpm start   (prints SELFTEST_DONE / RENDERER_SMOKE)
# board e2e smoke: pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start   (seeds each board, prints E2E_* / E2E_DONE, exits non-zero on fail) — FROZEN in CI, see Status
# HTML screenshot:  $env:CANVAS_SHOT='C:\tmp\canvas.png'; pnpm start  (renderer DOM only, NOT the native preview view)
```

## Conventions

- TypeScript strict; no unused locals/params. Renderer deps bundled by Vite; native/runtime deps stay in `dependencies` and are `asarUnpack`ed (`**/*.node`, node-pty).
- Keep boards small & isolated: shared chrome base + per-type content slot. One file = one clear purpose.
- Match the design tokens in `src/renderer/src/index.css` (mirror of DESIGN.md §2-4).
- Each phase ends runnable + committed.

### Parallel sessions (worktree coordination)
- **One session per worktree; never two sessions in the same dir.** Main = integration/merge only.
- Before editing, read the shared board `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (the
  SessionStart hook injects it automatically). **Stay in YOUR declared zone**; cross-zone edits → note
  them on the board first. Your edits are auto-logged so the next session sees what you touched.
- New/teardown worktrees via `.claude/tools/new-worktree.ps1` / `remove-worktree.ps1` (handles the
  node_modules junction + safe teardown). Cap ~4 live. Merge feat branches into main sequentially,
  re-running the full gate + e2e after EACH merge. (Native Agent Teams = broken on Windows; this is the
  Windows-safe substitute.)
- **Feature work lives on a worktree, not `main`. `main` is the stable version.** Anything scoped to a
  single feature / fix / refactor — its **docs (specs, plans, roadmaps, research) AND its
  implementation** — is created and committed on that work's `feat/*` (or `fix/*`) worktree branch, never
  directly on `main`. We ship different features per session, so `main` only ever carries
  already-integrated, stable work plus the durable contract (this file, ADRs). Only **durable
  cross-feature contract changes** (CLAUDE.md, ADRs, top-level `docs/roadmap.md` status) land on `main`
  directly. Promote a feature's docs/impl to `main` via the sequential merge above once the gate + e2e
  are green.

## Environment notes (this machine)

- Node 22.17, pnpm 9.15 (via corepack), git 2.54, Python 3.12.4, VS Build Tools 2022 (VC++ x64 **+ MSVC x64/x86 Spectre-mitigated libs** — required for the node-pty source build on Electron 42; see Stack). node-pty builds locally.
- `.npmrc` sets `node-linker=hoisted` so @electron/rebuild + electron-builder work with pnpm.
- **Repo path has a space** → node-pty MUST stay winpty-free (the beta). See Stack.

## Status

> **✅ E2E IS A LOCAL PRE-PUSH GATE (2026-06-03, T5; moved commit→push 2026-06-06).** The brittle
> `CANVAS_SMOKE=e2e` harness is gone (replaced by Playwright `_electron`, T4). **e2e does NOT run in
> GitHub Actions** — it was billing-blocked there, and the native/Docker e2e is cheaper + faster on
> the dev box. The full **Windows-native + Linux-Docker matrix** now runs **locally as a `pre-push`
> hook** (`.githooks/pre-push` → `pnpm test:e2e:matrix`, origin-only, skips docs-only pushes), NOT
> pre-commit: `git commit` carries no push-intent signal, so gating "work that reaches origin" is a
> push concern — local commits stay fast. **`pre-commit` is now the cheap trio only** (`typecheck ·
> lint · format:check`). Both enabled by the `prepare` script via `core.hooksPath`. Flake policy:
> `retries:2` under `E2E_PRECOMMIT`, `workers:1`. Bypass with `git commit --no-verify` (cheap gate) /
> `git push --no-verify` (e2e). **CI gate = the Actions `check` job only**
> (typecheck · lint · format:check · unit + integration); the `smoke` job was removed from `pr.yml`
> + `staging.yml`. This **supersedes** the 2026-06-03 freeze. Both legs proven green: Windows on the
> dev machine (21/21), the Linux leg ×2 via Docker (`Dockerfile.e2e`). The matrix already caught +
> verified-fixed a Windows-only `RangeError`/pid-reuse bug. One e2e-only surface still uncovered:
> **auto-update** (deferred to Phase 5 — needs packaging/electron-updater). See
> `docs/testing/TESTING.md`.

Durable contract is above. **Build history** (phases 0–5, per-slice specs/plans, phase handoffs)
is summarized in **`docs/archive/build-history.md`** (originals in git history). **Review/bug-hunt
history + the current open backlog** is in **`docs/reviews/`** (`README.md` = index; newest dated
file = open findings).

**Current state (2026-06-08):** `main` @ `51aae5c`. Since Phase 4: **MCP M0–M5 · Context subsystem ·
Whiteboard W1–W5 · Testing T0–T5 · Electron 33→42 (T9) · review Waves 0–5 hardening · the drag-to-create
+ dock-to-top redesign (#75) — all SHIPPED.** Landed since #75 (2026-06-06→08): **full terminal I/O**
(#81 `c9af28a`) · **preview camera-sync fixes** — native-view pan-freeze + digest-panel occlusion (#82
`1578ffe`) · **e2e evidence harness + masked-bug reset() fix** (#83 `01da101`) · **Named Board Groups
S0–S6** (#84 `ea221ad`, schema v6) · **bug-hunt 2026-06-07 — 42/42 confirmed fixed** (6 Med + 36 Low, #85
`aede88f`) · **browser quick-wins** auto-reconnect/push/open-external/screenshot (#86 `5a93a58`) ·
**text-font toolbar** for the free-text element (#87 `51aae5c`, **schema v7**) · **terminal-recap** —
flip a terminal board to an agent-CLI session recap (#89 `668a783`) · **Shift+Enter sends LF** (#90
`c670732`) · **Claude PR-review CI** inline-comments + triage (#88/#91). Gate green on this tree:
typecheck · lint (0 err, 3 fast-refresh warnings) · format · **1622 unit+integration / 130 files**.
Historical Phase-4 recap follows.
**Phases 0–4 SHIPPED on `main`** + layout presets (`14f77d7`, PR #13).
Phase 4 design pass = `abd7fa2` (PR #9). Post-Phase-4 fixes merged: PR #12 (`ed1d551`, 13 verified
bugs) · `94baab9` (4 open-medium) · `1a0c615` (7 round-2 review findings). The full-view preview-reset
fix landed (PR #14 / fullview-reset refactor — full-view DETACHes every board, never `close()`, so a
navigated page survives full-view exit; `evictLiveBoard` was deleted, closing the PREV-A resurrection
class). Testing T0–T5 landed (Playwright `_electron` + local Win-native/Linux-Docker pre-commit matrix;
see `docs/testing/TESTING.md`). Latest baseline: **679 unit + integration** green (48 files), lint
(0 errors) + typecheck clean; e2e local-matrix green (the `browser`/`browser-gesture`/`focus-detach`
trio is a known live-`WebContentsView` env flake, memory `e2e-browser-trio-flake` — rerun for clean,
not a regression).

**Context subsystem SHIPPED to `main` (2026-06-04, `4c321c2`, squash PR #39).** The desktop's LLM brain +
persistent `.canvas/` project memory (M-digest + M-brain + M-memory): instant per-board reopen digest
(Tier-1 heuristic, no key) upgraded to cached LLM prose on reopen (Tier-2, provider-agnostic, key in
`safeStorage`, per-day budget, ADR `0003-llm-egress.md`). New units `src/main/{llmService,llmIpc,llmConfig,
llmKeyStore,llmBudget,canvasMemory,memoryEngine,summaryLoop}.ts` + `digest.ts`/`DigestPanel`/`SettingsModal`.
Generated memory is untrusted passive context (never drives an action). Build log `docs/archive/2026-06-04-context-subsystem.md`.
**M-expose** (`canvas://memory` + `canvas://board/{id}/summary` MCP read resources — lets agents read the
memory) **SHIPPED** (T1.7, landed with MCP M0–M4; pkg 0.8.2/0.9.0 register the resources, `boardMemory.ts`
is injected into `startMcpServer`). Generated summaries are untrusted passive context — a consuming agent
can be prompt-injected by them (ADR `0003-llm-egress.md` › M-expose residual). Post-merge gate green (852
unit+integration; e2e matrix green on the identical pre-merge tree).

**MCP layer SHIPPED to `main` (2026-06-05/06).** The `feat/mcp-integration` work landed via **PR #43**
(`2100022`, M0–M4) + follow-ups: **M5** board-status event source + event-driven handoff await-idle
(#70 `3824afc`), **M5 app-adopt** `Orchestrator.subscribeStatus` (#73 `c440251`), M-expose write→read
proof (#74 `97d356a`). App pins **`@expanse-ade/mcp ^0.9.0`** — now on **public npmjs** (no token; was
GitHub-Packages `@ch923dev/canvas-ade-mcp`, migrated `63cf10c`). The swarm layer is done; **Feature
Workspaces is unblocked.** (The old "PR #32 re-port" was superseded by #43 — do not look for it.)

**In flight (open PRs — `main` is integration-only):**
- **PR #17 `chore/rebrand-expanse`** — Canvas ADE → **Expanse** rename (code + build IDs + docs).
  **Merges LAST** (2 cross-zone one-liners), memory `rebrand-expanse`.
- **5 dependabot bumps** (#76–80) — triaged 2026-06-08: **#76** @electron-toolkit/utils 3→4 · **#78**
  eslint 9→10 · **#79** @types/node 22→25 · **#80** write-file-atomic 5→8 are all **CI-green / mergeable**
  (78+79 dev-only; 76+80 runtime, covered by gate). **#77** react/react-dom/@types/react is **CI-RED
  (`check` fails)** — React major; **HOLD** (needs RF-v12/React-19 compat work, own slice).
- Research-only PRs: #72 (visual-spec Diagram) · #71 (orchestrator harness) · #29 (Maestri teardown) · #27 (demo-video playbook) · #25 (SaaS strategy).

**Round-3 in-depth review (2026-06-01)** — 6-dimension parallel subagent audit + adversarial verify:
**healthy, no Critical/High** (the prior-round High MBC-1 did not reproduce). All 12 residual
Low/Nit/Info findings **CLEARED** (`fix/round3-backlog` 9 + `fix/round3-lows-remainder` 3; PREV-A was
already fixed by PR #14). See `docs/reviews/2026-06-01-round3.md` (two Resolution banners). No open
findings; reviews are stale-clear — heavy new code (MCP/Context) has landed on branches since, so a
fresh hunt against the post-merge tree is warranted before release.

**Start here next:** Open candidates (see `docs/roadmap.md`): **Phase 5 — packaging/signing** (CI matrix
unsigned until Phase 5; the de-facto release blocker — Electron 42 bump already done in T9) · the post-MCP
**Feature Workspaces / worktrees** model (FW-1) — **now unblocked** (the `canvas-ade-mcp` swarm layer
shipped) · land **rebrand #17** (last) + triage **dependabot #76–80**. Deferred: **agentic session resume**
(roadmap note) · auto-update e2e coverage (Phase 5, needs packaging/electron-updater).


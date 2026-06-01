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

- **Electron 33** + **TypeScript** + **React 18**; **electron-vite** (dev/build), **electron-builder** + **electron-updater** (package/update).
- **Canvas engine: `@xyflow/react` (React Flow) v12** — NOT tldraw (see ADR 0001). Each board = a custom React Flow node.
- **Whiteboard: custom** — vendored `perfect-freehand` (pen) + React Flow edges/bezier for arrows. NOT Excalidraw (see ADR 0001).
- **Terminal: `@xterm/xterm` ≥5.5** (+ fit + webgl addons) ⇄ **`node-pty`** in MAIN.
- **`node-pty` 1.2.0-beta.13** (pinned) — winpty-free / ConPTY-only. REQUIRED: the repo path `Z:\Canvas ADE` has a space, and node-pty ≤1.1 bundles winpty whose build (`GetCommitHash.bat`) hard-fails on spaced paths. The beta drops winpty and builds clean. Do not downgrade without relocating the repo to a space-free path.
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
# board e2e smoke: pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start   (seeds each board, prints E2E_* / E2E_DONE, exits non-zero on fail)
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

- Node 22.17, pnpm 9.15 (via corepack), git 2.54, Python 3.12.4, VS Build Tools 2022 (VC++ x64). node-pty builds locally.
- `.npmrc` sets `node-linker=hoisted` so @electron/rebuild + electron-builder work with pnpm.
- **Repo path has a space** → node-pty MUST stay winpty-free (the beta). See Stack.

## Status

Durable contract is above. **Build history** (phases 0–5, per-slice specs/plans, phase handoffs)
is summarized in **`docs/archive/build-history.md`** (originals in git history). **Review/bug-hunt
history + the current open backlog** is in **`docs/reviews/`** (`README.md` = index; newest dated
file = open findings).

**Current state (2026-06-02):** **Phases 0–4 SHIPPED on `main`** + layout presets (`14f77d7`, PR #13).
Phase 4 design pass = `abd7fa2` (PR #9). Post-Phase-4 fixes merged: PR #12 (`ed1d551`, 13 verified
bugs) · `94baab9` (4 open-medium) · `1a0c615` (7 round-2 review findings + a doc/repo cleanup). Latest
baseline: **482 unit** green, lint + typecheck clean; e2e **25/25** (clean runs; the
`browser`/`browser-gesture`/`focus-detach` trio is a known live-`WebContentsView` env flake on a
contended host, memory `e2e-browser-trio-flake` — rerun for clean, not a regression).

**In flight (`fix/fullview-preview-reset`):** full-view no longer **restarts** Browser boards. Both
the full-viewed board (motion sub-branch) and every OTHER board now **detach** (snapshot + keep the
live `WebContentsView`) instead of `webContents.close()` — a close discarded the page, so on full-view
exit the board re-opened at `board.url` and snapped back from the user's navigated page to the root.
New e2e probes `fullview-preserve` + `fullview-self-preserve` (webContents-id survival) lock it.

**Round-3 in-depth review (2026-06-01)** — 6-dimension parallel subagent audit + adversarial verify:
**healthy, no Critical/High** (the prior-round High MBC-1 did not reproduce). 12 residual Low/Nit/Info
findings (preview resurrection/ghost, duplicate-while-focused dim, redo-wipe, terminal idle-flag,
degenerate-draw phantom undo, `cwd`/`'*'` hardening). Full backlog + fix lanes:
**`docs/reviews/2026-06-01-round3.md`**. None gate a release.

**Start here next:** Open candidates (see `docs/roadmap.md`): **Phase 5 — packaging/signing** (CI
matrix unsigned until Phase 5) · the **`canvas-ade-mcp` swarm layer** (planned MCP package, memory
`canvas-ade-mcp`) · the post-MCP **Feature Workspaces / worktrees** model (FW-1) · or burning down the
**Round-3 Low backlog** (`docs/reviews/2026-06-01-round3.md`, 4 file-disjoint lanes). Deferred:
**agentic session resume** (roadmap note) · Stage-2 Playwright `_electron` harness (the
`CANVAS_SMOKE=e2e` harness is the stand-in).


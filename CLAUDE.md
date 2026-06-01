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
  own type — see `docs/handoffs/phase-2.md`.)

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

### Git / worktrees — DEFERRED (re-scoped 2026-05-30)
Worktrees are **deferred to a post-MCP phase** under a better model: **Feature Workspaces** — a
worktree backs a *feature zone* (a cluster of boards: terminal + browser + planning), **not a single
board**. Gated on the `canvas-ade-mcp` swarm layer. See `docs/roadmap.md` › Deferred › Feature
Workspaces. What replaced the worktree-coupled "per-board ports" idea: runtime **port detection →
push to preview** (Slice C′, shipped/shipping — `docs/superpowers/specs/2026-05-30-port-detect-preview-design.md`).
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
| Phase 2 shape | Foundation 2.0 (sequential, 4 steps A–D) → then board types **in parallel** (Terminal · Browser · Planning+Checklist). `docs/handoffs/phase-2.md`. |
| Build matrix | Full: win + mac + linux × x64/arm64 (CI). Local verify = Windows x64 only here. |
| Target | Single-user desktop (no multiplayer). |

## Repo structure

```
src/
  main/      index.ts (secure window + lifecycle) · pty.ts · preview.ts · localServer.ts · selfTest.ts
  preload/   index.ts (contextBridge + MessagePort forwarding) · index.d.ts
  renderer/  index.html · src/{main.tsx, App.tsx, index.css, env.d.ts} · src/smoke/*
design-reference/   authoritative design bundle (read-only)
docs/        roadmap.md · feature-proposals.md · decisions/ (ADRs 0001-0002) · handoffs/ ·
             research/ · superpowers/{plans,specs}/ · archive/ (superseded Round-1 bug-hunt docs)
bug-hunt-findings/   Round-2 fix package (INDEX · FIX-REPORT · skipped-roadmap · findings/BUG-0NN.md)
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

## Environment notes (this machine)

- Node 22.17, pnpm 9.15 (via corepack), git 2.54, Python 3.12.4, VS Build Tools 2022 (VC++ x64). node-pty builds locally.
- `.npmrc` sets `node-linker=hoisted` so @electron/rebuild + electron-builder work with pnpm.
- **Repo path has a space** → node-pty MUST stay winpty-free (the beta). See Stack.

## Status

Durable contract is above. The full phase-by-phase build history (Phase 0 → Phase 2
follow-up) lives in **`docs/handoffs/status-archive.md`** to keep this file lean.

**Current state (2026-05-31):** **Phase 4 — Design pass & polish — 6/7 slices SHIPPED on branch
`phase-4-design-pass`** (off `main` `65a0160`; NOT pushed/merged). Done: 1 motion (§9 camera
cubic-bezier ease + reduced-motion gate, `lib/motion.ts`) · 2 token/chrome parity (§4 two-shadow,
§6 ring-only select) · 3 Geist fonts (variable woff2 bundled) · 4 states (welcome tokens, terminal
braille spinner) · 6 CSP (prod `script-src 'self'`, no unsafe-inline) · 7 code-split (React.lazy
boards, entry chunk 1,286→672 kB). **311 unit** green, lint + typecheck clean; full e2e gated each
slice. **Remaining: Slice 5 — full-view enter/exit MOTION** (deferred — most delicate; native
`WebContentsView` can't be CSS-animated). The §6.1 **top band is DESCOPED** (decided 2026-06-01):
no separate band — full-view enter/exit folds into the title-bar full-view toggle icon (which
becomes "Exit full view"), alongside Esc / scrim click. **Handoff:
`docs/handoffs/2026-05-31-phase-4-progress-handoff.md`** (read first); plan:
`docs/superpowers/plans/2026-05-31-phase-4-design-pass.md`. Known e2e env-flake: the
`browser`/`browser-gesture`/`focus-detach` live-`WebContentsView` trio (memory
`e2e-browser-trio-flake`) — environmental, not a regression.

**Phase 3 is SHIPPED on `main`** (`139bc69` — A persistence · B
board actions · C′ port-detect preview + the 2026-05-31 bug-fix batch). All Phase 3 branches are
merged + pruned (local + remote). Baseline at merge: **303 unit tests** green, e2e harness
**19/19 `ok:true`**, lint + typecheck clean. Phase 2 (Terminal · Browser · Planning+Checklist) and
Phase 3 both on `main`. Phase 4 entry handoff: `docs/handoffs/phase-4.md`. **Phase 3 Slice A — Persistence** built
on branch `phase-3-persistence` (273
tests green): projects = a folder + `canvas.json` (schema **v2**, adds persisted camera
`viewport`; real `migrate(1→2)`); atomic write + `.bak` rotation (`main/projectStore.ts`);
recent-projects MRU in userData (`main/recentProjects.ts`); frame-guarded project IPC
(`main/projectIpc.ts`) + `window.api.project`/`dialog` preload bridge; renderer-driven
debounced autosave (`store/useAutosave.ts`, flush on blur/quit); boot auto-reopens the last
project else a welcome screen; in-session project switch (flush → `disposeLiveResources`
[close previews + kill PTYs] → load); restored terminals are **idle** (no auto-spawn) and
default `cwd` to the project folder. Spec + plan: `docs/superpowers/{specs,plans}/2026-05-30-persistence*.md`.

**Phase 3 Slice B — Board actions** built on branch `phase-3-board-actions` (278 tests
green): **Full view** (live portal-relocation — the matching `BoardNode` `createPortal`s its
live subtree into the modal host so the PTY/xterm/native view survive, no remount; Browser's
native `WebContentsView` is re-bound to the portaled device-frame's live DOM rect while all
other views detach) · **Duplicate** (clone offset 36px, select copy, one undo step;
Browser→next viewport preset, planning elements deep-cloned with fresh ids) · shared **⋯ menu**
(Full view · Duplicate · Delete) in `BoardFrame`, threaded to all three board types via
`BoardActionsContext`. Spec + plan: `docs/superpowers/{specs,plans}/2026-05-30-board-actions*.md`.

Slice B also fixed a pre-existing native-view ghost: `preview.ts` now `setVisible(false)` on
detach so the drag detach→reattach toggle can't leave a frozen composited frame (Electron
#43961; #44652 is already fixed in our 33.4.11).

**Phase 3 Slice C′ — Port detect → push to preview** built on branch `phase-3-slice-c` (296 tests
green; full gate verified). Git worktrees were **re-scoped 2026-05-30** out of Phase 3 → deferred to
the post-MCP **Feature Workspaces** model (worktree backs a feature *zone* of boards, not a board;
roadmap Deferred + proposals FW-1). The slice that shipped instead: a Terminal **Preview** (globe)
button parses the dev-server URL from the PTY ring buffer (`main/portDetect.ts`, pure) over a
frame-guarded `terminal:detectPorts` IPC; `Canvas.pushPreview` resolves a target Browser
(follow-link → selected → sole → spawn-near, `lib/previewTarget.ts`) and sets its `url` +
`previewSourceId`; a React Flow **floating connector arrow** Terminal→preview is derived from that
field (`lib/previewEdges.ts` + `canvas/edges/PreviewEdge.tsx`, hidden anchors on BoardNode),
auto-reroutes + persists (no schema bump — optional `BrowserBoard.previewSourceId`), cleaned up on
delete/duplicate. Read-only (no Browser→PTY path). Spec + plan:
`docs/superpowers/{specs,plans}/2026-05-30-port-detect-preview*.md`. Known minor gap: no IPC
frame-guard unit test (pre-existing pattern — no `pty:*` handler has one).

**Start here next:** **Phase 4 — Design pass & polish.** Apply every DESIGN.md token/state/motion
(+ `prefers-reduced-motion`); load Geist fonts; harden CSP to nonce-based for the packaged build;
code-split the renderer. **Full cold-start context + a 6-group checklist + a DESIGN.md→code map are
in `docs/handoffs/phase-4.md` — read it first.** Known items folded into Phase 4: the `fit` camera
op snaps with no animation (should be 200ms, `AppChrome.tsx`); the full-view enter/exit animation
(deferred from Slice B; mind the native `WebContentsView` can't be CSS-animated). Deferred beyond
Phase 4: **agentic session resume** (roadmap note) · **Feature Workspaces / worktrees** (post-MCP;
FW-1) · Stage-2 Playwright `_electron` harness (the `CANVAS_SMOKE=e2e` harness is the stand-in).
Known e2e flakes (env/timing, not regressions): the `browser`/`browser-gesture`/`focus-detach`
live-`WebContentsView` parts — rerun on a clean `electron` process.


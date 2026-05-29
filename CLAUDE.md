# CLAUDE.md — Canvas ADE

Guidance for any agent/session working in this repo. Keep it current as decisions land.

## What this is

An infinite, zoomable desktop canvas (Figma/tldraw-style) for AI-assisted development.
Each item is a resizable **board**. A **project = one canvas**. Board types:

- **Terminal** — a live CLI coding agent (any agentic CLI) running in a real shell.
- **Browser** — a responsive preview of the user's running localhost app in a device frame.
- **Planning** — whiteboard: notes, arrows, text, freehand.
- **Checklist** — structured task list, Planning visual family, its own board type.

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

### Persistence
- Project = a user-chosen folder. Whole canvas = single `canvas.json` at root + `canvas.json.bak` (parse-fail fallback). Heavy blobs in `assets/` by path, not inlined.
- Atomic write (`write-file-atomic`), debounced autosave ~1s + sync flush on blur/`before-quit`. Root integer `schemaVersion` + migration pipeline.
- App config + recent-projects list live in `app.getPath('userData')`, NEVER in the project folder.

### Git / worktrees
- One worktree per Terminal board at `.canvas-ade/worktrees/<board-id>` on branch `canvas-ade/<board-id>` (`.canvas-ade/` is gitignored in the project).
- `git init` is **opt-in** (toggle on project create); reuse an existing repo; NEVER auto-init when nested inside a parent repo.
- On board delete with a dirty worktree: **keep on disk + prompt** (commit/stash/discard/keep). Never silent `--force`. Always `git worktree remove`, never `rm -rf`.
- Worktrees isolate files, NOT ports — assign per-board ports for localhost previews.

## Locked decisions

| Topic | Decision |
|---|---|
| Canvas engine | React Flow (MIT) — tldraw rejected (license key + watermark + ~$6k/yr). ADR 0001. |
| Whiteboard | Custom (vendored perfect-freehand + RF edges) — Excalidraw rejected on technical fit. ADR 0001. |
| Agentic CLI | Open / agent-agnostic; user-configurable `launchCommand`. |
| Shell | User-selectable per board; OS-aware default. |
| Tweaks panel | Cut entirely. Ship fixed default tokens (blue / dots / compact / soft). |
| Preview URL | Editable URL bar, persisted per board. |
| git init | Opt-in toggle; reuse-if-exists; never nest-init. |
| Dirty worktree on delete | Keep on disk + prompt. |
| Preview liveness | Detach + snapshot while moving/LOD; cap ~4 live. |
| Build matrix | Full: win + mac + linux × x64/arm64 (CI). Local verify = Windows x64 only here. |
| Target | Single-user desktop (no multiplayer). |

## Repo structure

```
src/
  main/      index.ts (secure window + lifecycle) · pty.ts · preview.ts · localServer.ts · selfTest.ts
  preload/   index.ts (contextBridge + MessagePort forwarding) · index.d.ts
  renderer/  index.html · src/{main.tsx, App.tsx, index.css, env.d.ts} · src/smoke/*
design-reference/   authoritative design bundle (read-only)
docs/        decisions/ (ADRs) · roadmap.md
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

- **Phase 0 — DONE.** Toolchain proven end-to-end: React Flow renders, xterm + webgl, node-pty (ConPTY) spawns a shell from MAIN over a MessagePort, WebContentsView loads localhost, electron-builder produces a runnable + native-unpacked Windows build (verified by running the packaged exe headless). See `docs/roadmap.md` for what's next.
- **Phase 1-A — DONE** (commit `8a96d2d`). Dev tooling wired: ESLint 9 flat (typescript-eslint v8 + react-hooks + react-refresh + config-prettier), Prettier 3, Vitest 2; CI `check` job runs lint + test + typecheck + build. Load-bearing pure module `src/renderer/src/lib/cameraBounds.ts` (`worldRectToScreen`/`roundRect`/`rectsEqual`) with 19 colocated tests. Diagnostics overlay (`src/renderer/src/spike/DiagOverlay.tsx`: frame-time/FPS/live-view/heap) wired into the canvas tab — dev-default-on, Ctrl/⌘+Shift+D toggle. All gates green incl. headless smoke.
- **Phase 1-B — DONE** (commit `ba6ee09`). One `WebContentsView` pinned to a node's known world rect (`PREVIEW_RECT 280,60,360,240`) via `worldRectToScreen` + `roundRect` + a once-per-layout `paneOffset` (NOT `getBoundingClientRect`). Dashed cutout in the node proves alignment; verified pixel-aligned at zoom 1.0 / 0.6 / 1.8 on Windows. Lives in `FlowSmoke.tsx` (`PreviewSync`, child of `<ReactFlow>`).
- **Phase 1-C — DONE** (commit `e844788`). Live camera tracking via a single rAF pump off `useOnViewportChange` (one coalesced `setBounds` IPC/frame, `rectsEqual` diff-skip, self-stops when still). Measured Windows/165Hz: fps pinned 165, frame ~6.1ms, heap flat ~10MB, no perceptible trailing/jank with the live view through hard pan/zoom.
- Next: **Phase 1 GATE** continues — steps **1-D…1-E** (see `docs/roadmap.md`). 1-D = detach + `capturePage` snapshot during motion / below ~40% zoom (capture→await→detach), reattach exact bounds on `onMoveEnd`; lock the scale model (board scales with camera vs 1:1). 1-E = multi-view PreviewManager + responsive reflow + cap-4 + leak check. Do not proceed past the gate if janky.
- **Start here next session:** `docs/handoffs/phase-1.md` (cold-start handoff; **1-D is the immediate next step**).

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
- **Phase 1-D — DONE** (commit `8f1b1bd`). Detach + `capturePage` snapshot carries motion/LOD: on `onMoveStart` capture (while attached) → set snapshot `<img>` inside the node → `preview:detach`; on `onMoveEnd` `preview:attach` at exact bounds (stays detached + snapshot below `LOD_ZOOM=0.4`). New main IPC `preview:capture/detach/attach` + an `attached` flag; preload `capturePreview/detachPreview/attachPreview`; `useNodesState` + `updateNodeData(snapshot)`, `nodesDraggable=false`. **Scale model LOCKED: board scales with the camera** (see Locked decisions). Verified Windows: no trailing card, snapshot never blank, LOD swaps across 40%.
- **Phase 1-E — DONE** (commit `40849ec`). `preview.ts` is now a keyed `Map<id, WebContentsView>` PreviewManager (id-scoped `open/setBoundsBatch/capture/detach/attach/close/closeAll`, `disposeAll`). Renderer drives N boards from ONE coalesced `setBounds` batch/frame, per-board detach+snapshot on motion, `MAX_LIVE=4` cap, LOD snapshot < 40%. Responsive reflow via tested `fitZoomFactor` (page held at W∈{390,834,1280}, `setZoomFactor=(nodeW/W)*camZoom`, clamped [0.25,5]; 24 tests total). **Per-board `partition: preview-<id>` isolates each view's zoom** (Chromium stores zoom per-host per-session; a shared session synced all presets). Controls live in a bar ABOVE the pane; snapshot kept as a fallback layer under the live view.
- **🚦 PHASE 1 GATE — PASSED** (Windows, 2026-05-29). Smooth (165fps), leak-free (open/close `electron.exe` 6→4→6, full close → 0), aligned, multi-view, reflow correct in the working-zoom band. Verdict + load-bearing decisions + known constraints in **`docs/decisions/0002-preview-gate.md`**. Known WebContentsView limits (inherent, mitigated): paints above ALL HTML → occludes boards/in-canvas chrome (mitigate: LOD/motion snapshots + chrome outside the canvas pane); zoom-factor floor 0.25 → desktop preset can't hit 1280 CSS px at heavy zoom-out (fine in working band, snapshot < 40%).
- **Phase 2 — IN PROGRESS** (started 2026-05-29). Researched + decomposed: **2.0 foundation = 4 sequential gated steps** (2.0-A tokens · 2.0-B store+schema · 2.0-C canvas+`BoardFrame`+`NodeResizer`+LOD · 2.0-D app chrome shell), then the board types **in parallel** (2.1 Terminal · 2.2 Browser · 2.3 Planning+Checklist). Full plan, salvage map, exact design specs, parallel-execution guidance, and deferred questions in **`docs/handoffs/phase-2.md`**.
  - **2.0-A — DONE.** `src/renderer/src/index.css` `:root` is now a faithful mirror of DESIGN.md §2-4. Token drift fixed (`--grid-dot #202022`, `--surface-overlay #1e1e22`, `--border-strong .16`, shadow alpha `.6`). Added: full type scale (`--fs/--lh/--fw/--tr-{micro,meta,label,body,term,h}` + `.t-*` helper classes), spacing base-4 (`--space-2…32`), radii (`--r-inner 6`, `--r-ctl 5`, `--r-pill 999`), elevation (`--shadow-board`, `--shadow-pop`), `--titlebar-h 34px`, and the `ca-*` keyframes (`ca-pulse`/`ca-progress(-bar)`/`ca-blink`/`ca-caret-run`) + `prefers-reduced-motion` opt-out. All gates green (format/lint/typecheck/24 tests/build/headless smoke).
  - **2.0-B — DONE.** Pure board-data schema `src/renderer/src/lib/boardSchema.ts` (`SCHEMA_VERSION=1`; `BoardCommon {id,type,x,y,w,h,title,z?}` + Terminal/Browser/Planning unions; Planning `elements` = note/text/arrow/stroke/checklist discriminated on `kind`; `MIN_BOARD_SIZE 240×160`, `DEFAULT_BOARD_SIZE` terminal 420×340 / browser 700×500 / planning 516×366; `createBoard` factory, `toObject`/`fromObject` round-trip via `structuredClone`, empty `migrate` pipeline that no-ops at v1 + throws on missing/newer version). Zustand store `src/renderer/src/store/canvasStore.ts` (boards/selectedId/tool + add/remove/update/resize-clamp/select/setTool + `toObject`/`loadObject` bridge; ids via `crypto.randomUUID`). 32 new tests (16 schema + 16 store), 56 total. File I/O stays Phase 3. All gates green.
  - **2.0-C — DONE.** Production canvas (`src/renderer/src/canvas/`): `Canvas.tsx` — a React Flow surface whose nodes are **derived from the store** (single source of truth); RF changes (drag/resize/select/remove) translate straight back into store mutations. Camera per DESIGN.md §5 (minZoom 0.1 / maxZoom 2.5, `panOnScroll` wheel-pan + Ctrl/⌘ `zoomActivationKeyCode` zoom-to-cursor, drag-empty-to-pan, `deleteKeyCode` Backspace/Delete). `FadingDots` background fades via tested `gridDotOpacity`. Shared `BoardFrame.tsx` (full chrome + LOD card; titlebar = drag handle `.board-titlebar`; resting/hover/selected states + `--accent-wash` titlebar; `IconBtn`/`StatusPill`) + `Icon.tsx`/`TypeGlyph.tsx` (ported from design-reference). `BoardNode.tsx` = RF custom node: reads zoom for LOD (`<LOD_ZOOM`), hosts restyled `NodeResizer` (8 handles via CSS, min 240×160, hidden in LOD), per-type placeholder content. New pure `lib/canvasView.ts` (`Z_MIN/Z_MAX/LOD_ZOOM/GRID_GAP`, `isLod`, `gridDotOpacity`) + 7 tests (63 total). **Visually verified** (window-capture): boards render in `BoardFrame`, selection ring + handles, LOD swap at <40%, fitView frames seed. **Camera note:** uses RF built-in pan/zoom (not the prototype's hand-rolled `exp` curve) — same UX, ADR stack.
  - **2.0-D — DONE.** App chrome shell (DESIGN.md §8). `AppChrome.tsx` = three floating islands: top-left project switcher (`◇ canvas-ade ▾ · N boards`, placeholder), top-right camera cluster (fit / − % + / overview via `useReactFlow`, live mono %), bottom-center dock (`select | + Terminal | + Browser | + Planning`; **no Checklist** — Planning element). `EmptyState.tsx` (watermark + heading + body + 3 dashed ghost buttons) shows at 0 boards. `Canvas.tsx` now owns: dock/ghost add → `addCentered` (centered + auto-select), dbl-click = **focus** (camera fit pad ~70 / 200ms + dim others .55 via node `data.dimmed` → `BoardFrame`), keys Esc(clear)/1(fit)/0(reset)/Ctrl⌘+Shift+D(diag), Backspace/Delete via RF. **`App.tsx` is now the full-bleed `<Canvas>`** — tab harness gone; `RENDERER_SMOKE` probe preserved in `smoke/useRendererSmoke.ts`. Smoke components (`FlowSmoke`/`TerminalSmoke`/`PreviewSmoke`) kept on disk as salvage sources, no longer rendered. **Visually verified** (window-capture): empty state at 0 boards; populated state shows chrome + board count + auto-selected board ring. **Deferred:** title inline-edit (dbl-click reserved for focus); real multi-project switcher; Full view (Phase 3).
- **Also this session:** hardened main against EPIPE when a truncated stdout pipe closes during smoke (`smokeLog` + stdout error guard; commit `8db13ea`).
- **🚩 2.0 FOUNDATION COMPLETE.** Shared surface is FROZEN for the parallel fork: `BoardFrame` props (`src/renderer/src/canvas/BoardFrame.tsx`), board-data schema + store (`lib/boardSchema.ts`, `store/canvasStore.ts`), and the preview/pty IPC contracts. Per the handoff: a shared-surface change must land on `main` first, then rebase the worktrees — don't edit `BoardFrame`/schema in parallel branches.
- **Start here next session:** `docs/handoffs/phase-2.md` → **fork the board types in PARALLEL** (separate worktrees/branches `phase2/terminal` · `phase2/browser` · `phase2/planning`): **2.1 Terminal** (xterm ⇄ pty over MessagePort, salvage `smoke/TerminalSmoke.tsx`; add `launchCommand`/shell-list/state channel to `pty.ts`), **2.2 Browser** (real board over `preview.ts` + extract the PreviewManager algorithm from `smoke/FlowSmoke.tsx`; viewport segmented control + device frame + URL bar + nav IPC), **2.3 Planning** (greenfield: vendor `perfect-freehand`; notes/text/arrows/pen + Checklist element; ÷zoom pen mapping unit-tested). Each replaces only the `BoardFrame` content slot for its type. Phase 1 handoff (`docs/handoffs/phase-1.md`) is complete.

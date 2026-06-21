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

- **Electron 42** + **TypeScript** + **React 19**; **electron-vite 5** / **vite 7** (dev/build), **electron-builder 26** + **electron-updater** (package/update). (Bumped 33→42 off EOL in T9; toolchain went vite 5→7 / electron-vite 2→5 / vitest 2→4 to clear a critical vitest CVE. React 18→19 in #194 — measured-low migration, only `useRef(null)`→`RefObject<T|null>` type fallout; scope in `docs/research/2026-06-20-react-19-migration-scope/`.)
- **Canvas engine: `@xyflow/react` (React Flow) v12** — NOT tldraw (see ADR 0001). Each board = a custom React Flow node.
- **Whiteboard: custom** — vendored `perfect-freehand` (pen) + React Flow edges/bezier for arrows. NOT Excalidraw (see ADR 0001).
- **Terminal: `@xterm/xterm` ≥5.5** (+ fit + webgl addons) ⇄ **`node-pty`** in MAIN.
- **`node-pty` 1.2.0-beta.13** (pinned) — winpty-free / ConPTY-only. REQUIRED: the repo path `Z:\Canvas ADE` has a space, and node-pty ≤1.1 bundles winpty whose build (`GetCommitHash.bat`) hard-fails on spaced paths. The beta drops winpty and builds clean. Do not downgrade without relocating the repo to a space-free path. **Build prereq (Windows, since Electron 42):** the Electron-42 ABI has no node-pty prebuilt, so node-pty SOURCE-compiles, and its `binding.gyp` sets `SpectreMitigation: 'Spectre'` → the build needs the **MSVC x64/x86 Spectre-mitigated libs** VS component installed (we keep the hardening rather than patch it off). Linux/macOS unaffected.
- **Preview: Electron offscreen rendering → DOM `<canvas>`** (OSR). Each Browser board's page renders in a hidden offscreen `BrowserWindow`; its frames stream to a clipping/z-ordering DOM `<canvas>` (occlusion-free — the ADR 0002 resolution). The legacy native `WebContentsView` engine + the `VITE_PREVIEW_OSR` escape-hatch flag were removed in OS-3 Phase 5C.
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

### Browser preview (OSR — offscreen → `<canvas>`)
The native `WebContentsView` engine was the Phase-1 gate; it shipped, then OS-3 productionized the
**offscreen-rendering (OSR)** engine and Phase 5C **deleted the native path entirely** (history:
ADR 0002 + `docs/archive/build-history.md` › OS-3). What remains:
- Each Browser board's page renders in a hidden **offscreen `BrowserWindow`** (`previewOsr.ts`,
  `partition: preview-<id>` per board for zoom isolation). MAIN streams BGRA frames (dirty-rect
  aware) over IPC; the renderer blits them into a DOM `<canvas>` inside `.bb-frame`. The canvas is
  a normal DOM node, so it **clips / rounds / z-orders** — the occlusion problem ADR 0002 found is
  gone (no detach/snapshot/chrome-exclusion machinery; popovers & chrome just paint over it).
- **No per-frame camera IPC:** the `<canvas>` moves with the DOM under React Flow's transform. Size
  is pushed only on a settle (`useOffscreenSizing` → one `preview:osrResize`): supersample
  `S = deviceFitScale × settledZoom × DPR` for crispness, logical width = the live preset
  (390/834/1280) for a true responsive reflow.
- **Liveness (`useOffscreenLiveness`, the M2 CPU win):** paint-gate off-screen / below-LOD boards
  (`stopPainting`, last frame stays frozen on the canvas) and cap **~4 live** offscreen windows
  (MAX_LIVE existence cap; evicted boards keep a frozen frame + a "paused" badge).
- **Input/widgets over the attached `wc.debugger` (CDP, MAIN-only):** a hidden composition-proxy
  `<textarea>` carries keyboard/IME/clipboard/AltGr; native `<select>`/dialogs/downloads/mute are
  re-rendered as HTML chrome in `.bb-frame` (they clip too). Lifecycle (load/fail/navigate/crash)
  is emitted on the shared `preview:event` channel.

### Persistence
- Project = a user-chosen folder. **All Canvas-ADE data is isolated under `<project>/.canvas/`** (ADR 0009): the whole canvas = `.canvas/canvas.json` + `.canvas/canvas.json.bak` (parse-fail fallback); heavy blobs in `.canvas/assets/` by path, not inlined; context memory in `.canvas/memory|audit|tmp/`. The stored `assetId` stays the logical `assets/<sha1>.<ext>` (only the resolution base moved → **no schema bump**). Reads prefer `.canvas/` and **fall back to the legacy project root**; `migrateProjectLayout` relocates a legacy-root project on open (one-way; older builds won't find a migrated project — accepted pre-release). `canvas.json` is git-trackable by default; `assets/`/backup/memory are ignored unless the commit opt-in is set (`canvasMemory.setCommitOptIn`). The File Tree hides `.canvas/`.
- Atomic write (`write-file-atomic`), debounced autosave ~1s + sync flush on blur/`before-quit`. Root integer `schemaVersion` + migration pipeline + `minReaderVersion` compat floor (two-tier versioning, ADR 0007: additive bumps stay openable by older apps; only breaking changes move the floor).
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
| Preview engine | **OSR** (offscreen → DOM `<canvas>`). Native `WebContentsView` engine + `VITE_PREVIEW_OSR` flag deleted in OS-3 5C. ADR 0002. |
| Preview liveness | Paint-gate off-screen/below-LOD (frozen last frame); MAX_LIVE existence cap ~4 offscreen windows. |
| Browser board scale | Scales WITH the camera (the `<canvas>` moves with the DOM transform), not 1:1. |
| Preview zoom isolation | One in-memory session per board (`partition: preview-<id>`) — Chromium zoom is per-host per-session, so a shared session would sync all presets. ADR 0002. |
| Schema versioning | Two-tier (ADR 0007): `schemaVersion` (writer) + `minReaderVersion` (compat floor). Additive optional fields bump the writer only; breaking changes (new kinds/types, new DOC-LEVEL keys) bump both. Older apps open any doc whose floor ≤ their version. |
| Project file layout | All Canvas data **isolated under `<project>/.canvas/`** (canvas.json + .bak + assets/); legacy-root read-fallback + migrate-on-open (one-way); `assetId` unchanged (location migration, **no schema bump**); assets git-ignored by default (commit opt-in); `.canvas/` hidden from the File Tree. ADR 0009. |
| Checklist | A Planning **element** (card inside a Planning board), not a 4th board type / dock button. Decided 2026-05-29. |
| Canvas backdrop | Per-project **screen-fixed** wallpaper layer behind RF (none / user file / bundled scene), dim+saturation, schema **v9** `background`, settings-class (never undoable). Scene ids registry-resolved at render (unknown ⇒ void+toast, preserved). ADR 0006. |
| Phase 2 shape | Foundation 2.0 (sequential, 4 steps A–D) → then board types **in parallel** (Terminal · Browser · Planning+Checklist). `docs/archive/build-history.md`. |
| Build matrix | Full: win + mac + linux × x64/arm64 (CI). Local verify = Windows x64 only here. |
| Target | Single-user desktop (no multiplayer). |

## Repo structure

```
src/
  main/      index.ts (secure window + lifecycle) · pty.ts · previewOsr.ts (+ previewOsrWidgets/Capture · previewShared · previewScreenshot) · localServer.ts · selfTest.ts
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
# manual PR check:  $env:CANVAS_DEV_TITLE='PR#NNN <feature>'; pnpm dev  (stamps the window title so you can tell WHICH PR's build you're inspecting — see Conventions › Manual dev check)
```

## Conventions

- TypeScript strict; no unused locals/params. Renderer deps bundled by Vite; native/runtime deps stay in `dependencies` and are `asarUnpack`ed (`**/*.node`, node-pty).
- Keep boards small & isolated: shared chrome base + per-type content slot. One file = one clear purpose.
- Match the design tokens in `src/renderer/src/index.css` (mirror of DESIGN.md §2-4).
- Each phase ends runnable + committed.
- **Doc lifecycle** (full policy: `docs/README.md` › Conventions): per-slice specs/plans/handoffs are
  DELETED in the PR that merges their feature (build-history line is the residue); bug-hunt/review
  packages land under `docs/reviews/<date>-…/` — **never at the repo root** — and collapse to a dated
  summary once all findings are fixed; indexes update in the same PR that adds/removes indexed files.

### Design artifact before code (spec/plan-driven UI work)
Any spec or plan that adds or changes **UI/UX** MUST produce a *visible* design artifact for sign-off
**before** implementation -- so the look can be checked and imagined first, not discovered after it is
built. Match the `design-reference/` tokens. Pick the lightest medium that conveys the intent:
- **Layout / flow** -> an ASCII or box wireframe inline in the spec (fast; good for structure + states).
- **Real UI (non-trivial)** -> a throwaway static HTML/JSX mock built with the actual tokens from
  `src/renderer/src/index.css`, rendered + screenshotted (the Playwright `_electron` harness can shoot
  it) so the user reviews pixels, not prose.
- **Comparing options** -> side-by-side wireframes in the brainstorm (the AskUserQuestion preview panel
  renders ASCII mockups for exactly this).
Get the user's nod on the artifact, THEN write the implementation plan. No UI design lands code-first.

### Manual dev check on every PR (title-stamped build)
Every PR MUST get a **manual dev check in a running app** before it is opened/merged — a green
typecheck/lint/unit run is NOT "verified working" (the black-screen-regression class of bug). Launch
the feature with `pnpm dev` and actually look at the change in the live app.
- **The dev build MUST carry a distinguishing window title** so you can tell *which* PR/build you are
  inspecting when several dev instances (or several feature checkouts) are open at once. Dev builds
  already auto-stamp the title with the checkout's worktree folder name (`<folder> — Canvas ADE
  [dev]`); set a per-PR stamp to make it unambiguous:
  ```
  $env:CANVAS_DEV_TITLE='PR#NNN <feature>'; pnpm dev
  ```
  `CANVAS_DEV_TITLE` wins over the folder default; packaged builds always keep the product title.
  (Implemented in `src/main/index.ts` › `createWindow` — the renderer `<title>` is prevented from
  overwriting the dev stamp.)
- Before signing off the check, **confirm the window title (taskbar / alt-tab) reads this PR's
  stamp** — that is your ground truth that you are testing *this* PR's code and not a stale instance.

### Responding to the Claude PR reviewer
- When you check the automated reviewer's inline comments on a PR, you **MUST reply inline on
  EACH reviewer inline comment** with its disposition — the **fix** made, the **refactor**, or a
  **general note** (e.g. "accepted as low", or "declined: <reason>"). Reply on the comment's own
  thread (`gh api -X POST repos/<owner>/<repo>/pulls/<n>/comments/<comment-id>/replies -f body=…`),
  not just in passing.
- A summary-only "Dispositions: …" comment is **not sufficient on its own**. The reviewer
  (`.github/workflows/claude-code-review.yml`) is disposition-aware: it **preserves** any inline
  thread a human replied to and **skips re-flagging** a finding once the author has dispositioned it.
  An inline reply is the signal that stops the re-flag-after-disposition loop (the PR #92 case); a
  bare summary risks the reviewer re-raising the same point on the next push.
- Post the summary disposition too if you like, but the **per-comment inline reply is the required
  one**. Never resolve by deleting the reviewer's comment.
- **Scope of the mandate (noise contract, 2026-06-13):** the reviewer posts inline comments only at
  `[critical]`/`[warning]` (max 5/review) — those all require inline replies as above. Items under
  the summary's "Nits (non-blocking — no reply needed)" heading require **no** reply or disposition
  (the reviewer will not re-raise them). Re-review rounds are **incremental** (delta since the last
  reviewed head SHA, zero new nits) — so do not end a trailing-trivia round with another push; an
  inline reply alone ends it.

### Parallel sessions (worktree coordination)
- **One session per worktree; never two sessions in the same dir.** Main = integration/merge only.
- Before editing, read the shared board `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (the
  SessionStart hook injects it automatically). **Stay in YOUR declared zone**; cross-zone edits → note
  them on the board first. Your edits are auto-logged so the next session sees what you touched.
- **Post-merge signaling + stale-base self-check.** After pushing to `origin/main`, run
  `pwsh .claude/tools/signal-merge.ps1 -Pr <n> -Subject "<subj>"` (`-Lockfile` if the lockfile moved) —
  it updates `integration-tip.json` + the board so every other session knows main advanced. In return,
  the coordination hook flags a stale base automatically: a banner at SessionStart, a per-prompt nudge,
  and a **hard pre-push block** on a stale push to `main` (feature pushes warn). On any of those:
  `git fetch origin && git rebase origin/main` before continuing. Full protocol: `ACTIVE-WORK.md` ›
  *Post-merge signaling*.
- New/teardown worktrees via `.claude/tools/new-worktree.ps1` / `remove-worktree.ps1` (handles the
  node_modules junction + safe teardown). Cap ~4 live. Merge feat branches into main sequentially,
  re-running the full gate + e2e after EACH merge — **the FULL e2e matrix (`pnpm test:e2e:matrix`,
  both legs) is mandatory here**: since the 2026-06-13 pre-push scoping, renderer-scoped pushes pay
  the Windows leg only, so the pre-merge gate is where cross-OS insurance is paid, exactly once per
  PR. (Native Agent Teams = broken on Windows; this is the Windows-safe substitute.)
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
> the dev box. The e2e gate runs **locally as a `pre-push` hook** (`.githooks/pre-push`,
> origin-only, skips docs-only pushes), NOT pre-commit: `git commit` carries no push-intent signal,
> so gating "work that reaches origin" is a push concern — local commits stay fast. **Scoped
> 2026-06-13 (dx-audit QW-4):** renderer-scoped pushes run the **Windows leg only**
> (`pnpm test:e2e`); the Linux Docker leg joins per-push only for cross-platform-sensitive diffs
> (`src/main|preload`, `e2e/`, build/test config — `LINUX_SENSITIVE` in the hook) or
> `E2E_FULL_MATRIX=1`; the **FULL matrix is mandatory once per PR at the pre-merge gate** (see
> Parallel sessions). **Spec-scoped 2026-06-14 (dx-audit MT-1):** a renderer-scoped Windows push is
> further narrowed by board area — e2e specs carry `@core/@terminal/@preview/@planning/@chrome` tags
> and `scripts/e2e-scope.mjs` maps the changed paths to a `--grep` subset, **failing open to the full
> suite** for any cross-cutting/unknown path (`docs/testing/TESTING.md` › E2E tags). **`pre-commit` is now the cheap trio only** (`typecheck ·
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

**Current state (milestone-level only — no SHA here):** Phases 0-4 + all board types, MCP M0-M5,
the Context subsystem, Whiteboard W1-W5, Testing T0-T5, the Electron 33->42 bump (T9), review
Waves 0-5, and the 2026-06-10 full-app audit fix run (#107, 72/72 findings) are all shipped on
`main`. **The release blocker is Phase 5 (packaging/signing).** Open candidates and "start here
next" live in `docs/roadmap.md`.

**Live state is deliberately NOT tracked in this file — including the current `main` SHA.** The
current integration tip, the per-PR landing log, and the in-flight worktree/PR queue all live in
`.claude/coordination/ACTIVE-WORK.md` (gitignored, injected into every session at start — the
single source of truth for what is in flight; its "Integration tip" line is the rebase target).
The committed, PR-by-PR record with SHAs is appended to `docs/archive/build-history.md`.

> **Convention - CLAUDE.md is the durable contract only.** Do NOT grow a per-PR changelog here,
> and do NOT track the current `main` SHA here — that previously forced a
> `docs(contract): bump Current state SHA` commit after every merge (pure churn; dropped
> 2026-06-10). When a PR lands: append the entry to `docs/archive/build-history.md` and update the
> Integration-tip line + your row in `ACTIVE-WORK.md` (gitignored — no commit). Touch this section
> only when a milestone ships or the contract itself changes.


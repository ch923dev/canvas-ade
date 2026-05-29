# Handoff — Phase 2 follow-up: build the self-smoke harness + continue the Phase 2 review

> For a fresh session. Self-contained. Two **independent** tracks — do either, or both
> in parallel (Track 1 = test infrastructure; Track 2 = reading the merged board code).
> **Phase 2 is feature-complete + merged to `main`** (foundation 2.0-A…D + the 3 board
> types). 117 tests; `pnpm typecheck · lint · format:check · test · build` + headless
> smoke all green. The big open risk is that the boards have **never been driven live** —
> static `capturePage()` can't include the native `WebContentsView` layer.

## First 15 minutes (orientation)

1. `CLAUDE.md` → **Status** (full Phase 2 history + commit map) + **Architecture** +
   **Locked decisions** + the **security model** (never weaken).
2. This file. Then per track: `docs/research/self-smoke-testing.md` (Track 1, the verified
   plan) and the board source under `src/renderer/src/canvas/boards/` (Track 2).
3. `docs/decisions/0002-preview-gate.md` for the native-view constraints (occlusion,
   per-board `partition: preview-<id>`, zoom-factor floor).

## Where things are (commit map)

Phase 2 on `main`, in order: `c75049e` 2.0-A tokens · `73f1932` 2.0-B schema+store ·
`8db13ea` EPIPE fix · `fa47709` 2.0-C canvas+BoardFrame+LOD · `46fa71b` 2.0-D app chrome ·
`dd6a047` board dispatch-seam freeze · boards `4917bc5` (2.1) / `1fdac92` (2.2) /
`f8c579a` (2.3) · merges `4f75298` / `8c3a985` / `7e5e53b` · `a952638` eslint ignore
`.claude/**` · research doc + `ded94a2` docs · **`06470fe`** review fixes (#2/#3/#4 below).

Layout: `App.tsx` = full-bleed `<Canvas>` (tab harness gone; `RENDERER_SMOKE` probe in
`smoke/useRendererSmoke.ts`). Boards: `canvas/boards/{Terminal,Browser,Planning}Board.tsx`
(dispatched from `BoardNode.tsx` via `BoardViewProps`) + `boards/planning/*` +
`boards/BrowserPreviewLayer.tsx`. Pure libs: `lib/{boardSchema,canvasView,cameraBounds,
browserLayout,pen}.ts`, `boards/terminalState.ts`. Stores: `store/{canvasStore,previewStore}.ts`.
Main: `main/pty.ts` (shell enum + launchCommand + `{t:'state'}` channel), `main/preview.ts`
(nav IPC + per-view `setWindowOpenHandler`). Vendored: `src/vendor/perfect-freehand/`.
The old `smoke/{FlowSmoke,TerminalSmoke,PreviewSmoke}.tsx` stay on disk (unrendered) as
salvage references.

## Review issues found 2026-05-29 (precedent for Track 2)

- **#2 DiagOverlay live count** — was hardcoded `0`. FIXED (`06470fe`): `selectLiveCount`
  in `previewStore` → `Canvas.tsx`.
- **#3 `awaiting-input` terminal state** — wired in UI + port channel but `pty.ts` never
  emits it. INTENTIONAL forward-wiring, now documented in `terminalState.ts` (`06470fe`).
- **#4 Terminal listener leak** — `term.onData/onResize` were registered inside `onWinMsg`
  (re-fires per `restart()`), disposables dropped. FIXED (`06470fe`): registered once
  against `portRef.current`, disposed on teardown.
- **#1 Live-verify gap** — CLOSED for the in-process layer by Track 1 Stage 1 (`CANVAS_SMOKE=e2e`, branch `e2e-smoke-harness`): boots the built app, seeds each board, asserts terminal framebuffer echo + Browser native per-view `capturePage` non-blank + Planning round-trip. Remaining live coverage (real drag/pen/pan) lands in Stage 2 (Playwright).
- **#5 Browser dead-URL status** — a dead/refused URL ends `connected` (Chromium error-page `did-finish-load` fires after `did-fail-load`, overwriting `load-failed`). Found by the e2e harness. Fix in `preview.ts`/`BrowserPreviewLayer` (don't let an error-page finish-load override a fail-load). Tracked, deferred.

---

## Track 1 — build the self-smoke harness

**Goal:** the agent runs ONE command, reads pass/fail from exit code + console markers,
and verifies all 3 board types at runtime **including the native Browser layer** — no human
eyeballing. Full verified plan + citations: **`docs/research/self-smoke-testing.md`**.

**Stage 1 — DONE** (branch `e2e-smoke-harness`, not the `selfTest.ts` extension as originally sketched but a dedicated `e2eSmoke.ts` + `window.__canvasE2E` hook). The remaining Track 1 work is Stage 2 (Playwright).

**Staged (do step 1 first; it closes most of #1 with zero new deps):**

1. **In-process (extend `selfTest.ts` + `CANVAS_SMOKE`).**
   - Add an **env-gated (`CANVAS_E2E=1`) test-only registry in MAIN** that exposes the live
     preview `WebContentsView`s (e.g. a module-level `Map` the preview manager populates) so
     a script can enumerate them. **Do NOT weaken `sandbox`/`contextIsolation`** — it's a
     registry, not a security change.
   - Script a boot → add one of each board (drive the renderer, or seed the store) →
     assert: terminal PTY echo (sentinel pattern already in `testPty()`), per-board
     `view.webContents.capturePage()` for the Browser native layer (the layer
     `mainWindow.capturePage()` can't see), Planning elements present. Emit markers.
   - **Re-add the `CANVAS_SHOT` window-capture as a committed dev-only path** (it was temp
     scaffolding each time — see the snippet under Carry-forward). Makes visual checks repeatable.
2. **Playwright `_electron` (for real rendered-UI interaction).**
   - `pnpm add -D @playwright/test playwright`; an `e2e/` suite; `electron.launch({ args:
     ['out/main/index.js'] })` against the built app (`pnpm build` first).
   - Drive UI via `firstWindow()` `Page` (dock clicks, drag/resize/pan/zoom, keyboard).
   - **Terminal readback:** `pnpm add @xterm/addon-serialize`, load it on the xterm, read
     `serializeAddon.serialize()` from the renderer (via `page.evaluate`) — not DOM scraping.
   - **Native Browser layer (the gap):** Playwright `connectOverCDP` collapses all
     `preview-<id>` partitions into ONE context — the per-board native views are **not**
     Playwright pages (closed not-planned, microsoft/playwright#34815). Assert from MAIN:
     `electronApp.evaluate()` → walk `mainWindow.contentView.children` → filter
     `WebContentsView` → `view.webContents.capturePage()` / `view.webContents.debugger`.

**Gotchas (verified — see research doc):** `capturePage()` is blank for detached/occluded
views → capture **while on-screen** (interacts with our LOD detach+snapshot — capture
before detach). Playwright Mouse fires **mouse**, not **pointer** events; perfect-freehand
uses pointer → **verify pen/drag empirically**. **Don't hardcode coordinates** — derive from
rendered element boxes + the live camera transform. `webContents.sendInputEvent()` needs the
window focused (fragile) — prefer Playwright's CDP input. Spaced path `Z:\Canvas ADE` doesn't
break Playwright (quote/absolute paths); node-pty's spaced-path hazard is already mitigated
(pinned beta). Windows headless is a non-issue on the dev machine — launch a real/background
window. Decide: test the **dev server (HMR :5173)** or the **built `out/main`** — and confirm
node-pty (Electron ABI) behaves the same under a Playwright-launched process.

**Done when:** `pnpm <test cmd>` non-interactively boots, drives + asserts each board incl.
the native layer, exits non-zero on failure. Add a CI job after it's stable.

---

## Track 2 — continue the Phase 2 review

**Already reviewed** (this session): the security + shared diffs (preload boundary, preview
nav IPC + `setWindowOpenHandler`, pty shell-enum/state-channel/spawn-failed) and the 4 issues
above. The boards were built by parallel agents, gate-green, but their **internal logic was
not line-read**. Read for correctness bugs / leaks / races:

- **Terminal** (`TerminalBoard.tsx`, `terminalState.ts`): port lifecycle across
  `restart()` / `toggleRun()` / `interrupt()`; spawn-failed paths; the `keydown` capture
  guard scope (does it over/under-capture?); does the run timer/spinner stop on exit; FitAddon
  resize → cols/rows correctness.
- **Browser** (`BrowserBoard.tsx`, `BrowserPreviewLayer.tsx`, `lib/browserLayout.ts`,
  `previewStore.ts`): the rAF pump + attach/detach/demote ordering races; `MAX_LIVE=4`
  eviction correctness; `paneOffset` (fine while full-bleed — fragile if an inset/bar is
  added); snapshot timing vs LOD; the reconcile loop (navigate-on-url-change, geometry
  re-push); the status state machine — **resolve the open question: does a dead localhost
  actually reach `load-failed`?** (the `did-fail-load` filter drops `errorCode -3` /
  sub-frames; "connected" was seen on a dead URL in a static shot — confirm live).
- **Planning** (`PlanningBoard.tsx`, `boards/planning/*`, `lib/pen.ts`): the ÷zoom
  screen→board mapping live at varying zoom; element drag/move + pointer capture; checklist
  add/remove-item edge cases (empty list, last item); arrow draw; free-text caret; z-order
  of overlapping elements; that all element `kind`s round-trip through `boardSchema`.
- **Cross-board** (`Canvas.tsx`, `BoardNode.tsx`, `canvasStore.ts`): the controlled-nodes
  `onNodesChange` (only commits dimensions while `resizing`; position commit on drag); focus
  + dim interaction; delete clears focus.
- **Perf / leaks:** `BoardNode` subscribes to zoom via `useStore` → **every board re-renders
  on every zoom tick** (fine now, watch with many boards); preview rAF cost; per-terminal
  WebGL context count (xterm `WebglAddon` per board — how many contexts before exhaustion?).
- **Persistence readiness (Phase 3):** confirm every board (esp. Planning `elements`)
  round-trips through `toObject`/`fromObject` — agents may have added fields the schema/tests
  don't cover.

**Suggested mechanics:** `/code-review` on the Phase 2 range (`git diff dd6a047^..HEAD` or
per board), or spawn `pr-deep-reviewer` / `silent-failure-hunter` per board file. Log new
findings like the #1–#4 list above; fix small, defer large.

---

## Live-verify checklist (manual stopgap for #1 until Track 1 lands)

`pnpm dev`, add each board from the dock, exercise:
- **Terminal:** prompt + `echo hi`; resize board → reflow; **restart 3×** → fresh shell each,
  no slowdown/dupes (the #4 fix); Ctrl-C mid-command.
- **Browser:** URL → a real localhost (or `http://localhost:5173` = the dev app itself);
  Mobile/Tablet/Desktop → frame + page reflow at breakpoint; edit URL+Enter → reload; bad URL
  → load-failed; pan/zoom → snapshot, no native trailing; **HTML frame aligns with the live page?**
- **Planning:** select → tools; note place+type; checklist toggle → progress bar; arrow drag;
  **pen at zoom 1 then zoomed → stroke under the cursor?**
- **Chrome:** dbl-click focus dims others; `Ctrl+Shift+D` → "views" reflects live Browser boards.

## Carry-forward / gotchas

- **Never weaken security:** `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`;
  external nav → `setWindowOpenHandler` deny + `shell.openExternal`; Browser content never to PTY.
- **node-pty stays `1.2.0-beta.13`** (winpty-free; spaced repo path). Don't touch.
- **Native-view limits (ADR 0002):** paints above all HTML; per-board `partition: preview-<id>`
  required; `setZoomFactor` floor 0.25; `capturePage` blank when detached.
- **Agent worktrees:** 3 locked under `.claude/worktrees/` (gitignored) + branches
  `worktree-wf_1f60a0d8-86b-{1,2,3}` — remove with `git worktree remove -f -f <path>` then
  `git branch -D` if you want them gone (all work is already merged).
- A `pnpm dev` may be left running from the prior session — kill stale Electron/node first.
- **`CANVAS_SHOT` quick-capture snippet** (drop into `main/index.ts` `whenReady`, gate on env,
  remove or keep behind the flag): on `did-finish-load`, after a settle delay,
  `mainWindow.webContents.capturePage()` → `fs.writeFileSync(process.env.CANVAS_SHOT, img.toPNG())`
  → `app.quit()`. Captures HTML only (NOT the native view — that's the whole point of Track 1).

## Start here

Pick a track (or run both — independent). Track 1 first is recommended: it closes #1, the
biggest open risk, and makes every later change self-verifiable. Then resume Track 2 review +
roll into Phase 3 (persistence / Focus+Full view / Duplicate / git worktrees + per-board ports).

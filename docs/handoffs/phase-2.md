# Handoff — Phase 2: Core boards (production canvas + the board types)

> For a fresh session. Self-contained. **Phase 1 GATE is PASSED** (ADR 0002) — native `WebContentsView`
> preview is feasible. Phase 2 promotes the salvaged spike into the real canvas, then builds the board
> types. Phase 2 is **too big for one shot** → decomposed below. Each step ends **runnable + committed**.
> See `docs/roadmap.md` → Phase 2 and `docs/decisions/0002-preview-gate.md`.

## Two decisions locked this session (2026-05-29)

1. **Checklist is a Planning ELEMENT, not its own board type.** A checklist card lives *inside* a Planning
   board alongside notes/arrows/text/pen (matches DESIGN.md §7.3 + the design chat). **No 4th board type,
   no `+ Checklist` dock button.** It folds into **2.3 Planning**; roadmap's old "2.4 Checklist board" is
   dropped as a separate phase. (This overrides the earlier CLAUDE.md "its own board type" line — CLAUDE.md
   + roadmap updated to match.)
2. **Board types build in PARALLEL** after 2.0 lands (independent — each only consumes the shared
   `BoardFrame` + schema). See "Parallel execution" below.

## First 15 minutes (orientation)

1. Read `CLAUDE.md` (esp. **Architecture**, **Locked decisions**, security model — never weaken).
2. Read `docs/decisions/0001-stack.md` (React Flow + custom whiteboard) and `0002-preview-gate.md`
   (gate verdict + load-bearing preview decisions + **known WebContentsView constraints**).
3. Skim the AUTHORITATIVE design bundle (recreate the *look*, not the prototype code):
   - `design-reference/project/DESIGN.md` — the visual contract (tokens §2-4, board chrome §6, per-type §7,
     app chrome §8, motion §9). **Design wins on UX; CLAUDE.md/ADRs win on the stack.**
   - `design-reference/project/boards.jsx` — authoritative board markup (`BoardFrame`, all board contents).
   - `design-reference/project/app.jsx` — canvas + app chrome + overlays. `icons.jsx` — `Icon` + `TypeGlyph`.
   - `design-reference/project/frames.jsx` — static state gallery (resting/hover/selected/LOD/full/empty).
4. Note: all design files say "tldraw" / `<webview>` / `ShapeUtil` — **ignore**; ADR 0001 mandates React
   Flow custom nodes + native `WebContentsView` + custom whiteboard. The **tweaks panel is CUT** — ship
   fixed defaults (`accent #4f8cff`, dots, density **compact**, soft 8px corners, dimOnFocus on).

## What graduates from the Phase 1 spike (salvage map)

**Keep ~as-is (production-quality):**
- `src/renderer/src/lib/cameraBounds.ts` — `worldRectToScreen` / `roundRect` / `rectsEqual` / `fitZoomFactor`
  (+ 24 tests). The load-bearing transform. Consumed by `BoardFrame`/preview sync instead of `FlowSmoke`.
- `src/main/preview.ts` — keyed `Map<id, WebContentsView>` manager. IPC: `preview:open / setBoundsBatch /
  capture / detach / attach / close / closeAll`; `partition: preview-${id}` (zoom isolation), `applyZoom` +
  `did-finish-load` re-apply, `disposeOne`→`webContents.close()`, `disposeAll`. Add nav IPC in 2.2.
- `src/main/pty.ts` — the bridge: `pty:spawn`/`pty:kill`, MessagePort data plane (`pty:port`), `defaultShell()`,
  `killTree()` (Win `taskkill /T /F`, *nix negative pgid). Add `launchCommand` + shell-list + state channel in 2.1.
- `src/preload/index.ts` — `contextBridge` `window.api` + the MessagePort re-post pattern. Add channels per board.
- `src/main/index.ts` — secure window + `shutdown()` spine. Rework the localServer/`CANVAS_SMOKE` plumbing.
- `src/renderer/src/spike/DiagOverlay.tsx` — keep (rewire `liveViews` to the real manager; move the
  Ctrl/⌘+Shift+D toggle into app chrome).
- **The PreviewManager ALGORITHM inside `FlowSmoke.tsx`** (the `<PreviewManager>` forwardRef): `boundsFor`,
  `zoomFor`, `liveEligible`, `demoteToSnapshot`, `attachBoard`, `closeBoard`, `flushBatch` (coalesced
  diff-skipped batch), `startPump` (self-stopping rAF), `beginMotion`/`endMotion` (capture→snapshot→detach /
  reattach), `useOnViewportChange`, paneOffset ResizeObserver. Constants `LOD_ZOOM=0.4`, `MAX_LIVE=4`,
  `PRESETS=[390,834,1280]`. **Extract into the real canvas/BoardFrame in 2.0-C / 2.2.**

**Throwaway (delete after extracting the algorithm):** `App.tsx` tab harness + `RENDERER_SMOKE` probe;
`smoke/FlowSmoke.tsx` shell (control bar, leak-cycle button, `SmokeNode`, `initialNodes`); `smoke/PreviewSmoke.tsx`;
`smoke/TerminalSmoke.tsx` component (its xterm wiring is the reference for 2.1); `main/localServer.ts` test page;
`.react-flow__node-smoke` CSS. Reassess `selfTest.ts`/`CANVAS_SMOKE` (may keep as CI smoke).

---

## 2.0 — Production canvas foundation (SEQUENTIAL; gates everything) ⛓ Phase 1

Decomposed into 4 gated steps. **Do these in order; 2.1/2.2/2.3 can't start until 2.0 is stable.**

### 2.0-A · Design tokens + animations
Make `src/renderer/src/index.css` the faithful mirror of DESIGN.md §2-4. **Token drift to FIX** (align to
DESIGN.md — it's authoritative on visual): `--grid-dot #202022` (CSS has `#232327`), `--surface-overlay
#1e1e22` (has `#232328`), `--border-strong rgba(255,255,255,.16)` (has `.17`), resting board shadow last
alpha `.6` (has `.62`).
**Add the missing tokens:** type scale (`micro` 10/14/500/+.06em-upper · `meta` 11/16/450 · `label` 12/16/500
· `body` 13/20/400 · `term` 12.5/19 mono · `h` 15/22/600/-.01em); spacing base 4 (steps 2,4,6,8,12,16,20,24,32);
radii `--r-inner: 6`, `--r-ctl: 5`, `--r-pill: 999` (`--r-board: 8` exists); elevation `--shadow-board:
0 1px 2px rgba(0,0,0,.45), 0 10px 28px -12px rgba(0,0,0,.6)` + `--shadow-pop: 0 8px 24px -6px rgba(0,0,0,.7)`;
`--titlebar-h: 34px` (compact default; **roomy is dropped** — tweaks cut). **`ca-*` keyframes** (referenced by
the prototype, must be defined): `ca-pulse` (ok status dot), `ca-progress`/`ca-progress-bar` (1.2s linear
indeterminate run sliver), `ca-blink` (1s step caret), `ca-caret-run` (running terminal glyph caret).
Respect `prefers-reduced-motion` (drop spinner/loops).
- ✅📏 tokens compile; a throwaway swatch/visual check matches DESIGN.md; no other gate regression. Commit.

### 2.0-B · State store + board-data schema + `schemaVersion` ⛓ 2.0-A
Zustand store for app/ephemeral state. **Typed board-data schema** (every board serialization-ready from
birth): common fields `{ id, type, x, y, w, h, title, z? }` + per-type props — Terminal `{ shell?,
launchCommand?, cwd?, port? }`, Browser `{ url, viewport: 'mobile'|'tablet'|'desktop' }`, Planning
`{ elements: (note|text|arrow|stroke|checklist)[] }`. Root integer `schemaVersion` + a migration-pipeline
stub. `toObject()` / `fromObject()` round-trip **in memory only** (file I/O is Phase 3). Default add-board
sizes: browser 700×500, planning 516×366, terminal 420×340; min 240×160.
- ✅📏 unit tests: schema (de)serialize round-trips; migration stub no-ops at current version. Commit.

### 2.0-C · Real canvas + `BoardFrame` + `NodeResizer` + selection/LOD ⛓ 2.0-B
Promote the spike canvas + the salvaged PreviewManager algorithm. React Flow: `minZoom 0.1`/`maxZoom 2.5`,
zoom-to-cursor (Ctrl/⌘+wheel, `z*exp(-deltaY*0.0022)`), wheel-pan, dotted `Background` (24px world lattice,
1px `--grid-dot`, **opacity fades < ~30% zoom**), `hideAttribution`, dark restyle, fit (pad 64).
**Shared `BoardFrame`** (one shell, vary only glyph + content slot): titlebar `--titlebar-h` 34, padding
`0 8px 0 10px`, **title bar = drag handle** (cursor grab); left = `TypeGlyph(16)` + type tag (≈10px mono caps,
+.07em, `--text-faint`) + title (12/500, `--text-2` rest → `--text` selected, ellipsis, dbl-click inline-edit);
right = per-type actions slot + maximize `⤢` (if focusable) + `⋯`. `IconBtn` 24×24 r5 (`--text-3` → `--text-2`
on `--surface-overlay`, active `--accent`, danger+hover `--err`). Content slot bg `--surface` (`--inset` for
Terminal). **States:** resting (1px `--border-subtle` + `--shadow-board`), hover (`--border`), selected (1px
`--accent` + `box-shadow 0 0 0 1.5px --accent` + titlebar `--accent-wash` + title `--text`), dimmed (.55 on
focus). **Restyled `NodeResizer`:** 8 handles (corners 10×10 `--surface-overlay`+1px `--border-strong` r2, SE
corner extra `0 0 0 1px --accent`; edges 16px hit), visible on hover||selected, NOT in LOD; min 240×160;
world-space size (÷ `cam.z`). **LOD card** (z < `LOD_ZOOM` 0.4): `--surface-raised`, glyph scaled 1.6×, ~9px
type tag + 15/600 title + one status dot, `pointerEvents:none`, no divider. Keep boards world-space across zoom.
- ✅📏 add/select/move/resize boards; LOD swaps at 40%; selection ring + 8 handles correct; a placeholder
  board renders in `BoardFrame`; DiagOverlay still reads frame-time. Commit.

### 2.0-D · App chrome shell ⛓ 2.0-C
Replace the `App.tsx` tab harness. All chrome = floating islands (`--surface-raised`, `--shadow-pop`, never
full-width). **Bottom-center dock:** `▦ select | + Terminal | + Browser | + Planning` (TypeGlyph + label;
active tool `--accent`; **NO `+ Checklist`** — Planning element). **Top-right camera cluster:** `⤢ fit |
− 142% + | ⊞ overview` (28px controls, mono %). **Top-left:** `◇` + project-switcher placeholder
`canvas-ade ▾` + faint `· N boards`. **Empty state:** `◇` watermark + "Empty canvas" (h 15/600) + body line
+ three dashed ghost buttons (Terminal/Browser/Planning). Keys: `Esc` clears, `Backspace`/`Delete` deletes
selected, `1` fit, `0` reset zoom. `dimOnFocus` on; dbl-click board = **focus** (camera fit pad ~70, dims
others .55) — distinct from Full view (Phase 3).
- ✅📏 dock adds each board type centered in view + auto-selects; camera cluster works; empty state shows
  with 0 boards; app runs with NO smoke tabs. Commit. **← 2.0 COMPLETE; parallel board work may begin.**

---

## Board types — build in PARALLEL after 2.0 (each ends runnable + committed)

Independent: each consumes `BoardFrame` + schema and owns its own files. **Freeze the 2.0 shared surface
(`BoardFrame` API, schema, store, preview/pty IPC) before forking** so parallel work doesn't fight over it.
See "Parallel execution" below.

### 2.1 · Terminal board ⛓ 2.0  (bridge mostly exists in `pty.ts`)
xterm (themed, accent cursor) ⇄ `node-pty` over the MessagePort, control over IPC, keyed by board id.
**Spawn the SHELL, not the agent**; if `launchCommand` set, write it as the **first PTY line**
(`pty.write('claude\r')`) so the agent inherits PATH/profile/auth. Shell **detection** (Win pwsh>powershell>cmd;
*nix `$SHELL` then zsh>bash) + per-board selection. **Kill the tree** on close (already in `pty.ts`).
Chrome (DESIGN §7.1): agent identity pill `● claude-code · mm:ss` (dot `--ok` running [pulse] / `--warn`
awaiting / `--err` fail), run timer, **2px `--accent` indeterminate progress sliver** on the top edge while
running, line kinds (user/think/tool/say/edit `+/−`/ok), braille spinner working line (90ms), bottom
follow-up prompt + blinking caret; actions play/pause · restart · interrupt (Ctrl-C). **Basic states**
(adjustment D): spawning / running / awaiting-input / exited / spawn-failed → needs a state channel back to
the renderer (`pty.ts` only emits `exit` today).
- ✅📏 spawn shell → run a CLI → resize reflows → close kills cleanly; basic states render. Commit.
- **Adds:** `launchCommand` + `shell` enumeration + state events to `SpawnOpts`/pty.ts/preload.

### 2.2 · Browser board ⛓ 2.0, Phase 1  (sync engine exists in `preview.ts` + salvaged algorithm)
Real board over the PreviewManager. **Viewport segmented control** (Mobile 390×844 / Tablet 834×1112 /
Desktop 1280×800) wired to `fitZoomFactor` (widths {390,834,1280} match the proven trick). **Device frame**
(1px `--border-strong`, radius mobile 22 / desktop 8, inset+shadow, mobile notch) — built as **HTML chrome
AROUND the unrounded native rect** (a `WebContentsView` can't be clipped/rounded — ADR 0002). **URL/route bar**
30px: back/fwd/reload + **editable URL** (persisted per board) + `--ok` connected dot + `W × H` readout. **State:**
connecting / connected / load-failed. **Adds nav IPC:** `preview:navigate/goBack/goForward/reload` + surface
`did-navigate`/`did-fail-load` events (today `did-finish-load` is used only for zoom re-apply).
- ✅📏 all three presets correct through camera changes (zoom in past the 0.25 clamp — see ADR 0002);
  URL edits reload; failed load shows a state. Commit.

### 2.3 · Planning board (incl. the Checklist element) ⛓ 2.0  (greenfield)
**Setup:** vendor `perfect-freehand` into `src/vendor/` (pin version + attribution) — adjustment E / ADR 0001.
Whiteboard content on `--surface` with a **finer ~13px dot grid**: sticky notes (4 low-chroma tints
yellow/blue/green/plain, slight rotation, soft shadow), free text, **arrows** (SVG bezier 1.5px
`--border-strong` + arrowhead marker), **freehand pen** (pointer deltas **÷ zoom** — unit-test the mapping),
and the **Checklist element** (card: title + `done/total` mono + 3px `--accent` progress bar; item: 16px r5
checkbox [checked = filled `--accent` + `--void` glyph] + `body` label → `--text-faint` + strikethrough when
done; live toggle). Tool cluster shown **only when the board is selected**: `select · note · check · arrow · pen`.
- ✅📏 create/move/edit notes + checklist items (CRUD + toggle + live progress); strokes land under the cursor
  at any zoom (unit-test the ÷zoom mapping). Commit.
- **Defer:** cross-board connectors (Planning → another board's title bar, on the canvas layer above boards).

---

## Parallel execution (the user's chosen shape)

After **2.0-D** is committed and green, fork the three board types concurrently:
- **Isolation:** one git worktree per board type (`isolation: 'worktree'` if using agents, or separate local
  branches `phase2/terminal`, `phase2/browser`, `phase2/planning`). Each owns distinct files:
  - 2.1 → a `TerminalBoard` component + `pty.ts`/preload terminal-channel additions.
  - 2.2 → a `BrowserBoard` component + `preview.ts`/preload nav-channel additions.
  - 2.3 → a `PlanningBoard` component + `src/vendor/perfect-freehand` + whiteboard element components.
- **Shared-surface freeze:** the `BoardFrame` props, the board-data schema/store, and the existing
  preview/pty IPC contracts MUST be stable before forking. If a board type needs a shared-surface change,
  land it on `main` first, then rebase the worktrees — don't edit `BoardFrame`/schema in parallel branches.
- **Integration:** merge order doesn't matter (independent); each PR/branch must keep `pnpm typecheck · lint
  · format:check · test · build` green + headless smoke. Re-run the full suite after each merge.
- **Conflict-prone files to coordinate:** `src/renderer/src/index.css` (shared tokens — 2.0-A owns them;
  board-specific styles append), the dock in app chrome (2.0-D owns it), `preload/index.ts` + `CanvasApi`
  (additive channels — keep additions in separate, clearly-named blocks).

## Open questions deferred to Phase 3 (don't block Phase 2)

- **Full view of a Browser board** with a native `WebContentsView` (HTML modal can't layer a native view) —
  render the Browser board via a `capturePage()` snapshot in full view, swap live on exit. Phase 3 (Focus/Full view).
- **Title inline-edit gesture** vs dbl-click=focus (which gesture enters rename?) — pick in 2.0-C or defer.
- **Editable URL interaction / default URL / per-board port** — basic edit in 2.2; port assignment Phase 3 (worktrees).
- **Duplicate of a live Terminal board** (spawn new shell/worktree?) — Duplicate is Phase 3; design use-case is Browser.
- **Cross-board connectors** — Planning §7.3; deferred past Phase 2.

## Gotchas / carry-forward (don't relearn these)

- **Never weaken security:** `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, thin preload;
  external nav → `setWindowOpenHandler` deny + `shell.openExternal`; Browser content must NEVER reach the PTY.
- **`node-pty` stays `1.2.0-beta.13`** (winpty-free; repo path has a space). Don't touch.
- **Native view occlusion (ADR 0002):** a `WebContentsView` paints above ALL HTML → keep app chrome OUTSIDE
  the canvas pane; device frame is HTML around an unrounded native rect; LOD/motion = snapshot.
- **Per-board preview session** (`partition: preview-${id}`) is REQUIRED for independent zoom.
- **Zoom-factor floor 0.25** caps how far the desktop preset reflows at heavy zoom-out (snapshot < 40% anyway).
- **Recreate the design's LOOK, not the prototype's code.** Tweaks panel is cut; ship the fixed defaults.
- **Every step ends green + committed:** `pnpm typecheck · lint · format:check · test · build` + headless smoke.
  Add tests for new pure logic (schema round-trip, pen ÷zoom mapping). Update `CLAUDE.md` + add an ADR per decision.

## Start here

Begin at **2.0-A** (tokens). It's low-risk, unblocks everything, and forces a clean read of DESIGN.md §2-4.

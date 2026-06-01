# Expanse — Roadmap

Guides work after Phase 0. Each phase/step ends in a **runnable, committed checkpoint**. The
`design-reference/` bundle is the authoritative UX contract; this roadmap is the build order.
Design wins on UX, the architecture in `CLAUDE.md` wins on the stack.

Legend: 🚦 = hard gate · ✅ = acceptance criteria · 📏 = measured/tested · ⛓ = depends on.

---

## Phase 0 — Toolchain proof ✅ DONE (commit `4d057e0`)

electron-vite + TS + React with secure defaults; React Flow, xterm+webgl, node-pty (ConPTY over
MessagePort), WebContentsView→localhost, and an electron-builder Windows build all verified end to
end (incl. running the packaged exe). CI matrix wired. CLAUDE.md + ADR 0001 written.

---

## Phase 1 — 🚦 Preview feasibility spike (THE GATE), broken into measured steps

Prove the hardest thing before building on it: a native `WebContentsView` preview that stays
visually correct as the React Flow camera pans/zooms — on Windows, with multiple views. Decomposed
so each step **isolates one risk variable** and is independently testable. Steps stay minimal but
**salvageable** — the working sync code graduates into Phase 2.0, the rest can be throwaway.

**1-A · Dev tooling + diagnostics harness** (adjustment B)
- Wire **ESLint + Prettier + Vitest**. Extend CI `check` job to run **lint + test + typecheck + build**.
- A diagnostics overlay (frame timing / live-view count / memory sample) + the pure **camera→bounds
  math** extracted as a unit-tested module (`worldRect → screenRect` given `{x,y,z}`).
- ✅📏 `pnpm test` green; CI gate runs lint+test; overlay shows live metrics.

**1-B · Static overlay** ⛓ 1-A
- One `WebContentsView` pinned to one React Flow node's bounds, camera still.
- ✅📏 view sits pixel-aligned over the cutout; transform unit tests cover the rect math.

**1-C · Live pan/zoom** ⛓ 1-B — *the core risk*
- View follows the camera live via a single rAF loop (`useOnViewportChange`), coalesced IPC, diff-skip.
- ✅📏 record trailing/lag on Windows (frames behind, perceived smoothness). 🚦 if unacceptable even
  coalesced, that's the signal detach+snapshot (1-D) must carry the motion.

**1-D · Detach + snapshot** ⛓ 1-C
- `capturePage` while on-screen → detach → show card during motion → reattach exact bounds on
  `onMoveEnd`. Decide the open question: **Browser board scales with camera (shrinks) vs stays 1:1**
  (assumption: scales with camera).
- ✅📏 perceived motion is smooth (no trailing live view); snapshot never blank; scale model locked.

**1-E · N views + responsive + lifecycle** ⛓ 1-D
- 2+ simultaneous views; viewport reflow at true breakpoint width (390/834/1280) via
  `setZoomFactor`+`setBounds`; cap ~4 live, close far/over-cap; `webContents.close()` leak check.
- ✅📏 multi-view stays aligned; reflow correct; memory stable across open/close (no renderer leaks).

**🚦 GATE verdict (end of 1-E):** smooth + leak-free + aligned → proceed. **If janky and unfixable**,
STOP, write up options (snapshot-only previews, fewer live views, alternate transport) and decide
with the user before Phase 2.

⛓ Phase 0.

---

## Phase 2 — Core boards ⛓ Phase 1

**Decomposed + handed off** (2026-05-29) — too big for one pass. **2.0 = 4 sequential gated steps**
(2.0-A tokens · 2.0-B store+schema · 2.0-C canvas+`BoardFrame`+`NodeResizer`+LOD · 2.0-D app chrome).
Then the board types build **in PARALLEL** (independent). **Checklist is a Planning element, not a 4th
board type** (decided 2026-05-29) → folded into 2.3; old "2.4 Checklist board" dropped. Full plan + exact
design specs + salvage map + parallel guidance: **`docs/archive/build-history.md`** (originals in git).

**2.0 — Production canvas foundation** (adjustments A + C) — *split into 2.0-A…2.0-D in the handoff*
- Promote the salvaged spike into the real canvas: pan/zoom (`minZoom 0.1`/`maxZoom 2.5`,
  zoom-to-cursor), dotted background, `hideAttribution`, dark restyle, overview/fit.
- Shared `BoardFrame` (title bar: glyph + type tag + title + actions + ⋯; content slot), `NodeResizer`
  restyled to 8 handles + min 240×160, selection ring, **LOD card** below 40% zoom.
- App chrome shell: bottom dock (`select · +Terminal · +Browser · +Planning`), top-right
  camera cluster, top-left project-switcher placeholder, empty-state.
- **Persisted node-data schema + `schemaVersion` defined now** (file I/O lands Phase 3) so every board
  is serialization-ready from birth; Zustand for app/ephemeral state; `toObject()` round-trips in-memory.
- ✅📏 unit tests for the node schema (de)serialize; boards add/select/move/resize; LOD swaps at 40%.

**2.1 — Terminal board** ⛓ 2.0
- xterm (themed) ⇄ node-pty over MessagePort; control over IPC. User-selectable shell (detect installed;
  OS default). Agent-agnostic `launchCommand` written as first PTY line. Kill the process tree on close.
- Chrome: agent identity pill (ok/warn/err), `mm:ss` timer, run-progress sliver, follow-up prompt,
  pause/restart/interrupt. **Basic states** (adjustment D): spawning / running / exited / spawn-failed.
- ✅📏 spawn shell → run a CLI → resize reflows → close kills cleanly; basic states render.

**2.2 — Browser board** ⛓ 2.0, Phase 1
- Real board over the PreviewManager: viewport segmented control (Mobile/Tablet/Desktop), device frame
  (mobile 22px + notch), URL/route bar (back/fwd/reload, editable URL, connected dot, dims readout).
  URL persisted per board. **Basic states:** connecting / connected / load-failed.
- ✅📏 all three presets correct through camera changes; URL edits reload; failed load shows a state.

**2.3 — Planning board (incl. the Checklist element)** ⛓ 2.0  *(parallelizable with 2.1 / 2.2)*
- **Setup:** vendor `perfect-freehand` into `src/vendor/` (pin + attribution) (adjustment E).
- Whiteboard content: finer dot grid, sticky notes (4 tints), text, freehand pen (pointer deltas ÷ zoom),
  arrows. Tool cluster (`select · note · check · arrow · pen`) shown only when selected.
- **Checklist element** (folded in from the old 2.4): a card inside Planning — title + `done/total`, 3px
  accent progress bar, add/edit/delete/toggle items, live progress. State in the Planning board's element data.
- ✅📏 create/move/edit notes + checklist items (CRUD + toggle + live progress); strokes land under the
  cursor at any zoom (unit-test the ÷zoom mapping).

---

## Phase 3 — Board actions & projects ⛓ Phase 2

- **Focus** (double-click → camera fit one board, dim others 55%) + **Full view** (modal overlay,
  `FULL VIEW` band + `✕ Esc`, camera unchanged). Preview bounds-sync follows in/out of both.
  ✅ DONE — Focus shipped in Phase 2; **Full view** lands in Slice B (branch `phase-3-board-actions`,
  2026-05-30) as a live **portal relocation** (the board's live subtree is `createPortal`-moved into
  the modal — no remount, so PTY/xterm/native view survive) rather than the originally-planned
  snapshot/reattach: in full view a Browser board's native `WebContentsView` is **re-bound to the
  portaled device-frame's live DOM rect** while every other view detaches, so HTML chrome isn't
  punched through. Spec/plan: `docs/archive/build-history.md` › Phase 3-B (originals in git).
- **Duplicate** (⋯): clone geometry + state offset 36px, select copy; Browser clone → next viewport
  preset, own independent `WebContentsView`. ✅ DONE (branch `phase-3-board-actions`, 2026-05-30):
  `duplicateBoard(id)` offsets +36px, selects the copy, one undo step; Browser clones advance to the
  next viewport preset (`lib/viewportCycle.ts`), planning elements are deep-cloned with fresh ids;
  delivered alongside the shared **⋯ menu** (Full view · Duplicate · Delete) via `BoardActionsContext`.
  Spec/plan: `docs/archive/build-history.md` › Phase 3-B (originals in git).
- **Project create / open** ✅ DONE (branch `phase-3-persistence`, 2026-05-30): folder picker;
  `canvas.json` (+`.bak`, `schemaVersion` **v2** w/ persisted camera `viewport` + real `migrate(1→2)`)
  via atomic write; debounced autosave + flush on blur/quit; recent-projects in `userData`; project
  switcher wired (flush → dispose previews+PTYs → load); restored terminals idle + `cwd`→project folder.
  Spec/plan: `docs/archive/build-history.md` › Phase 3-A (originals in git).

> 🔗 **Bug-hunt cross-refs (both FIXED):** BUG-025 (load validation rejecting non-positive /
> sub-`MIN_BOARD_SIZE` geometry) and BUG-027 (`fromObject`/`migrate` deep-cloning so loaded boards no
> longer alias the caller's input) were both closed by the Round-2 hunt — see `docs/reviews/README.md`.
- **Port detect → push to preview** (Slice C′, replaces the old worktrees+ports slice): a Terminal
  board reads the localhost URL its dev server printed and one click opens/points a Browser board at
  it. **Detect, don't assign** — output-parse only, on-click, reuse-else-spawn target, read-only,
  agent-agnostic, no git. ✅ DONE (branch `phase-3-slice-c`, 2026-05-31; 296 tests, full gate green):
  pure `main/portDetect.ts` parser over a frame-guarded `terminal:detectPorts` IPC; `Canvas.pushPreview`
  + `lib/previewTarget.ts` resolve the target; a React Flow floating connector arrow
  (`lib/previewEdges.ts` + `canvas/edges/PreviewEdge.tsx`) is derived from the new optional
  `BrowserBoard.previewSourceId` (no schema bump) and reroutes + persists; link cleaned up on
  delete/duplicate. Spec + plan: `docs/archive/build-history.md` › Phase 3-C′ (originals in git).
- ✅📏 full reopen fidelity: zoom/pan/positions/contents/checklist state survive restart (integration test).

> 🧰 **Re-scoped 2026-05-30 — git worktrees deferred.** The original Slice C bundled git
> worktrees + static per-board port assignment. Both were re-scoped during brainstorming: static
> assignment (inject `PORT`/`--port`) was dropped in favour of runtime **detection** (above), and
> worktrees were deferred to a post-MCP phase under a better model — **Feature Workspaces** (see
> Deferred). Rationale lives in the Slice C′ spec's "Decision record".

> 💡 **Deferred feature — agentic session resume (own slice, post-Phase 3).** Restored Terminal
> boards come back **idle** (fresh shell on Run; never auto-execute a stored command). A future
> enhancement: persist a per-board session handle and resume the agent's prior conversation on Run
> (e.g. `claude --resume <id>` / `claude -c`). Non-trivial + **agent-specific**: needs the session
> id captured at runtime (scrape PTY output or read the CLI's session file) and a per-CLI resume
> matrix, which cuts against the locked agent-agnostic `launchCommand`. Additive only — an optional
> `resumeCommand?`/`sessionId?` field adds with **zero migration** when built, so nothing to reserve
> now. Give it its own brainstorm + slice.

---

## Phase 4 — Design pass & polish ⛓ Phase 3

- Apply every DESIGN.md token, board-chrome rule, state, and motion spec (+ `prefers-reduced-motion`).

> 🎬 **Deferred polish — Full view enter/exit animation (noted 2026-05-30, Slice B).** Full view
> (`FullViewModal`, branch `phase-3-board-actions`) currently opens/closes **instantly** — no
> transition. Add a motion pass here: scrim fade-in + the frame scale/opacity in from the board's
> on-canvas rect (and reverse on close), honoring `prefers-reduced-motion`. Intentionally cut from
> Slice B (which shipped the live portal-relocation mechanics, not the motion). Note: a Browser
> board's native `WebContentsView` cannot be CSS-animated (it's an OS layer) — animate the HTML
> scrim/frame; the native view snaps to its final bounds (or carries the transition via its snapshot).

> 🐛 **Bug-hunt finding (noted 2026-05-30, RESOLVED in Phase 4):** Fit (button + '1' key) used to
> snap the camera with no animation, violating the DESIGN.md §9 200ms contract. Phase 4 wrapped
> fit/reset/overview/focus in `cameraAnim` (200ms, collapsed to 0 under reduced-motion) — confirmed by
> the Round-3 review. Residual: the zoom **+/−** buttons may still snap (tracked, Low — see
> `docs/reviews/2026-06-01-round3.md` / the in-depth review's L1).
- **Polished** empty / loading / error states throughout (building on Phase 2's basic ones).
- Harden CSP to nonce-based (drop `unsafe-inline`) for the packaged build. Load Geist / Geist Mono.
- Code-split the renderer bundle (xterm / React Flow lazy where sensible).
- ✅ visual parity with the design frames; all states reachable and styled.

---

## Phase 5 — Packaging & release ⛓ Phase 4

- Finalize the per-OS CI matrix. Native rebuild green on all targets.
- Signing: macOS code-sign + notarize (Apple Developer creds), Windows Authenticode (cert).
- Auto-update via electron-updater (release feed). App icons in `build/`.
- Verify `hideAttribution` (no React Flow badge in packaged build).
- ✅ signed installers per OS; in-app update upgrades a prior version.

---

## Cross-cutting (every phase)

- Keep the app launchable after every change; commit per phase/step.
- Never weaken security (contextIsolation/sandbox/no-nodeIntegration/thin preload).
- Maintain lint + format + tests green in CI; add tests with each slice (📏 steps above).
- Update `CLAUDE.md` + add an ADR when a decision lands.
- **Re-evaluate node-pty stable** — drop the beta when a winpty-free stable ships (or relocate the
  spaced repo path) (adjustment E).
- Watch the traps: WebContentsView occlusion/leak, xterm under scale, Windows process-tree kill,
  per-frame IPC fan-out to MAIN (shared with node-pty), vendored perfect-freehand ownership.

## Deferred (not now)

CDP/debug attach to previews (build views CDP-ready, don't implement) · SQLite persistence ·
multiplayer/collaboration · hand-drawn (roughjs) whiteboard aesthetic.

> 🌳 **Feature Workspaces — worktree-backed board zones (post-MCP phase, deferred 2026-05-30).**
> The deferred home for git worktrees, re-modelled. A project's infinite canvas hosts multiple
> **feature zones** — clusters of boards that belong together (e.g. an "Auth/Login" zone = a Terminal
> building auth + a Browser previewing the login page + a Planning board tracking the auth
> checklist; a separate "Signup/Landing" zone with its own three). **Each zone is backed by one git
> worktree + branch.** Every board in a zone operates against that branch's checkout — the agent
> edits there, the browser previews that worktree's dev server, the plan tracks that feature. So a
> worktree is **per-feature-region, not per-board** (the cleaner model the original Slice C lacked).
> Gated on the planned `canvas-ade-mcp` swarm layer, which orchestrates agents across zones/branches.
> Carries forward the still-valid locked safety rules: reuse-if-exists, never nest-init, keep-on-disk
> + prompt on dirty delete, `git worktree remove` never `rm -rf`, `simple-git` in MAIN only behind
> frame-guarded IPC. This subsumes the per-board-worktree assumptions in several
> `docs/feature-proposals.md` entries (SB-3 fan-out, SB-5 diff, OS-1 commit/PR), which should be read
> against the per-zone model.

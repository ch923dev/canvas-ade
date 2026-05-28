# Canvas ADE — Roadmap

Guides work after Phase 0. Each phase ends in a **runnable, committed checkpoint**. The
`design-reference/` bundle is the authoritative UX contract; this roadmap is the build order.
Design wins on UX, the architecture in `CLAUDE.md` wins on the stack.

Legend: 🚦 = hard gate · ✅ = acceptance criteria · ⛓ = depends on.

---

## Phase 0 — Toolchain proof ✅ DONE (commit `4d057e0`)

electron-vite + TS + React with secure defaults; React Flow, xterm+webgl, node-pty (ConPTY over
MessagePort), WebContentsView→localhost, and an electron-builder Windows build all verified end to
end (incl. running the packaged exe). CI matrix wired. CLAUDE.md + ADR 0001 written.

---

## Phase 1 — 🚦 Preview feasibility spike (THE GATE)

Prove the hardest thing before building on it: a native `WebContentsView` preview that stays
visually correct as the React Flow camera pans/zooms — on Windows, with multiple views.

**Build**
1. Real React Flow canvas shell: infinite pan/zoom (`minZoom 0.1`, `maxZoom 2.5`, zoom-to-cursor),
   dotted background, `hideAttribution`, dark restyle. This becomes the canvas foundation for Phase 2.
2. A custom **Browser board node** rendering the device-frame chrome + a transparent cutout.
3. **PreviewManager (main)** over **N** `WebContentsView`s — built for many from day one:
   - Sync each view's `setBounds()` + scale to the camera via a single rAF loop driven by
     `useOnViewportChange`; coalesce to one IPC batch/frame; diff-skip no-ops.
   - Responsive trick: fixed CSS width W∈{390,834,1280}, `setZoomFactor(fitScale*camZoom)` +
     `setBounds(width: W*fitScale*camZoom)`.
   - **Detach + snapshot** on pan/zoom and below ~40% zoom (`capturePage` while on-screen →
     detach → show card; reattach exact bounds on `onMoveEnd`). Cap ~4 live; close far/over-cap.
   - `webContents.close()` on board removal (no `destroy()` → else leak).
4. Two simultaneous preview boards to exercise N-view sync + the live cap.

**✅ Acceptance / 🚦 abort criteria**
- Pan/zoom on Windows feels smooth (snapshot-while-moving hides IPC lag; live view re-pins crisply on idle).
- 2+ previews stay aligned; switching viewport reflows the page at the true breakpoint width.
- No renderer leaks across open/close cycles; memory stable with the live cap.
- **If janky and unfixable** with detach+snapshot: STOP, write up options (e.g. snapshot-only previews,
  fewer live views, or a different preview transport) and decide with the user before Phase 2.

⛓ Phase 0.

---

## Phase 2 — Core boards (one runnable vertical slice at a time)

Built on the Phase 1 canvas foundation. Each board = a custom React Flow node sharing a chrome base.

**2.0 — Board framework**
- Shared `BoardFrame` (title bar w/ glyph + type tag + title + actions + ⋯, content slot), `NodeResizer`
  restyled to 8 handles + min 240×160, selection ring, **LOD card** below 40% zoom (glyph+title+status).
- App chrome shell: bottom dock (`select · +Terminal · +Browser · +Planning · +Checklist`), top-right
  camera cluster (`fit · −/%/+ · overview`), top-left project switcher placeholder, empty-state.
- Zustand store for board/app state; React Flow `toObject()` round-trips (in-memory for now).

**2.1 — Terminal board** ⛓ 2.0
- xterm (themed to tokens) ⇄ node-pty over MessagePort; control over IPC. User-selectable shell
  (detect installed; OS default). Agent-agnostic `launchCommand` written as first PTY line.
- Chrome: agent identity pill (ok/warn/err dot), `mm:ss` run timer, run-progress sliver, follow-up
  prompt affordance, pause/restart/interrupt actions. Kill the process tree on close.
- ✅ Spawn a shell, run a CLI, resize reflows, output streams smoothly, close kills cleanly.

**2.2 — Browser board** ⛓ 2.0, Phase 1
- Promote the Phase 1 preview into a real board: viewport segmented control (Mobile/Tablet/Desktop),
  device frame (mobile 22px + notch), URL/route bar (back/fwd/reload, editable URL, connected dot,
  dims readout). URL persisted per board.
- ✅ All three presets render correctly through camera changes; URL edits reload.

**2.3 — Planning board** ⛓ 2.0
- Whiteboard content: finer dot grid, sticky notes (4 tints), text, freehand pen (vendored
  perfect-freehand, pointer deltas ÷ zoom), arrows. Tool cluster shown only when selected.
- ✅ Create/move/edit notes + draw strokes that land under the cursor at any zoom.

**2.4 — Checklist board** ⛓ 2.0
- Own board type, Planning visual family: title + `done/total`, 3px accent progress bar, toggle/
  add/edit/delete/reorder items. Responsive: large = full list, medium = scroll, small = collapsed
  summary. State lives in the node props (persists with the canvas).
- ✅ Items CRUD + reorder; progress updates live; resize switches the three density modes.

---

## Phase 3 — Board actions & projects ⛓ Phase 2

- **Focus** (double-click → camera fit one board, dim others to 55%) and **Full view** (modal
  overlay, `FULL VIEW` band + `✕ Esc`, camera unchanged). Preview bounds-sync follows in/out of both;
  in full view a Browser board renders via snapshot/reattach so HTML chrome isn't punched through.
- **Duplicate** (⋯ menu): clone geometry + state offset 36px, select copy; Browser clone defaults to
  the next viewport preset, its own independent `WebContentsView`.
- **Project create / open**: folder picker; `canvas.json` (+`.bak`, `schemaVersion`) via atomic write,
  debounced autosave + flush on blur/quit; recent-projects in `userData`; project switcher wired.
- **Git worktrees**: opt-in toggle on create (reuse-if-exists, never nest-init); worktree per Terminal
  board; keep-on-disk + prompt on dirty delete; per-board port assignment for previews.
- ✅ Full reopen fidelity: zoom/pan/board positions/contents/checklist state survive restart.

---

## Phase 4 — Design pass & polish ⛓ Phase 3

- Apply every DESIGN.md token, board-chrome rule, state, and motion spec (incl. `prefers-reduced-motion`).
- Empty / loading / error states throughout (board spawn, preview connecting/failed, agent failed,
  project load error, git/worktree errors).
- Harden CSP to nonce-based (drop `unsafe-inline`) for the packaged build. Load Geist / Geist Mono.
- Code-split the renderer bundle (xterm / React Flow lazy where sensible).
- ✅ Visual parity with the design frames; all states reachable and styled.

---

## Phase 5 — Packaging & release ⛓ Phase 4

- Finalize the per-OS CI matrix (already scaffolded). Native rebuild green on all targets.
- Signing: macOS code-sign + notarize (needs Apple Developer creds), Windows Authenticode (needs cert).
- Auto-update via electron-updater (release feed). App icons in `build/`.
- React Flow production check: `hideAttribution` verified absent of badge in packaged build.
- ✅ Signed installers per OS; in-app update upgrades a prior version.

---

## Cross-cutting (carry through every phase)

- Keep the app launchable after every change; commit per phase/slice.
- Never weaken the security model (contextIsolation/sandbox/no-nodeIntegration/thin preload).
- Update `CLAUDE.md` + add an ADR when a decision lands.
- Watch the known traps: WebContentsView occlusion/leak, xterm under scale, Windows process-tree
  kill, per-frame IPC fan-out to MAIN (shared with node-pty), vendored perfect-freehand ownership.

## Deferred (not now)

CDP/debug attach to previews (build views CDP-ready, don't implement) · SQLite persistence ·
multiplayer/collaboration · hand-drawn (roughjs) whiteboard aesthetic.

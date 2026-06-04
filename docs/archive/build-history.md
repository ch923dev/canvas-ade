# Build history — phases, slices & superseded plans

Point-in-time record of how Canvas ADE was built, phase by phase. **Not live truth** — the
durable contract is `CLAUDE.md`; the build order + current status is `docs/roadmap.md`.

Per-slice **specs, plans, and phase handoffs were collapsed into summaries on 2026-06-01 and again
on 2026-06-04** (docs centralization). The full documents remain in git history. To recover one:
`git log --all --oneline -- docs/superpowers/` or `-- docs/handoffs/`, then check out the path at that
commit. Two large initiatives have their own compiled build-logs in this folder — see Post-Phase-4 below.

## Phases (all shipped on `main`)

| Phase | What shipped | Landed |
|---|---|---|
| 0 — Toolchain proof | electron-vite + TS + React, secure defaults; React Flow / xterm+webgl / node-pty (ConPTY over MessagePort) / WebContentsView→localhost / electron-builder all verified e2e; CI matrix. | `4d057e0` |
| 1 — Preview feasibility gate | Native `WebContentsView` stays camera-correct under pan/zoom on Windows; steps 1-A…1-E (diagnostics, static overlay, live pan/zoom, detach+snapshot, N-views+responsive+lifecycle). Gate passed (ADR 0002). | (Phase 1 branches) |
| 2 — Core boards | Foundation 2.0 (tokens · store+schema · canvas+`BoardFrame`+`NodeResizer`+LOD · app chrome) then Terminal · Browser · Planning+Checklist in parallel. Checklist = Planning element, not a 4th type. | (Phase 2 branches) |
| 3 — Board actions & projects | Slice A persistence (`canvas.json` v2 + `.bak`, atomic write, autosave, recent-projects, project switch) · Slice B board actions (Full view, Duplicate, ⋯ menu) · Slice C′ port-detect→push-to-preview (git worktrees deferred to Feature Workspaces). | `139bc69` |
| 4 — Design pass & polish | Every DESIGN.md token / board-chrome rule / state / motion (+ `prefers-reduced-motion`); full-view motion; §6.1 top band descoped into the title-bar toggle. | `abd7fa2` (PR #9) |
| 5 — Packaging & release | **Not started.** CI matrix unsigned until here; signing (mac notarize + Win Authenticode), electron-updater feed, app icons. | — |

> **Note on the Phase 3 Full-view mechanism:** Phase 3-B originally shipped Full view via *live portal
> relocation*. That model was **superseded** by PR #14 (see Post-Phase-4) — full view now **detaches**
> every board's native `WebContentsView` (never `close()`, never portal-relocates) to preserve page state.

## Post-Phase-4 work (chronological)

- **Layout presets / smart tidy** (PR #13, `14f77d7`) — FancyZones-style layout presets + a one-press
  Tidy (shelf-pack to the pane aspect) + fit-to-frame; `t` shortcut. Memory `tidy-and-fit-feature`.
- **D1.1 — `trackedChange` undo-rail refactor** (PR #18, `f7ffbbf`) — collapsed the per-action
  `lastRecorded` phantom-undo discipline into one `trackedChange` helper routing add/remove/duplicate/
  tidy/undo-redo. A no-op gesture on add/remove/duplicate is a tolerated phantom edge (memory
  `undo-lastrecorded-phantom`). Opened the draw.io feature track (`docs/roadmap-drawio.md`).
- **Full-view preview state-preservation** (PR #14, `ad21389`) — toggling full view **restarted**
  Browser boards: `applyLiveness`'s full-view branch tore down native views with `webContents.close()`,
  which discards the page, so on exit `attachBoard` re-`openPreview`d at the durable `board.url`,
  snapping the navigated page back to root. Now both paths **detach** (snapshot + keep the live
  `WebContentsView`); exit re-attaches via `attachPreview` (no `loadURL`), state intact. Removed the
  now-dead `evictLiveBoard` (closed the PREV-A resurrection class). Added animated e2e harness path +
  `fullview-preserve`/`fullview-self-preserve` probes.
- **Round-3 review backlog cleared** (PR #15 `cd588be` + PR #20 `3be2c62`) — the 2026-06-01 6-dimension
  in-depth review's 12 findings (PTY-2 · WB-1 · STATE-1/2 · SEC-1/2 · PERSIST-A/B/C · PREV-A/B/C), all
  verified-fixed and on `main`. No open findings remain (`docs/reviews/README.md`). PREV-A was closed by
  the PR #14 fullview refactor; the rest by #15/#20.
- **Whiteboard epic (W1–W5)** — eraser/shortcuts · multi-select/snapping · align/lock/group · image
  assets · PNG/SVG export. Shipped on `main` via `feat/whiteboard` PR #34 (`9533f67`), schema → v4.
  Full compiled build-log: **`2026-06-03-whiteboard-epic.md`** (this folder).
- **Testing strategy T0–T5** — migrated the homegrown `CANVAS_SMOKE=e2e` harness to Playwright
  `_electron` + a local Windows-native/Linux-Docker pre-commit matrix; the GitHub Actions e2e/smoke job
  was retired. Full compiled build-log: **`2026-06-03-testing-strategy-initiative.md`** (this folder);
  living contract: `docs/testing/TESTING.md`.
- **Context subsystem (M-digest + M-brain + M-memory)** — desktop LLM brain + `.canvas/` project memory
  → instant per-board context digest on reopen, zero agents/MCP. Shipped on `main` via PR #39
  (`4c321c2`); ADR `0003-llm-egress.md`. Full compiled build-log: **`2026-06-04-context-subsystem.md`**
  (this folder). Only M-expose (MCP read resource) remains, deferred — `docs/roadmap.md` › Deferred.

## Per-slice specs, plans & handoffs (in git history)

Each slice followed the cadence **brainstorm → spec → plan → execute (subagent workflow)** with a
per-task handoff. Phases 0–4 plans/specs/handoffs were under `docs/superpowers/` and `docs/handoffs/`;
the whiteboard, context, and testing per-task docs were collapsed into the compiled build-logs above on
2026-06-04. All originals are recoverable from git history:
`git log --all --oneline -- docs/superpowers/ docs/handoffs/`, then check out the path at that commit.

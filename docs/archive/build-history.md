# Build history — phases, slices & superseded plans

Point-in-time record of how Expanse was built, phase by phase. **Not live truth** — the
durable contract is `CLAUDE.md`; the build order + current status is `docs/roadmap.md`.

Per-slice **specs, plans, and phase handoffs were collapsed into this summary on 2026-06-01**
(docs centralization). The full documents remain in git history. To recover one:
`git log --all --oneline -- docs/superpowers/` or `-- docs/handoffs/`, then check out the path
at that commit.

## Phases (all shipped on `main`)

| Phase | What shipped | Landed |
|---|---|---|
| 0 — Toolchain proof | electron-vite + TS + React, secure defaults; React Flow / xterm+webgl / node-pty (ConPTY over MessagePort) / WebContentsView→localhost / electron-builder all verified e2e; CI matrix. | `4d057e0` |
| 1 — Preview feasibility gate | Native `WebContentsView` stays camera-correct under pan/zoom on Windows; steps 1-A…1-E (diagnostics, static overlay, live pan/zoom, detach+snapshot, N-views+responsive+lifecycle). Gate passed. | (Phase 1 branches) |
| 2 — Core boards | Foundation 2.0 (tokens · store+schema · canvas+`BoardFrame`+`NodeResizer`+LOD · app chrome) then Terminal · Browser · Planning+Checklist in parallel. Checklist = Planning element, not a 4th type. | (Phase 2 branches) |
| 3 — Board actions & projects | Slice A persistence (`canvas.json` v2 + `.bak`, atomic write, autosave, recent-projects, project switch) · Slice B board actions (Full view via live portal-relocation, Duplicate, ⋯ menu) · Slice C′ port-detect→push-to-preview (git worktrees deferred to Feature Workspaces). | `139bc69` |
| 4 — Design pass & polish | Every DESIGN.md token / board-chrome rule / state / motion (+ `prefers-reduced-motion`); full-view motion; §6.1 top band descoped into the title-bar toggle. | `abd7fa2` (PR #9) |
| 5 — Packaging & release | **Not started.** CI matrix unsigned until here; signing (mac notarize + Win Authenticode), electron-updater feed, app icons. | — |

## Per-slice specs & plans (in git history under `docs/superpowers/`)

Each followed the cadence **brainstorm → spec → plan → execute (subagent workflow)**.

| Slice / work | spec + plan (git paths) |
|---|---|
| Persistence (Phase 3-A) | `specs/2026-05-30-persistence-design.md` · `plans/2026-05-30-persistence.md` |
| Board actions (Phase 3-B) | `specs/2026-05-30-board-actions-design.md` · `plans/2026-05-30-board-actions.md` |
| Port-detect → preview (Phase 3-C′) | `specs/2026-05-30-port-detect-preview-design.md` · `plans/2026-05-30-port-detect-preview.md` |
| Terminal undo (session 15) | `specs/2026-05-30-terminal-undo-session-15-design.md` · `plans/2026-05-30-terminal-undo-session-15.md` |
| Phase 4 design pass | `plans/2026-05-31-phase-4-design-pass.md` · `specs/2026-05-31-fullview-motion.md` |
| Phase 3 bug-fix batch | `plans/2026-05-31-phase-3-bug-fixes.md` |
| Alignment guides | `research/2026-05-31-alignment-guides.md` · `specs/2026-05-31-alignment-guides.md` · `plans/2026-05-31-alignment-guides.md` + slice-2a/2b/2b-caseB/3-resize plans (2026-06-01) |
| Self-smoke harness (stage 1) | `plans/2026-05-29-self-smoke-harness-stage1.md` |
| Findings remediation | `plans/2026-05-29-findings-remediation.md` |

## Phase handoffs (in git history under `docs/handoffs/`)

Entry/exit notes per phase, superseded by the table above + `CLAUDE.md` Status:
`status-archive.md` (consolidated phase log) · `phase-1.md` · `phase-1-a.md` · `phase-2.md` ·
`phase-2-followup.md` · `phase-3-slice-c.md` · `phase-4.md` · `session-15-terminal-undo.md` ·
`2026-05-31-phase-3-bug-fixes-handoff.md` · `2026-05-31-phase-4-progress-handoff.md`.

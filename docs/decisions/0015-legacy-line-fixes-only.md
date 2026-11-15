# ADR 0015 — This Electron app is the legacy line (fixes only); the Rust version is a separate project

**Status:** Accepted · **Date:** 2026-11-15 · owner decisions L-1 and L-2 (2026-11-15).

- **Scope:** changes what work this repo accepts. It supersedes no earlier ADR: 0001–0014 remain
  the contract for how this app works and for any fix made to it.
- **Design record:** [`docs/reviews/2026-11-15-deep-review-rust-migration.md`](../reviews/2026-11-15-deep-review-rust-migration.md):
  the review findings, the Electron → Rust assessment, and the plan for the Rust version (§4).

## Context

The owner wants a Rust version of this app. A review on 2026-11-15 assessed how to get there. The
facts that shaped it:

- The Browser board depends on offscreen Chromium rendering plus CDP, so a system-webview shell
  cannot host it; Chromium stays in any version that keeps that board.
- The renderer (≈ 92K LOC) imports nothing from Electron or Node. Everything goes through one typed
  `window.api`, so it can be reused by another Chromium-based shell.
- MAIN is ≈ 54K LOC of TypeScript with 212 test files. A Rust backend re-implements that logic;
  it does not port mechanically.

The review first recommended moving MAIN's native pieces into Rust **inside this app**, one seam
at a time. The owner chose a different shape: keep this app intact as the legacy line and build
the Rust version as its own project.

## Decision

### L-1 — This repo is the legacy line; the Rust version is a separate project

> "make sure that electron is still a legacy project. Rust would be another version of it."

1. **No Rust in this repo.** No Rust code, no Cargo workspace, and no migration scaffolding added
   for the Rust version's benefit (bridge adapters, sidecar launch overrides, compatibility shims).
2. **The Rust version lives in its own repository.** Working location `M:\expanse\expanse-rs`; the
   name is not final.
3. **This repo is the reference implementation.** Its behaviour and its tests define parity for
   the Rust version. The Rust project reads this repo; it does not import from it at build time
   and never patches it.

### L-2 — Fixes only, from 2026-11-15

Accepted in this repo:

- bug fixes and security fixes;
- dependency and SCA upkeep, including Electron patch and security bumps;
- build, packaging, signing, release and CI upkeep;
- test and documentation corrections.

Not accepted without the owner's explicit word for that item: new board types, subsystems, MCP
tools, IPC namespaces, settings or UI surfaces, and refactors whose purpose is to enable them.

Working test for "is it a fix?": it restores behaviour that is documented, intended, or used to
work, and it adds no user-visible capability. When that is unclear, ask the owner once. (This test
is the ADR author's wording of L-2, not a separate owner decision; amend it if it proves wrong.)

Fix work follows the existing ritual unchanged: worktree branch, version bump, pre-commit gate,
manual dev check, PR, merge on the owner's word.

### Open when this was written

- **Feature lanes already in flight.** These branches existed when the freeze was called:
  `feat/ws7-confinement`, `feat/ws4-lifecycle`, `feat/ws8-context`, `feat/spatial-awareness`,
  `feat/swarm-mission-feed`. Whether each is finished and merged or parked is the owner's call,
  per lane. Ask before merging one.
- **Freeze point.** The commit `main` sits at once those lanes are settled. The Rust project takes
  its copy of the renderer from that commit; after it, only fix commits need carrying across.

## Alternatives rejected

- **Move pieces into Rust inside this app, one seam at a time.** Lower risk, and every step would
  have shipped inside the existing product. Rejected by the owner: the legacy line stays stable and
  untouched while the Rust version is built.
- **Convert this repo in place.** A big-bang port leaves no working product during the rewrite.

## Consequences

- **Version bumps are patch-only** from here. The existing rule reserves minor bumps for new board
  types, subsystems and epics, which L-2 excludes.
- **The feature roadmap is frozen for this repo.** `docs/roadmap.md`, `docs/roadmap-mcp.md` and
  `docs/feature-proposals.md` stay as input for the Rust version.
- **Schema versions should not move.** Fixes-only gives no reason to change `SCHEMA_VERSION` or
  `MIN_READER_VERSION`. The Rust version is planned to write the same `.canvas/canvas.json` and to
  stay readable by this app, so a fix that does need a schema change must say so in its PR.
- **Defects found while building the Rust version are fixed here through ordinary PRs**, never as
  part of Rust work. A fix to behaviour the Rust version has already ported is applied in both.
- **Open review findings remain valid fix work.** The design record's §2 lists them.
- `CLAUDE.md` carries a status section so every session sees this before starting work.

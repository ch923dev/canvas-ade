# Canvas ADE — docs

Map of the documentation. **Current-only**: stale per-slice plans, old phase handoffs, and
fixed-bug finding cards were collapsed into summary indexes on 2026-06-01 (git history retains
the originals). The authoritative *contract* is `../CLAUDE.md`; the authoritative *UX/visual*
contract is `../design-reference/`.

## What's here

| Path | Purpose | Live? |
|---|---|---|
| [`roadmap.md`](roadmap.md) | Phase-by-phase build order + status (Phases 0–4 shipped; Phase 5 = packaging). | ✅ live |
| [`roadmap-whiteboard.md`](roadmap-whiteboard.md) | Separate feature track — Excalidraw feature integration for the Planning whiteboard (W1–W5, shapes deferred). Parallel to the main roadmap. | ✅ live |
| [`feature-proposals.md`](feature-proposals.md) | Research-backed feature ideas (proposals only, nothing committed). | ✅ live |
| [`decisions/`](decisions/) | ADRs — `0001-stack.md` (React Flow / custom whiteboard), `0002-preview-gate.md` (WebContentsView). | ✅ live |
| [`reviews/`](reviews/) | All code reviews & bug hunts, newest first. [`reviews/README.md`](reviews/README.md) is the index; the newest dated file holds the **current open backlog**. | ✅ live |
| [`research/`](research/) | Standalone research notes (`self-smoke-testing.md`, `excalidraw-feature-borrowing.md`, `drawio-feature-borrowing.md`). | ✅ live |
| [`archive/`](archive/) | Historical record — `build-history.md` (phases + per-slice specs/plans + handoffs) and pointers to git for collapsed docs. | 🗄 history |

## Conventions

- **One purpose per folder.** New review/hunt → a dated file under `reviews/` + a row in
  `reviews/README.md`. New decision → an ADR under `decisions/`. Shipped build artifact → summarize
  in `archive/build-history.md`, don't keep the per-slice plan in the working tree.
- **Don't duplicate the contract.** Durable architecture/decisions live in `CLAUDE.md`; link to it,
  don't copy it.
- **Git is the archive.** Collapsed/old docs are recoverable via `git log --all -- <path>`; the
  working tree stays current-only.

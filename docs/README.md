# Canvas ADE — docs

Map of the documentation. **Current-only**: stale per-slice plans, old phase handoffs, and
fixed-bug finding cards were collapsed into summary indexes on 2026-06-01 (git history retains
the originals). The authoritative *contract* is `../CLAUDE.md`; the authoritative *UX/visual*
contract is `../design-reference/`.

## What's here

| Path | Purpose | Live? |
|---|---|---|
| [`roadmap.md`](roadmap.md) | Phase-by-phase build order + status (Phases 0–4 shipped + Post-Phase-4/in-flight; Phase 5 = packaging). | ✅ live |
| [`roadmap-drawio.md`](roadmap-drawio.md) | Separate feature track — draw.io diagram/dev-tooling integration (D1.1 shipped; D1.2/D2/D3 open). Shapes epic deferred. | ✅ live |
| [`feature-proposals.md`](feature-proposals.md) | Research-backed feature ideas (proposals only, nothing committed). | ✅ live |
| [`decisions/`](decisions/) | ADRs (durable contract) — stack, preview gate, LLM egress, … one file per decision. | ✅ live |
| [`reviews/`](reviews/) | All code reviews & bug hunts. [`reviews/README.md`](reviews/README.md) is the index; the newest dated file holds the current open backlog (none open as of Round-3). | ✅ live |
| [`research/`](research/) | Standalone research notes feeding the open feature tracks (draw.io borrowing, …). Shipped research is compiled into `archive/`. | ✅ live |
| [`testing/`](testing/) | [`testing/TESTING.md`](testing/TESTING.md) — living testing contract (tiers, Playwright `_electron`, pre-commit matrix). | ✅ live |
| [`archive/`](archive/) | Historical compiled build-logs — `build-history.md` (master) + the whiteboard, testing, and context initiatives. Plus git pointers for collapsed docs. | 🗄 history |

## Conventions

- **One purpose per folder.** New review/hunt → a dated file under `reviews/` + a row in
  `reviews/README.md`. New decision → an ADR under `decisions/`. Shipped build artifact → summarize
  in `archive/build-history.md`, don't keep the per-slice plan in the working tree.
- **Don't duplicate the contract.** Durable architecture/decisions live in `CLAUDE.md`; link to it,
  don't copy it.
- **Git is the archive.** Collapsed/old docs are recoverable via `git log --all -- <path>`; the
  working tree stays current-only.

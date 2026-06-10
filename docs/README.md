# Canvas ADE — docs

Map of the documentation. **Current-only**: stale per-slice plans, old phase handoffs, and
fixed-bug finding cards were collapsed into summary indexes (2026-06-01, 2026-06-04, 2026-06-10 —
git history retains the originals). The authoritative *contract* is `../CLAUDE.md`; the
authoritative *UX/visual* contract is `../design-reference/`.

## What's here

| Path | Purpose | Live? |
|---|---|---|
| [`roadmap.md`](roadmap.md) | Phase-by-phase build order + status (Phases 0–4 shipped + Post-Phase-4/in-flight; Phase 5 = packaging). | ✅ live |
| [`roadmap-mcp.md`](roadmap-mcp.md) | MCP swarm-layer track (M0–M5 shipped; M6–M10 planned). | ✅ live |
| [`roadmap-mcp-packaging.md`](roadmap-mcp-packaging.md) | How the `@expanse-ade/mcp` library reaches the app (dev `pnpm link` / release bundling / public npmjs publish). | ✅ live |
| [`roadmap-drawio.md`](roadmap-drawio.md) | Separate feature track — draw.io diagram/dev-tooling integration (D1.1 shipped; D1.2/D2/D3 open). Shapes epic deferred. | ✅ live |
| [`feature-proposals.md`](feature-proposals.md) | Research-backed feature ideas (proposals only, nothing committed). | ✅ live |
| [`decisions/`](decisions/) | ADRs (durable contract) — stack, preview gate, LLM egress, … one file per decision. | ✅ live |
| [`reviews/`](reviews/) | All code reviews & bug hunts. [`reviews/README.md`](reviews/README.md) is the index; the newest dated file holds the current open backlog (as of 2026-06-10: only the design/UX audit waves D2-D4 remain open). | ✅ live |
| [`research/`](research/) | Standalone research notes feeding the **open** feature tracks only. Shipped research is collapsed (git history). | ✅ live |
| [`superpowers/`](superpowers/) | Per-slice specs/plans/handoffs for **in-flight** work only. Shipped slices are collapsed to `archive/build-history.md` + git history. | ✅ live |
| [`contributing/`](contributing/) | Working agreements — [`file-size-doctrine.md`](contributing/file-size-doctrine.md) (the eslint `max-lines` ratchet). | ✅ live |
| [`testing/`](testing/) | [`testing/TESTING.md`](testing/TESTING.md) — living testing contract (tiers, Playwright `_electron`, pre-push matrix). | ✅ live |
| [`archive/`](archive/) | Historical compiled build-logs — `build-history.md` (master) + the whiteboard, testing, and context initiatives. Plus git pointers for collapsed docs. | 🗄 history |

## Conventions

- **One purpose per folder.** New review/hunt → a dated file under `reviews/` + a row in
  `reviews/README.md`. New decision → an ADR under `decisions/`. Shipped build artifact → summarize
  in `archive/build-history.md`, don't keep the per-slice plan in the working tree.
- **Don't duplicate the contract.** Durable architecture/decisions live in `CLAUDE.md`; link to it,
  don't copy it.
- **Git is the archive.** Collapsed/old docs are recoverable via `git log --all -- <path>`; the
  working tree stays current-only.

### Doc lifecycle (added 2026-06-10 — keeps the tree current-only without periodic big cleanups)

Every doc here is one of four kinds, each with a death condition:

| Kind | Lives in | Dies when |
|---|---|---|
| **Contract** (CLAUDE.md, ADRs, TESTING.md, file-size-doctrine) | root / `decisions/` / `testing/` / `contributing/` | superseded — mark + link the successor, never delete silently |
| **Tracker** (roadmaps, feature-proposals, the three READMEs-as-index) | `docs/` root, `reviews/README.md`, `archive/README.md` | never — but **update in the same PR** that changes what they track |
| **Slice artifact** (spec / plan / handoff / kickoff) | `superpowers/`, `reviews/*-kickoff` | **its PR merges** → delete the files in the merge PR (or next docs touch) + one line in `archive/build-history.md` |
| **Findings package** (bug-hunt cards, audit dumps, root-cause research) | `reviews/<date>-…/`, `research/` | **all findings fixed** → replace with a dated summary file + index row; raw cards to git history |

Rules of thumb:
- **Bug-hunt packages land under `docs/reviews/<date>-<name>/`** — never at repo root. (The
  bug-hunt skill defaults to root `bug-hunt-findings/`; move/point it at `docs/reviews/` when
  invoking, or collapse on fix-merge.)
- **Indexes update in the same PR** that adds/removes an indexed file (`docs/README.md`,
  `reviews/README.md`, `archive/README.md`).
- **No point-in-time SHAs in trackers** — say "current `main`" or link `archive/build-history.md`;
  pinned SHAs rot in days. (Exception: shipped-history entries, where the SHA *is* the record.)
- **Research docs carry a `Status:` line** at the top (what open track they feed). When that track
  ships, collapse the doc into the build-log entry.

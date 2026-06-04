# docs/archive — historical record

Point-in-time docs kept for history. **Not current. Do not treat as live truth.** The durable
contract is `CLAUDE.md`; the build order + status is `docs/roadmap.md`; review/bug-hunt history
is `docs/reviews/README.md`.

- [`build-history.md`](build-history.md) — **master** build-log: phases 0–4 + Post-Phase-4 work, with
  pointers to the per-initiative build-logs below and to git for collapsed per-slice docs.
- [`2026-06-03-whiteboard-epic.md`](2026-06-03-whiteboard-epic.md) — compiled W1–W5 whiteboard track
  (eraser/select/align/image/export); shapes epic deferred. Collapsed `roadmap-whiteboard.md` + plans/specs.
- [`2026-06-03-testing-strategy-initiative.md`](2026-06-03-testing-strategy-initiative.md) — compiled
  T0–T5 testing overhaul (Playwright `_electron` + pre-commit matrix). Living contract: `testing/TESTING.md`.
- [`2026-06-04-context-subsystem.md`](2026-06-04-context-subsystem.md) — compiled Context subsystem build-log
  (M-digest + M-brain + M-memory, PR #39). Collapsed `roadmap-context.md` + plans/specs/handoffs.

Older raw docs were collapsed into the summaries above (2026-06-01 and 2026-06-04) and removed from the
working tree (git history retains them):

- **Round-1 bug hunt** (2026-05-30): `bug-hunt-findings.md` (50 findings) · `bug-triage.md` (lots A–F)
  · `features-and-testables.md`. Now summarized in `docs/reviews/README.md` › Round-1.
- **Per-slice specs/plans/research** under `docs/superpowers/` and **phase handoffs** under
  `docs/handoffs/`. Now summarized in `build-history.md`.

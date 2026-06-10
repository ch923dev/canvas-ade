# 2026-06-10 — Full-app audit (bug-hunt expedition) — ALL 72 FIXED

> Summary index. The raw package (`bug-hunt-findings/` at repo root: INDEX · FIX-REPORT ·
> `findings/BUG-001..072.md` · skipped-roadmap · unconfirmed) was collapsed to git history on
> 2026-06-10 during the docs reconcile. Recover via
> `git log --all --oneline -- bug-hunt-findings/` (package landed with PR #107, squash `cd1ac61`).

## Outcome

- **Scope:** whole app (`src/**` + preload + build/CI config) @ main `f32a505`.
- **Confirmed in-scope:** **72** (0 Critical · 4 High · 14 Medium · 54 Low) + 1 roadmap-skipped
  + 7 unconfirmed (untouched by design).
- **Fixed:** **72/72**, merged via **PR #107** (squash `cd1ac61`) on 2026-06-10, plus the
  **BUG-069 re-land** via **PR #109** (`1230b7f` — workflow-edit PRs gate on the `check` job only;
  the claude-review bot 401s there by design).
- **Method:** 4 fix waves (8+3+4+1 file-disjoint cluster agents) + an adversarial verify pass
  (refute-by-default, 4 agents) over all 72 fixes; 5 concerns resolved by amendment `81365b6`.
- **Gates:** full gate green after every wave; final suite **1906/1906 unit+integration**
  (+~130 regression tests over the 1774 baseline); e2e matrix green both legs at hand-off.
- **Review:** 6 automated review rounds on #107, 12 inline findings all dispositioned.

## Highs (for the record)

| ID | Title |
|---|---|
| BUG-001 | `flushRenderer` touched destroyed-window `webContents` — window-close quit on Win/Linux threw into the crash sink |
| BUG-002 | Recap transcript egress not consent-gated — revoking consent did not stop transcript reads + LLM egress |
| BUG-003 | Packaged-build recap hook doubly broken (`process.execPath` without `ELECTRON_RUN_AS_NODE` + script path inside `app.asar`) |
| BUG-004 | First tracked edit after undo/redo skipped its checkpoint — next undo jumped two steps, losing a state |

## Deferred to roadmap (not in the fix run)

- **Phase 5 packaging** carries the roadmap-skipped finding (electron-builder `publish: null`
  silently nullifies `--publish always`) and the related packaged-only residue of BUG-003 and
  BUG-071 (renderer deps double-shipped into `app.asar`) — all noted inline in
  `docs/roadmap.md` › Phase 5.

## Related

- **2026-06-10 design/UX audit** (separate run, same day): lives on branch `feat/design-audit`
  (`docs/reviews/2026-06-10-design-ux-audit{,-waves}.md` there); Wave D0 quick wins merged via
  **PR #108** (`146fc76`). Remaining waves tracked on that branch until merged.

# Reviews & bug hunts — consolidated index

Every code review / bug-hunt run on Canvas ADE, newest first. Each round's **full
finding cards live in git history** (this repo keeps current-only docs; the individual
cards were collapsed here on 2026-06-01 during the docs centralization). To recover a
round's raw cards: `git log --all --oneline -- <path-listed-below>` then check out that
path at the commit shown.

**Current open findings** (anything not yet fixed) live in the newest dated review file
in this folder — start there, not in the tables below.

| # | File / status |
|---|---|
| Round 3 — in-depth (2026-06-01) | [`2026-06-01-round3.md`](2026-06-01-round3.md) — **current open backlog** |

---

## Round 3 — in-depth review (2026-06-01)

- **Method:** 6-dimension parallel subagent audit (security/IPC · PTY · preview · persistence ·
  canvas-state/camera/edges · whiteboard) with adversarial self-refutation per finding.
- **Findings:** see [`2026-06-01-round3.md`](2026-06-01-round3.md). Verdict: healthy, no Critical/High.
- **Status:** the live open backlog. Not yet fixed unless that file says so.

## Round-2 review (2026-06-01) — 9-dimension workflow + adversarial verify

- **Method:** 9 dimensions, 44 agents (opus finders + per-candidate refuter). ~35 raw → **9 survived**.
- **Outcome:** no High. PTY-1 (Medium, parked-PTY leak on switch), PREV-1/ATTACH-1/PERSIST-1/SAVE-1
  (Low), NOTE-1/TEXT-1 (Nit). SEC-NIT-1 / DISPOSE-NIT-1 refuted to clarity/logging notes.
- **Fixed:** all 7 actionable findings on `fix/review-2026-06-01-round2` → merged **`1a0c615`**
  (11 new unit tests, 438 total green; e2e 22/25, the 3 = browser-trio env flake).
- **Raw cards (git history):** `docs/bug-hunt-findings/2026-06-01-review-2/` (INDEX + 9 cards).

## In-depth review (2026-06-01) — hybrid workflow, 7-dim gap sweep

- **Method:** 40 prior cards re-verified adversarially + a 7-dimension fresh sweep (49 agents),
  then cross-checked against `main` `ed1d551`. Baseline `ed1d551` = 412 tests green.
- **Outcome (as reviewed on `abd7fa2`):** 62 actionable — **1 High (MBC-1**, full-view-delete
  leaves `fullViewId` stale → closes all live Browser renderers**) · 10 Medium · ~40 Low · ~11 Info**.
- **Fixed:** PR **#12 / `ed1d551`** ("Fix 13 verified bugs") closed 6 (PREV-1, NEW-CAM-3/4, STATE-3,
  PERS-1/2) and partially addressed 6 more; `94baab9` then closed 4 open-medium MANUAL-VERIFY items
  (M-1 MAX_LIVE cap · M-5 shell allowlist · M-6 teardown frame-guard · M-7). Residual backlog rolls
  into Round 3 (above) — that's where any still-live MBC-1 / FV / a11y items are tracked.
- **Raw cards (git history):** `docs/bug-hunt-findings/2026-06-01-indepth-review/`
  (INDEX · MANUAL-VERIFY · ~27 NEW-* cards).

## Round-2 hunt (2026-05-30) — adversarial dynamic-workflow hunt

- **Method:** 17 discovery agents → independent refuter per candidate (2nd refuter for High/Critical).
  **78 candidates → 42 confirmed → 33 in-scope** (1 skipped to roadmap, rest deduped). Most were
  incomplete remediations of the Round-1 hunt.
- **Severity:** 1 High (unguarded `proc.write/resize` on exited PTY → app crash) · 13 Medium · 19 Low.
- **Fixed:** all 33 on `fix/bug-hunt-batch` (one commit per bug; 6 file-disjoint lanes + 4 bridge
  cards), merged as PR **#3**. 240 tests green + 15 new regression tests; every fix adversarially
  re-verified. 23 unconfirmed candidates + 1 roadmap-deferred item were left untouched by design.
- **Raw cards (git history):** `bug-hunt-findings/` at repo root (INDEX · FIX-REPORT ·
  skipped-roadmap · unconfirmed · `findings/BUG-001..033.md`).

## Round-1 hunt (2026-05-30) — first 50-bug adversarial hunt

- **Method:** 89-agent features-and-testables + bug-hunt workflow. **78 candidates → 50 confirmed.**
  Partitioned into file-disjoint fix lots A–F. The headline occlusion concern (native view paints
  over HTML) was later RESOLVED via node-drag/resize detach+snapshot.
- **Fixed / superseded:** most Round-1 findings were re-checked and remediated by the Round-2 hunt
  (above). Archived 2026-05-30 (PR **#4 / `63cc157`**).
- **Raw docs (git history):** `docs/archive/bug-hunt-findings.md` (50 findings) · `bug-triage.md`
  (lots A–F) · `features-and-testables.md` (72 features / 74 testables).

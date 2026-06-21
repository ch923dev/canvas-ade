# Reviews & bug hunts — consolidated index

Every code review / bug-hunt run on Canvas ADE, newest first. Each round's **full
finding cards live in git history** (this repo keeps current-only docs; raw cards are
collapsed into a dated summary here once every finding is fixed). To recover a
round's raw cards: `git log --all --oneline -- <path-listed-below>` then check out that
path at the commit shown.

**No open review backlog.** The **2026-06-19 feature-improvement audit** (the last open round) is
**COMPLETE** — all 43 confirmed findings dispositioned across the file-disjoint **"PA" remediation
umbrella** (10 slices PA-1…PA-10 + the PA-R lint ratchet), every slice merged, full gate + e2e matrix
green at each merge. Summary: [`2026-06-19-feature-audit.md`](2026-06-19-feature-audit.md).

Every prior **CODE review/bug-hunt round is fully remediated**, including the **2026-06-15 codebase bug
hunt** (16 findings — 1 High · 2 Med · 13 Low — all fixed), the 2026-06-13 DX audit (process track,
COMPLETE #131/#132/#144/#145/#148), the 2026-06-10 full-app audit (72 findings, #107 + #109), and the
**2026-06-10 design/UX audit umbrella, COMPLETE 2026-06-12** (D0 #108 · D1 #111/#112/#113 ·
D2 #114/#115/#116/#117 · D3 #118/#119/#120 · D4 #121/#123/#124). When the next review run happens, add a
dated file here and update this line.

| # | File / status |
|---|---|
| Feature-improvement audit (2026-06-19) | [`2026-06-19-feature-audit.md`](2026-06-19-feature-audit.md) — forward-looking perf/UX/a11y/code-quality audit of all shipped-on-`main` features (excludes File Tree + Command Board per user). Adversarial multi-agent verify: 52 raw → **43 confirmed** (3 High · 17 Med · 23 Low) + 7 verify-first terminal notes. Decomposed into the file-disjoint **"PA" remediation umbrella** (10 slices PA-1…PA-10 + the PA-R lint ratchet). **✅ COMPLETE** — all slices merged (#186/#190/#195/#196/#197/#199/#200/#202/#203 + PA-R), every finding fixed or consciously deferred. Raw package (`2026-06-19-feature-audit/`) collapsed to git history. |
| Bug hunt (2026-06-15) | [`2026-06-15-bug-hunt/`](2026-06-15-bug-hunt/) — 16 confirmed (1 High · 2 Med · 13 Low · 0 Crit), **all fixed**. 18 file-disjoint discovery slices → an independent adversarial verifier per candidate (44 agents; 25 candidates → 16). High = recap-watcher app-crash guard; the MCP-cluster fix closes the live-agent handoff-barrier gap (per-task settle). Verified: gate 2550/2550 + full e2e matrix (Win 127 · Linux 126+1skip). Raw cards + [`FIX-REPORT.md`](2026-06-15-bug-hunt/FIX-REPORT.md) in the package. |
| Electron-to-Flutter assessment + OSR spike (2026-06-14) | [`2026-06-14-electron-to-flutter-assessment/`](2026-06-14-electron-to-flutter-assessment/) - 20-agent NO-GO-on-Flutter feasibility study; recommended the offscreen-to-canvas preview spike, SHIPPED flag-gated #151 (proving native-view occlusion is fixable IN Electron). Open productionization tracked as OS-3 in [`../feature-proposals.md`](../feature-proposals.md). |
| DX & code-quality audit (2026-06-13) | [`2026-06-13-dx-audit.md`](2026-06-13-dx-audit.md) — process audit (review noise · pre-push e2e cost · architecture · testing): the two pain points multiply (each review round re-pays the full 2-OS matrix + a full re-review). 5-PR plan, all slices landed: PR-1 reviewer tuning **MERGED #131** · PR-2 pre-push Linux-leg path-gating (Option B, local) **MERGED #132** · PR-3 e2e tags + path-scoped selection **MERGED #144** · PR-4 e2e thinning **MERGED #145** · PR-5 `e2e/mcp.e2e.ts` port — retires the last `CANVAS_SMOKE` harness — **MERGED #148** (`7bfb093`). The per-slice plan doc was deleted by PR-5 (doc-lifecycle: a plan dies with its last slice). |
| Full-app audit (2026-06-10) | [`2026-06-10-full-app-audit.md`](2026-06-10-full-app-audit.md) — 72 confirmed (0 Crit · 4 High · 14 Med · 54 Low), **all fixed** #107 (`cd1ac61`) + BUG-069 re-land #109. Raw package: `bug-hunt-findings/` at repo root, collapsed to git history. |
| Design/UX audit (2026-06-10) | 6-agent full-renderer design review vs the DESIGN.md contract: 1 data-loss-class High (silent save failure), discoverability + feedback-channel gaps, 13 a11y items, token-violation cluster in modals, ghost token `--text-1`. **CLOSED - umbrella complete 2026-06-12** (D0 #108 / D1 #111/#112/#113 / D2 #114/#115/#116/#117 / D3 #118/#119/#120 / D4 #121/#123/#124). Raw audit + wave plan collapsed to git history; compiled residue: [`../archive/2026-06-15-docs-hygiene-sweep.md`](../archive/2026-06-15-docs-hygiene-sweep.md). |
| Bug hunt (2026-06-07) | 42 confirmed (6 Med · 36 Low), **all fixed** #85 (`aede88f`). Raw package: `bug-hunt-findings/` at repo root at the time, git history (`ae807dc` = findings, `d25305a`/`1d9b155`/`3c6a8b1` = fix batches). No separate summary file — commit messages are the record. |
| In-depth - MCP layer (2026-06-05) | Healthy, no open Crit/High/Med; all 2026-06-04 MCP fixes verified real, Host-header gap closed; 3 new LOW/INFO (APP-N1/N2/N3 -> #68; PKG-N1 -> #146, PKG-N2 -> #148). Raw review collapsed to git history; compiled residue: [`../archive/2026-06-15-docs-hygiene-sweep.md`](../archive/2026-06-15-docs-hygiene-sweep.md). |
| Kickoffs (2026-06-05, historical) | `post-t9` · `remaining` · `wave5-b4-b5` — point-in-time tackle plans, **fully executed** (#53/#59/#60/#61–67) and collapsed to git history 2026-06-10. |
| Consolidated backlog (2026-06-04) | [`2026-06-04-CONSOLIDATED-backlog.md`](2026-06-04-CONSOLIDATED-backlog.md) — merges Audit A + Hunt B into one ordered Wave 0–5 tackle plan. **All waves shipped.** |
| Audit A — full main audit (2026-06-04) | 12-dimension broad sweep, 58 confirmed (4H · 8M · 34L · 12I), 0 Critical. All actioned via the consolidated waves (#45–#67). Raw doc (`2026-06-04-main-branch-full-audit.md`, 2066 lines) collapsed to git history 2026-06-10. |
| Hunt B — MCP+Context bug hunt (2026-06-04) | Deep+narrow Context/MCP hunt, 28 cards (2H · 8M · 18L), 0 Critical, **all fixed** #45/#47/#48. Raw package (`2026-06-04-mcp-context-bughunt/`) collapsed to git history 2026-06-10. |
| MCP status audit (2026-06-03) | Read-only status snapshot, superseded by the #43–#49 merges + the 2026-06-05 in-depth review. Collapsed to git history 2026-06-10 (`2026-06-03-mcp-status-audit.md`). |
| Round 3 — in-depth (2026-06-01) | [`2026-06-01-round3.md`](2026-06-01-round3.md) — **ALL CLEARED** (`fix/round3-backlog` 9 fixed + `fix/round3-lows-remainder` final 3: PREV-A was already fixed by PR #14, PERSIST-B + PERSIST-C fixed). No open findings. |

---

## Round 3 — in-depth review (2026-06-01)

- **Method:** 6-dimension parallel subagent audit (security/IPC · PTY · preview · persistence ·
  canvas-state/camera/edges · whiteboard) with adversarial self-refutation per finding.
- **Findings:** see [`2026-06-01-round3.md`](2026-06-01-round3.md). Verdict: healthy, no Critical/High.
- **Status:** **ALL 12 cleared.** 9 fixed on `fix/round3-backlog` (2026-06-02; +8 unit tests,
  490 green, e2e 25/25); the final 3 on `fix/round3-lows-remainder` (2026-06-02): **PREV-A** was
  already resolved by PR #14's fullview-reset refactor (no change needed), **PERSIST-B** + **PERSIST-C**
  fixed (+4 unit tests, 499 green). See that file's two Resolution banners.

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

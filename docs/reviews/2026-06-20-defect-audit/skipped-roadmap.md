# Roadmap reconciliation — skipped findings

**Reconciliation target(s):** `docs/roadmap.md` (auto-detected) **+** the open `docs/reviews/2026-06-19-feature-audit/`
"PA" remediation backlog (43 confirmed perf/a11y/UX/styling findings, decomposed into the PA-1…PA-10 + PA-R
umbrella). Both were treated as "planned work" for the skip test.

## Outcome: **0 of 15 confirmed findings are skipped.**

Every confirmed finding was checked against both targets. **None is fully fixed by any planned/in-flight
work**, so all 15 remain in [`INDEX.md`](INDEX.md) and **no edit was made to `docs/roadmap.md`** (the goal
mandates roadmap annotation only for findings that *are* skipped — there are none).

Why nothing qualified for a skip:

- **The PA-43 backlog is a different class.** The 2026-06-19 audit was explicitly an *improvement* audit
  (per-frame re-renders, missing `aria-*`, silent-save/timer/toast feedback, raw-literal token drift,
  ~770-line god-files). Its own report states *"No new correctness, security, or data-loss findings
  emerged."* This audit deliberately targets the **defect** dimensions it did not. There is **zero overlap**
  in finding identity — no FIND-00x corresponds to any PA-x item.
- **`docs/roadmap.md` carries no item that fixes any of these.** The roadmap is feature/phase-oriented
  (Phases 0–5 + post-phase shipped work); it does not schedule any of these specific defects.

## Adjacency notes (NOT skips — kept in the queue, recorded for the fixer's context)

These confirmed findings sit *near* in-flight or recently-shipped work but are **defects in already-merged
code**, not items a planned task will close — so they stay in the queue:

| Finding | Adjacent work | Why it is still KEPT (not skipped) |
|---|---|---|
| **FIND-001** (bearer token on disk after revoke) · **FIND-008** (non-atomic CLI-config write) · **FIND-015** (in-memory token never revoked) | **Agent Orchestration Onboarding** lane (P1/P2/P3/P5; provisioners landed `33923450`, memory `agent-orch-provision`). The PLAN §6 invariants ("unsync on disable", "0o600", atomic) are the *design contract*. | These are **bugs in the already-merged P3 provisioner implementation** of that contract — the remaining planned P-slices (P5 etc.) do not target token-cleanup-on-revoke, board-cwd unsync, in-memory revoke, or atomic config writes. No planned task fixes them → keep. |
| **FIND-002** (FileBoard lost-update) · the File Tree board generally | File Tree epic (#201) is shipped; no open roadmap slice. | Shipped code, no planned follow-up that addresses concurrent-edit safety → keep. |
| **FIND-005 / FIND-006** (Command Board dispatch races) | Command Board (#182) is shipped + iterated separately (it was *excluded* from the PA audit "per user directive"). | Exclusion from the *improvement* audit is not remediation; no planned task fixes these concurrency defects → keep. The user-directive exclusion is noted but does not remove them from a **defect** audit (the `/goal` scope is "all source"). |

## Reconciliation of the *unconfirmed* set vs the roadmap (for completeness)

Two **unconfirmed** candidates touched roadmap territory (Phase 5 packaging) but were **refuted**, so they are
in [`unconfirmed.md`](unconfirmed.md), not here, and warrant no roadmap change:

- *Auto-update not coupled to signing-secret presence* (`production.yml`) — refuted: the unsigned-build guard is
  compiler-enforced (ADR 0008); `AUTO_UPDATE` is a deliberate manual last step. Phase 5 is already the roadmap's
  open release blocker; nothing to annotate.
- *SCA `pnpm audit` only on PRs* (`production.yml`/`staging.yml`) — refuted: the locked tree is monitored weekly
  by Dependabot + CodeQL schedules; redundant belt-and-suspenders, not a gap.

---

*No silent skips: every confirmed finding is in the queue; every non-queued candidate is in `unconfirmed.md`
with a refutation reason. `docs/roadmap.md` was intentionally left unmodified because no finding was skipped.*

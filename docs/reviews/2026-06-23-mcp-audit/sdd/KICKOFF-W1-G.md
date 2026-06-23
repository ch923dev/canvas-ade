# KICKOFF — W1-G coordinated package+app primitive release

**Branch:** `feat/mcp-w1g-primitives` · **Base:** umbrella `feat/mcp-integration` @ `ed547f9d` (= main + W1-A + W1-F)
**Worktree:** `Z:\Canvas ADE\.worktrees\w1g-primitives` · **Spec:** [`specs/SPEC-W1-G-coordinated-primitive-release.md`](specs/SPEC-W1-G-coordinated-primitive-release.md)

W1-G is the LAST Wave-1 slice: a **lockstep package + app** change. Read the full spec — this kickoff
only records the corrections to the spec's stale assumptions and the exact sequencing.

## What ships

| ID | Change | Repo |
|---|---|---|
| **C1** | wire-register `canvas://app-model` (orchestrator-tier read-only resource) | pkg + app |
| **C2-wire** | wire-register `spawn_group` (orchestrator-tier tool) | pkg + app |
| **C3** | `write_result` Zod `.max()` caps (summary 100k · refs ≤256 × ≤256 chars) — closes BUG-009 at the protocol layer | pkg |
| **F11** | drop `SCOPE_ANSWER_PERMISSION` from `ORCHESTRATOR_SCOPES` (premature grant for the not-yet-built M8 tool) | pkg |
| **F25** | `APP_TOOLS` drift-guard test (assert catalog == what `ServerFactory` registers) + add `spawn_group` to the catalog | app |

## Corrections to the spec (verified against the live repo state — apply these)

1. **Package version is `0.15.0`, NOT the spec's `v0.14.0`.** `@expanse-ade/mcp@0.14.0` is ALREADY
   PUBLISHED — it shipped with W1-F (prompts substrate, #228). The app already pins `^0.14.0`
   (`package.json`). W1-G's package bump is therefore **minor → `0.15.0`**, and the app dep moves
   `^0.14.0` → `^0.15.0`.
2. **W1-F prompts are already in 0.14.0**, so the spec §9 "co-release with W1-F" opportunity is moot.
   W1-G's package PR is purely **C1 + C2 + C3 + F11 → 0.15.0**.
3. **Dependency gate is GREEN.** The spec's two hard prerequisites are satisfied:
   - W1-B (`spawnGroup` sanitizer, F5) — ✅ on `main` (`acced9ec`, #223). Wiring `spawn_group` over the
     wire on top of the sanitized MAIN path is now safe.
   - W1-F (prompts) — ✅ in the umbrella base (pkg 0.14.0 adopted at `822b2f26`).
4. **Install drift to reconcile (do this from MAIN, never a worktree):** the shared `node_modules`
   currently has `@expanse-ade/mcp@0.13.0` installed even though the umbrella's `package.json` pins
   `^0.14.0` (W1-F bumped the pin but the MAIN install was not re-run). When you bump to `^0.15.0`,
   run `pnpm install` **from `Z:\Canvas ADE` (MAIN), not this worktree** (memory:
   `worktree-pnpm-install-recreates-shared-tree`) — it reconciles 0.13.0 → 0.15.0 in one step. Confirm
   the umbrella still typechecks against the actually-installed version as a sanity check.

## Sequencing — LOCKSTEP, non-negotiable (spec §8)

The package publish MUST land on npm before the app PR bumps the dep; otherwise the app's
`LifecycleOrchestrator` won't satisfy the extended `Orchestrator` interface and CI typecheck fails.

**PR 1 — package** (`@expanse-ade/mcp`, sibling repo `Z:\canvas-ade-mcp`):
1. C3: add `.max()` to `write_result` `inputSchema` + unit tests.
2. F11: remove `SCOPE_ANSWER_PERMISSION` from `ORCHESTRATOR_SCOPES` (keep the constant defined) +
   scope-table test.
3. C1: `registerAppModelResource` + extend `Orchestrator` with `describeApp(): Promise<unknown>` +
   register in `ServerFactory` orchestrator-tier block.
4. C2: `registerSpawnGroup` + `SpawnGroupInput`/`SpawnGroupResult` types + extend `Orchestrator` with
   `spawnGroup(...)` + register in the orchestrator-tier block.
5. Bump to `0.15.0`, push tag `v0.15.0` → `publish.yml` (OIDC trusted publishing, no token — memory:
   `mcp-publish-gating`). Wait for `@expanse-ade/mcp@0.15.0` to appear on npm before opening PR 2.

**PR 2 — app** (this branch, off the umbrella):
1. `package.json`: `@expanse-ade/mcp` `^0.14.0` → `^0.15.0`; `pnpm install` **from MAIN**.
2. Typecheck-only verification that `buildOrchestrator`'s return type satisfies the new interface
   (`describeApp`/`spawnGroup` are already implemented in `mcpOrchestrator.ts` — no new MAIN code).
3. `src/main/appModel.ts`: add `spawn_group` to `APP_TOOLS` (tier `orchestrator`) + to the terminal
   entry's `APP_BOARD_TYPES.tools`.
4. `src/main/appModelDrift.test.ts` (NEW): F25 drift guard — tool-set equality vs `ServerFactory`.
5. Live `@mcp` e2e probes in `e2e/mcp.e2e.ts`: `canvas://app-model` read · `spawn_group` call ·
   `write_result` oversized rejection.

## Invariants — do NOT relax (spec §8)

- `spawn_group` + `canvas://app-model` are **orchestrator-tier only** (bounds swarm growth).
- The MAIN belt-and-suspenders `write_result` clamps (`mcpOrchestrator.ts` `WRITE_RESULT_MAX_*`) STAY —
  C3 is defense-in-depth at the protocol layer, not a replacement.
- `SCOPE_ANSWER_PERMISSION` the constant stays defined; only its membership in the orchestrator default
  array is removed.

## Gate / merge

- W1-G's own app PR gates on the CI `check` job + a title-stamped manual dev check.
- The **full e2e matrix (both legs)** is owed once at the **umbrella → main** gate (this slice rides the
  umbrella into main; it does not merge to main on its own).
- `gh` active account must be `ch923dev` for any push to the app repo (memory: `gh-account-push-access`).

## This slice gates Wave 2

SPEC-W2-S2 (the canvas-ade primer) generates its catalog from `APP_TOOLS` and validates against the
registered tool list — both `spawn_group` and `canvas://app-model` must be registered + cataloged
before S2 is written. W1-G is a hard gate on S2.

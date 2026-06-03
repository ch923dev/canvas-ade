# Handoff — M-brain T-B3 (per-day budget guard + egress ADR + IPC split)

**Date:** 2026-06-03 · **Branch:** `feat/context-b3-budget-egress` (off `feat/context`) · **Status:** DONE, full gate green, final holistic security review APPROVED, ready to squash-merge.
**Plan:** `docs/superpowers/plans/2026-06-03-context-b3-budget-egress.md` · **Predecessor:** T-B2 handoff `2026-06-03-context-b2-keystore.md` · **Roadmap:** `docs/roadmap-context.md` › M-brain › T-B3 · **ADR:** `docs/decisions/0003-llm-egress.md`.

## What shipped

A **per-calendar-day CALL budget** now caps LLM spend. `runSummarize` reserves one call (before the single outbound `fetch`) via a new `BudgetStore`; over the cap it returns the typed `{ok:false, reason:'budget-exceeded'}` and the app falls back to Tier-1 — it never throws. The cap is `maxCallsPerDay` in `llm-config.json` (default **200/day**, `DEFAULT_MAX_CALLS_PER_DAY`); the running counter lives in `userData/llm-budget.json` (atomic, per-day reset), **never** a project folder. The **one new outbound egress** (MAIN→LLM) is now documented in **ADR 0003** (opt-in, isolated, capped, passive output, security posture unchanged). While here, the **IPC layer was split** out of `llmService.ts` into a new `llmIpc.ts`, leaving `llmService.ts` as the pure provider engine.

### Enforcement rule (the load-bearing subtlety)
`shouldEnforceBudget(config, env)` = `isMockEnabled(env) ? config.maxCallsPerDay !== undefined : true`.
- **Real egress → always enforced** (cap = `config.maxCallsPerDay ?? 200`).
- **Mock seam (`CANVAS_SMOKE=e2e` / `CANVAS_LLM_MOCK=1`) → enforced only when an explicit cap is set.** So CI/e2e stays uncapped unless a probe opts in by setting a cap. This keeps the existing `context-brain` probe green and lets the new `context-budget` probe drive the cap.

Reservation is **before egress** and **not refunded** on a later provider error (count attempts, fail-closed) — a runaway loop degrades to Tier-1 rather than overspending.

## Files

- **`src/main/llmBudget.ts`** (+test) — NEW. `createBudgetStore(userDataDir, clock)` → `{tryConsume(cap), peek()}`; `dayKey` (local YYYY-MM-DD), `DEFAULT_MAX_CALLS_PER_DAY=200`. Persists `{day, calls}` to `userData/llm-budget.json` (atomic `write-file-atomic`, `mkdirSync` guard). Electron-free (injected clock) → unit-tested without Electron, mirroring `llmKeyStore`/`llmConfig`. New day / missing / corrupt → resets to 0 (never throws). Blocked `tryConsume` writes nothing.
- **`src/main/llmConfig.ts`** (+test) — `LlmConfig` gains `maxCallsPerDay?: number`; `readLlmConfig` validates (finite, `>=0`, floored) else `undefined`. `writeLlmConfig` unchanged (serializes the whole object). Key-free invariant holds.
- **`src/main/llmService.ts`** (+test) — `SummarizeResult` gains `budget-exceeded`; `ProviderDeps` gains `budget?: BudgetStore`; new exported `shouldEnforceBudget`; `runSummarize` reserves a call (pre-fetch) when `deps.budget && shouldEnforceBudget(...)`. Stays total (never throws). **IPC region removed** (moved to `llmIpc.ts`).
- **`src/main/llmIpc.ts`** (+test) — NEW. The IPC layer split out of `llmService.ts`: `isForeignSender`, `LlmStatus`, `LlmWriteResult`, `NOOP_KEY_STORE`, `registerLlmHandlers`. The handler always builds a real `createBudgetStore(userDataDir, () => new Date())` into `deps.budget` (so the cap is live in production); `setConfig` carries `maxCallsPerDay`. All 5 channels foreign-sender-guarded.
- **`src/main/index.ts`** — imports `registerLlmHandlers` from `./llmIpc` (was `./llmService`); `runSummarize`/`defaultDeps` still from `./llmService`.
- **`src/preload/index.ts`** — `LlmSummarizeResult` mirror gains `budget-exceeded`; `setConfig` bridge arg gains `maxCallsPerDay?`.
- **`src/main/e2e/probes/budget.ts`** (+`e2e/index.ts` playlist) — NEW `context-budget` probe (runs after `contextBrain`): `setConfig({maxCallsPerDay:1})` → drives summarize past the cap → asserts `budget-exceeded` surfaces, the app stays usable (`status().hasProvider` + Tier-1 digest cards present), and `llm-budget.json` lives in `CANVAS_E2E_LLM_DIR`; restores an uncapped config.
- **`docs/decisions/0003-llm-egress.md`** — NEW ADR (egress contract).

## The IPC contract (T-B3 addition)

`setConfig` now carries the cap; the summarize result gains one variant. No new key/secret crosses IPC.
```ts
llm.setConfig({ provider, model, baseUrl?, maxCallsPerDay? }) → { ok: true } | { ok: false, reason: 'forbidden' }
llm.summarize(input) → { ok:true, text } | { ok:false, reason:'no-provider' } | { ok:false, reason:'budget-exceeded' } | { ok:false, reason:'provider-error', message }
```

## Security model

- **Egress stays opt-in** — no key (non-`local`) → `getProvider` null → `no-provider` → no fetch. The budget doesn't change this.
- **Cap cannot be bypassed on the renderer-reachable path** — `registerLlmHandlers` always builds a real budget store, so `deps.budget` is never undefined in production; real egress always enforces; foreign senders are rejected before `runSummarize`.
- **No new secret on disk/IPC** — `llm-budget.json` holds only `{day, calls}` (test asserts no key material); counter in `userData` only; no `llm:*` return type carries the key.
- `contextIsolation`/`sandbox`/`nodeIntegration` untouched (not in the diff).

## Gate (all green)

- typecheck clean · lint 0 errors (1 pre-existing `PlanningBoard.tsx` no-console warning, unrelated) · format:check clean · **682 unit tests / 51 files** (T-B3 added ~22: 8 budget store, 3 config cap, 6 runSummarize-budget incl. cap-value pins, 1 IPC budget round-trip, + the IPC split's net-zero move) · build OK.
- e2e (`CANVAS_SMOKE=e2e`): **`E2E_CONTEXT-BUDGET {"ok":true, detail:"second={ok:false,reason:budget-exceeded} cards=7 counterInTempDir=true"}`**. `E2E_DONE` showed `ok:false` **only** because of the known `browser`/`browser-gesture`/`focus-detach` `capturePage` env flake on a contended host (memory `e2e-browser-trio-flake`) — every context/keystore probe is green; not a regression.

## Reviews

Per-task two-stage review (spec compliance + code quality) + a final holistic **security** review (APPROVE FOR MERGE). Fixes folded inline: Task-4 review added a cap-value assertion (pins that real egress with no config cap passes 200, and a configured cap wins) + documented the no-refund-on-error semantic. Final review found one **Low**: the operator-only `CANVAS_LLM_PING` dev probe (`index.ts`, env-gated, one call/start, not renderer-reachable) runs **unbudgeted** — pre-existing from T-B1; now noted as an explicit exemption in ADR 0003 §3. No Critical/High/Medium.

## Follow-ups (not gating)

- `CANVAS_LLM_PING` dev-ping is unbudgeted (ADR-noted exemption). If ever promoted beyond a manual smoke, wire a budget into it.
- **Token-dimension cap deferred** — v1 is a call cap (deterministic, always available); token caps would need per-provider response-usage plumbing.
- `isForeignSender` now has a 4th per-module copy (pty/preview/project/llm) — consolidation still a separate refactor, intentionally deferred.

## Next — M-memory T-M1 (`.canvas/` engine: paths + atomic writers)

M-brain is complete (T-B1 ✅ · T-B2 ✅ · T-B3 ✅). Next milestone is **M-memory** — the persistent `.canvas/memory/` engine + the Tier-2 autonomous summarize-on-change loop that finally USES this budgeted brain. Start at **T-M1** (`src/main/canvasMemory.ts`: resolve `<project>/.canvas/memory/{MEMORY.md,project.md,board-<id>.md}`, atomic writers, default `.gitignore`, opt-in commit). See `docs/roadmap-context.md` › M-memory. ⚠️ Wire the M-memory loop only AFTER confirming the budget guard is in place (it is) — the loop is the first autonomous-spend path the cap protects.

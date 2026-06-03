# Handoff — MCP M4 T4.3 `handoff_prompt` SHIPPED → next: T4.4 `assign_prompt` + `write_result` 🔒

> **M4 (Dispatch) is sequential (🔒 T4.1→T4.6).** **T4.1 audit · T4.2 confirm · T4.3 handoff_prompt are
> DONE** (squash-merged onto `feat/mcp-integration`, pushed). This doc closes **T4.3** and sets up
> **T4.4**. M4 is the most security-sensitive milestone — TDD-first, no shortcuts.

## What T4.3 shipped (the keystone — the first tool that writes into another agent's PTY)

- **App umbrella `feat/mcp-integration`** (pushed `91cd11f`): squash of `feat/mcp-t4-3-handoff-prompt`
  (sub-branch deleted). **pkg sibling `Z:\canvas-ade-mcp`** is on **`feat/handoff-prompt` (0.5.0, HELD/
  unpublished, `9d6e149`)** stacked off `feat/configure-board`. Dev loop = the `pnpm mcp:link` symlink
  (app sees the new tool live after `pnpm mcp:build`; app floor stays published `^0.2.4`, CI-safe).
- **pkg (0.5.0):** `Orchestrator.handoffPrompt(boardId, text): Promise<BoardResult>` on the interface
  (+ `MockOrchestrator` no-op `{present:false}`); `TOOL_HANDOFF_PROMPT`; `src/server/tools/handoffPrompt.ts`
  (`registerHandoffPrompt`, input `{boardId, prompt}` both `.min(1)`) registered **inside the
  `ctx.tier === 'orchestrator'` block** in `factory.ts` (structural split). Contract test
  `test/contract/handoffPrompt.contract.test.ts` (tier split + forward + empty-id/prompt reject).
- **app:**
  - `src/main/dispatchGuard.ts` (NEW, pure, TDD) — `createDispatchGuard()` → `issue() {nonce, seq}`
    (monotonic) / `consume(nonce)` true-once-then-false (replay/forged → false). The single-use-nonce unit.
  - `src/main/pty.ts` — `writeToPtyCore(id,text,sessionMap)` (pure; sessions-keyed = inherently
    terminal-only; swallows a just-exited-proc throw → false) + production `writeToPty(id,text)`.
    **MAIN-only, never in `preload`.**
  - `src/main/mcpOrchestrator.ts` — `handoffPrompt` flow: (1) resolve by **opaque id** via the board
    mirror (label-targeting rejected for free — a title is not an id), (2) **terminal-only** (Browser/
    Planning never reach a PTY), (3) `guard.issue()`, (4) `requestConfirm` (resolved target + exact
    prompt in the body; **deny → audit `denied` + throw, NO write**), (5) `guard.consume` (defensive
    replay guard), (6) `writeToPty(text+'\r')` (false → audit `failed` + throw), **audit `dispatched`
    at WRITE time** (crash-durable trail — the security-review Medium), (7) bounded await-idle poll
    (interim; **M5 = real attention**), (8) audit `completed` + return the `BoardResult`. `BoardRegistry`
    gains injected `writeToPty` / `confirm` / `audit`. `dispatchPrompt` STILL throws (T4.4), `gitDiff`
    STILL gated (M6).
  - `src/main/index.ts` — registry now injects `writeToPty`, `confirm: (req) => requestConfirm(ipcMain,
    () => mainWindow, req)`, `audit: (e) => getAuditLog()?.append(e).then(()=>{}) ?? Promise.resolve()`.
  - `src/main/mcpSmoke.ts` — **MCP_HANDOFF_OK**: tier split, worker DENIED server-side, non-terminal +
    label-targeting rejected, confirm-driven happy path (text lands in the PTY framebuffer), in-process
    nonce-replay invariant. Self-skips **`MCP_HANDOFF_SKIP`** on a pkg < 0.5.0 (keeps CI green pre-publish).
  - `src/main/e2e/probes/dispatch.ts` — **`dispatch-handoff`** probe: builds an orchestrator with the
    REAL production seams against a live terminal — label rejected; confirm → write → PTY-land →
    result → `completed` audit (read via `audit:read`); a forged-nonce orchestrator writes nothing;
    baseline restored to 4. (⚠️ the board is resolved through the MAIN board **mirror**, which the
    renderer publishes ~150ms after `addBoard` — the probe polls `listBoardMirror()` before dispatching;
    `terminalPid` alone fires too early.) Added to the playlist after `dispatch-confirm`.

**Security:** adversarial review (pr-review-toolkit:code-reviewer) — all 7 invariants HOLD, no
Critical/High. Authority = verified orchestrator bearer only; worker tier never reaches the tool;
tainted/worker content triggers nothing without the human gate; bound to the opaque id (never a label);
single-use nonce; node-pty MAIN-only; `contextIsolation/sandbox/nodeIntegration` unchanged; `gitDiff`
not unblocked. The one **Medium** (write unaudited until after the await-idle wait) was FIXED with the
at-write `dispatched` entry. Low/Nit (the `audit` closure no-ops if `getAuditLog()` is ever null — per
the spec'd wiring + unreachable given boot order; guard `seq` carried in audit `detail`) left as-is.

**Gate (green):** app typecheck · lint (0 err; the 1 `no-console` warning is pre-existing in
`PlanningBoard.tsx`, untouched) · format · **729 unit** · build. `CANVAS_SMOKE=mcp` → `MCP_HANDOFF_OK`
+ `MCP_DONE`. `CANVAS_SMOKE=e2e` → `dispatch-handoff` ok:true + **`E2E_DONE ok:true` (all 53 parts)**.
pkg `pnpm test` → 61 contract.

> ⚠️ **pkg `tsc --noEmit` is RED on the base too (37 pre-existing errors in 14 test files):** several
> contract-test orchestrators `implements Orchestrator` directly and were never updated for
> `closeBoard`/`configureBoard` (T3.2/T3.3) — `handoffPrompt` just widens that pre-existing debt. The
> pkg gate is **`pnpm test`** (contract, green) + `pnpm build` (tsup, green) + `pnpm lint` (green), NOT
> `typecheck`. Not introduced by T4.3; clean it in a dedicated pass if desired (make those test classes
> `extends MockOrchestrator`).

## Read first (for T4.4)
1. `Z:\Canvas ADE\CLAUDE.md` — Process model & security · `docs/roadmap-mcp.md` § M4.
2. This card's seams: `src/main/mcpOrchestrator.ts` (`dispatchPrompt` still throws — make it real;
   `handoffPrompt` is the blocking sibling to copy the gating from), `src/main/boardResults.ts`
   (`recordBoardResult` / `readBoardResult` — `write_result` feeds this; T1.5 `canvas://board/{id}/result`).
3. pkg: `src/server/factory.ts` (orchestrator-tier block for `assign_prompt`; **worker-tier**
   registration for `write_result` — the FIRST worker write tool), `src/auth/scopes.ts`,
   `src/orchestrator/Orchestrator.ts` (`dispatchPrompt` already declared).
4. Memories: `mcp-publish-gating` · `e2e-browser-trio-flake` (the preview/connector/fullview trio flakes
   on a contended host → rerun for clean; e2e is FROZEN in CI, `check` is the gate) ·
   `bash-tool-commit-backticks` (commit via heredoc `-F -`).

## T4.4 — `assign_prompt` (fire-and-forget) + `write_result` (first worker-tier write)
- **`assign_prompt`** = make the existing `dispatchPrompt(boardId, text): Promise<void>` REAL:
  fire-and-forget (write the prompt + return immediately; NO await-idle, NO blocking result). Same 🔒
  gating as `handoff_prompt` (opaque id → terminal-only → nonce → **human confirm** → audit → write),
  just without steps 7–8. Reuse `dispatchGuard` + `writeToPty` + `confirm` + `audit`. pkg: orchestrator-
  tier tool `assign_prompt` (it already exists on the interface as `dispatchPrompt`). Remove the
  "Phase 4" throw + its unit test, add real unit tests mirroring the handoff ones (minus await-idle).
- **`write_result`** = the **FIRST worker-tier WRITE tool**: a worker records its board's structured
  result → `recordBoardResult(boardId, {...})` → feeds `canvas://board/{id}/result` (T1.5). Register it
  in the **worker** path in `factory.ts` (NOT orchestrator-only) — and the smoke MUST assert a worker
  CAN call `write_result` AND the tier split stays correct (orchestrator tools still worker-denied).
  A worker writes ONLY its own result (bind to the worker's bound `boardId` from `ctx`, not an arbitrary
  id — a worker must not forge another board's result). No PTY write, no confirm (it's the agent
  reporting its own outcome, not dispatching into another shell).
- **smoke + e2e:** `MCP_ASSIGN_OK` (confirm-driven, fire-and-forget, text lands, audited) +
  `MCP_WRITE_RESULT_OK` (worker writes its own result → `canvas://board/{id}/result` reflects it; a
  worker writing ANOTHER board's id is rejected). e2e probes likewise. Restore baseline to 4.

## Cadence (mandatory, same as before)
- TDD every pure/decidable unit FIRST (watch it fail). Gate = `pnpm typecheck && pnpm lint &&
  pnpm format:check && pnpm test && pnpm build`, then BOTH smokes (`CANVAS_SMOKE=mcp` → `MCP_…_OK …
  MCP_DONE`; `CANVAS_SMOKE=e2e` → `E2E_DONE`; rerun the known browser-trio flake for clean). pkg:
  `cd Z:\canvas-ade-mcp; pnpm test`.
- One app sub-branch off the umbrella + a matching stacked pkg `feat/*` (bump 0.6.0 HELD) → squash-merge
  the app branch back when green (`git merge --squash` then `git branch -D`) → push the umbrella → write
  `docs/superpowers/handoffs/2026-06-03-mcp-t4-4-assign-write-result.md`.
- Update YOUR row on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` BEFORE editing. ⚠️ CROSS-ZONE
  `src/main/index.ts` + `src/preload/index.ts` + `App.tsx` with `feat/context` (additive, no shared
  lines). Do NOT publish the pkg or bump the app floor without the user's go-ahead. Do NOT merge the
  umbrella to app `main` (user's call).

## Then T4.5 / T4.6
- **T4.5** `interrupt(id)` — orchestrator-tier; send `'\x03'` to the target PTY (terminal-only;
  `drainPty` already writes `'\x03'` — reuse). Same nonce + confirm + audit gating.
- **T4.6** Agent-to-agent over the M2 orchestration connector cable — A→B resolves its target from the
  edge; 🔒 terminal→terminal only, one-directional, never Browser→PTY.
- **🚦 M4 gate:** a confirmed, audited, nonce-protected prompt executes in the target terminal; a worker
  tier is denied every dispatch tool but CAN `write_result`; tainted worker content triggers nothing
  without the human gate — both `CANVAS_SMOKE=mcp` and `CANVAS_SMOKE=e2e` green.

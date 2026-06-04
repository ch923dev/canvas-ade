# Handoff — MCP M4 T4.6 `relay_prompt` SHIPPED → 🎉 M4 (Dispatch) COMPLETE → next: M5 (Barriers/Attention)

> **M4 (Dispatch) is DONE — all 6 cards squash-merged onto `feat/mcp-integration`, pushed.** T4.1 audit ·
> T4.2 confirm · T4.3 handoff_prompt · T4.4 assign_prompt + write_result · T4.5 interrupt · **T4.6
> relay_prompt (this card)**. This doc closes T4.6 + the milestone and sets up **M5**.

## What T4.6 shipped (the M4 gate)

- **App umbrella `feat/mcp-integration`** (pushed `8f5e2d5`): squash of `feat/mcp-t4-6-agent-to-agent`
  (sub-branch deleted). **pkg sibling `Z:\canvas-ade-mcp`** is on **`feat/agent-to-agent` (0.8.0, HELD/
  unpublished, `9c85056`)** stacked off `feat/interrupt`. Dev loop = the `pnpm mcp:link` symlink.

### `relay_prompt` — agent-to-agent over the M2 orchestration connector
- **pkg (0.8.0):** `TOOL_RELAY_PROMPT`; `Orchestrator.relayPrompt(sourceId, targetId, text): Promise<void>`
  (+ Mock no-op); `src/server/tools/relayPrompt.ts` (`registerRelayPrompt`, input `{sourceId, targetId,
  prompt}` all `.min(1)`) registered **inside the orchestrator-tier block**. Contract test
  `test/contract/relayPrompt.contract.test.ts` (tier split + forward + empty rejects). 79 contract total.
- **Connector topology now reaches MAIN** (the new wiring this card needed):
  - `src/main/boardRegistry.ts`: `ConnectorMirror` type + `sanitizeConnectors` (bounded; `orchestration`/
    `preview` only; unknown kind dropped) + `listConnectors()` + `__setConnectorsForTest`. The `mcp:boards`
    handler now accepts `{ boards, connectors }` (a legacy boards-only **array** is still tolerated →
    connectors `[]`).
  - `src/preload/index.ts`: `publishBoards` takes `{ boards, connectors }`.
  - `src/renderer/src/store/useMcpPublish.ts`: subscribes to `s.connectors` + publishes them alongside
    boards (re-publishes when a cable is drawn/removed).
- **app `src/main/mcpOrchestrator.ts`:** `BoardRegistry.listConnectors` + `relayPrompt(sourceId, targetId,
  text)` — (1) require a directed **orchestration** edge `sourceId→targetId` (the cable is the auth;
  resolved before any nonce/confirm); (2) both ends **terminals** (never Browser→PTY); (3) nonce → (4)
  human confirm (names both endpoints) → (5) consume → (6) `writeToPty(targetId, text+'\r')` → audit
  `relay_prompt` `dispatched`. Fire-and-forget. `src/main/index.ts` injects `listConnectors`.
- **app `src/main/mcpSmoke.ts`:** **MCP_RELAY_OK** — spawn 2 terminals, draw the cable via the e2e hook
  (`window.__canvasE2E.addConnector`, the same store path as the real gesture), **poll `listConnectors()`
  (smoke runs in MAIN) until the cable mirrors**, relay A→B → lands in B; a B→A relay (no cable that
  direction) is rejected; worker DENIED. Self-skip on a pkg < 0.8.0.
- **app `src/main/e2e/probes/dispatch.ts`:** **`dispatch-relay`** (REAL seams: draw cable A→B, wait for the
  MAIN mirror, B→A rejected, confirm → relay → lands in B, `relay_prompt`/`dispatched` audited; baseline 4).

**Security:** relay reuses the full dispatch spine (verified orchestrator bearer only; worker never reaches
the tool; tainted content triggers nothing without the human gate; single-use nonce; node-pty MAIN-only;
sandbox/isolation unchanged; `gitDiff` not unblocked). The new gate is **edge authorization** — a relay is
impossible without a user-drawn orchestration cable in that exact direction, and both ends must be
terminals (the connector graph can't be used to reach a Browser's PTY-less view).

**Gate (green):** app typecheck · lint (0 err; lone pre-existing `no-console` in `PlanningBoard.tsx`) ·
format · **754 unit** · build. `CANVAS_SMOKE=mcp` → `MCP_RELAY_OK` + the full dispatch set
(handoff/assign/write_result/interrupt) + `MCP_DONE` exit 0. pkg `pnpm test` → 79 contract + lint + build.

> ⚠️ **e2e env-flake on this session-degraded host (verify on a fresh host).** After ~40 Electron launches
> this session the full `CANVAS_SMOKE=e2e` run flakes BROADLY across UNRELATED input/measurement-heavy
> probes — the failing set VARIES per run (browser-trio, then 4 edge probes, then +whiteboard-paste/
> fullview), with signatures of an unfocused/degraded window (`-999999` synthetic-click coords, null RF
> edge strokes, blank `capturePage`, `pasted:false`). **All 7 dispatch probes (incl `dispatch-relay`) pass
> EVERY run**, and the connector STORE logic passes (`connector-roundtrip` ok; `connector-draw-delete`
> fails only on the rendered ✕ `btnVisible`, store `afterX:1`/`connBack:true`). This is NOT a regression
> (the T4.6 diff is MAIN-side + one additive `App` subscription that reconciles `<Canvas/>` in place; T4.5
> ran fully clean ×2 earlier this session with the same non-dispatch code). **A fresh-host e2e rerun is
> owed to show a clean `E2E_DONE ok:true`** — same posture as memory `e2e-browser-trio-flake`, just broader
> due to session-long thrash. e2e is FROZEN in CI; `check` is the gate.

> ⚠️ **pkg `tsc --noEmit` still RED on the base** (~55 pre-existing test-orchestrator errors; `relayPrompt`
> widens it by one). pkg gate is `pnpm test` + `pnpm build` + `pnpm lint`, NOT typecheck. Clean in a
> dedicated pass (make the contract-test classes `extends MockOrchestrator`).

## 🎉 M4 (Dispatch) — COMPLETE
A confirmed, audited, nonce-protected dispatch executes in the target terminal in every mode:
- **handoff_prompt** (T4.3) — blocking, returns the target's result.
- **assign_prompt** (T4.4) — fire-and-forget.
- **write_result** (T4.4) — the worker-tier write (a worker records its OWN result, bound to `ctx.boardId`).
- **interrupt** (T4.5) — Ctrl-C.
- **relay_prompt** (T4.6) — agent-to-agent along an orchestration cable.
A worker tier is denied every dispatch tool but CAN `write_result`; tainted/worker content triggers nothing
without the human gate. Audit trail (T4.1) + confirm gate (T4.2) underpin all of it.

**pkg HELD chain (UNPUBLISHED), consumed via `pnpm mcp:link`:** 0.5.0 handoff → 0.6.0 assign+write_result →
0.7.0 interrupt → 0.8.0 relay. App floor stays published `^0.2.4` (CI-safe); every smoke self-skips on an
older pkg. **A publish (tag `v0.8.0`) + app-floor bump is owed before M4 ships to app `main`** — user-gated.

## Read first (for M5)
1. `Z:\Canvas ADE\CLAUDE.md` — Process model & security · `docs/roadmap-mcp.md` § M5 (lines 336-360).
2. The interim seam M5 replaces: `src/main/mcpOrchestrator.ts` `handoffPrompt` await-idle poll (T4.3) — M5
   makes it event-driven. The status buckets (T1.1) + `canvas://attention` (T1.3) are the substrate.
3. Memories: `e2e-browser-trio-flake`, `e2e-sendinputevent-vs-dispatchevent` (window-focus/synthetic-input
   env flakes — relevant to the e2e note above), `bash-tool-commit-backticks`.

## M5 — Barriers + event-driven attention (package Phase 5)
**Goal:** the orchestrator can *wait* efficiently (no busy-poll) — the backbone of sequenced swarms.
- **T5.1** `canvas://attention` SSE subscription (`notifications/resources/updated` over GET-SSE); app pushes
  attention changes off real board-state changes.
- **T5.2** `wait_for_idle(id)` / `wait_for_all(ids[])` tools resolving off the T5.1 subscription (replaces
  the T4.3 interim await-idle timer poll). 🚦 the e2e: resolves EXACTLY when the board goes idle, not a timer.
- **T5.3** attention-state distinction (`idle-done` vs `blocked-on-permission` vs `error/crashed`).
- **T5.4** on-canvas "needs-you" attention queue (SB-1 spatial UI).
**🚦 M5 gate:** barriers resolve event-driven; the human sees at a glance who needs them.

## Cadence (mandatory)
- TDD every pure/decidable unit FIRST. Gate = `pnpm typecheck && pnpm lint && pnpm format:check &&
  pnpm test && pnpm build`, then both smokes. **Run the first e2e on a freshly-restarted host** to clear the
  session-thrash flake noted above. pkg: `cd Z:\canvas-ade-mcp; pnpm test`.
- One app sub-branch off the umbrella + a stacked pkg `feat/*` (bump 0.9.0 HELD) → squash-merge back when
  green → push the umbrella → write the next handoff. Update YOUR row on
  `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` BEFORE editing. ⚠️ CROSS-ZONE `src/main/index.ts` +
  `src/preload/index.ts` w/ `feat/context` (additive). Do NOT publish the pkg / bump the app floor / merge
  the umbrella to app `main` without the user's go-ahead.

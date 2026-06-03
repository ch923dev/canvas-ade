# Handoff — MCP M4 T4.5 `interrupt` SHIPPED → next: T4.6 agent-to-agent (the M4 GATE) 🔒

> **M4 (Dispatch) is sequential (🔒 T4.1→T4.6).** **T4.1 audit · T4.2 confirm · T4.3 handoff_prompt ·
> T4.4 assign_prompt + write_result · T4.5 interrupt are DONE** (squash-merged onto
> `feat/mcp-integration`, pushed). This doc closes **T4.5** and sets up **T4.6 — the M4 gate**.

## What T4.5 shipped

- **App umbrella `feat/mcp-integration`** (pushed `fadad9b`): squash of `feat/mcp-t4-5-interrupt`
  (sub-branch deleted). **pkg sibling `Z:\canvas-ade-mcp`** is on **`feat/interrupt` (0.7.0, HELD/
  unpublished, `9d96cc5`)** stacked off `feat/assign-result`. Dev loop = the `pnpm mcp:link` symlink.

### `interrupt` — Ctrl-C dispatch (content-less)
- **pkg (0.7.0):** `TOOL_INTERRUPT`; `Orchestrator.interrupt(boardId): Promise<void>` (+ Mock no-op);
  `src/server/tools/interrupt.ts` (`registerInterrupt`, input `{boardId}` `.min(1)`) registered **inside
  the `ctx.tier === 'orchestrator'` block**. Contract test `test/contract/interrupt.contract.test.ts`
  (tier split + forward + empty-id reject). 75 contract total.
- **app `src/main/mcpOrchestrator.ts`:** `interrupt(boardId)` — the SAME 6-step gating as `dispatchPrompt`
  but it writes a **raw `'\x03'` (NO carriage return)** and carries an **empty prompt**; audits
  `interrupt` `dispatched` at write time. **No index.ts wiring** — `writeToPty`/`confirm`/`audit` are
  already on `BoardRegistry`.
- **app `src/main/mcpSmoke.ts`:** **MCP_INTERRUPT_OK** (tier split, worker DENIED, non-terminal rejected,
  confirm-driven happy path verified via the **audit trail** — a Ctrl-C has no echo to read). Self-skip
  on a pkg < 0.7.0.
- **app `src/main/e2e/probes/dispatch.ts`:** **`dispatch-interrupt`** (REAL seams against a live terminal:
  label rejected; confirm → `'\x03'` → call resolves → `interrupt`/`dispatched` audited; forged nonce
  rejected; baseline 4). Added to the playlist after `dispatch-write-result`. A `productionRegistry(ctx)`
  helper now builds the production-wired registry shared by the assign/write-result/interrupt probes.

**Security:** interrupt reuses every assign/handoff invariant (verified orchestrator bearer only; worker
tier never reaches the tool; tainted content triggers nothing without the human gate; opaque-id bound;
single-use nonce; node-pty MAIN-only; sandbox/isolation unchanged; `gitDiff` not unblocked).

**Gate (green):** app typecheck · lint (0 err; the 1 pre-existing `no-console` in `PlanningBoard.tsx` is
untouched) · format · **744 unit** · build. `CANVAS_SMOKE=mcp` → `MCP_INTERRUPT_OK` + `MCP_DONE` exit 0.
`CANVAS_SMOKE=e2e` → `dispatch-interrupt` ok:true, **`E2E_DONE ok:true`** (clean full run ×2 — the
browser-trio flake cleared on these runs). pkg `pnpm test` → 75 contract + lint + build(+DTS).

> ⚠️ **pkg `tsc --noEmit` is STILL RED on the base** (~50 pre-existing test-orchestrator errors — classes
> that `implements Orchestrator` directly never got the M3/M4 methods; `interrupt` widens it by one). NOT
> introduced by T4.5; pkg gate is **`pnpm test` + `pnpm build` + `pnpm lint`**, NOT typecheck.

## T4.6 — agent-to-agent over the M2 orchestration connector cable (🚦 the M4 GATE)
The capstone: an agent in board **A** dispatches to board **B** by resolving B **from the M2 connector
edge** between them (not a free-form id). 🔒 **terminal → terminal only, one-directional, never
Browser → PTY.** Reuse the entire dispatch spine (nonce + confirm + audit + `writeToPty`) — the new piece
is **edge-resolution**: given the caller's bound board (orchestrator token = board `app`; for a real
agent-to-agent, the caller's `ctx.boardId`) and the connector graph, resolve the directed target.

Read first:
1. The M2 connector model — `src/renderer/src/store/canvasStore.ts` (`connectors[]`, `addConnector`/
   `removeConnector`), `boardSchema.ts` (v5 Connector shape), and how `orchestrationEdges()` renders them.
   The MAIN side sees connectors via the board mirror — **check whether `listBoardMirror`/the mirror
   carries `connectors`**; if not, the registry needs a `listConnectors()` seam (mirror it like
   `listBoards`). This is the main new wiring.
2. `src/main/mcpOrchestrator.ts` `interrupt`/`dispatchPrompt` — copy the gating; the only delta is the
   target comes from an edge lookup, and the **source** must be the caller's own board (a worker-tier
   token bound to A can dispatch only along A's outgoing cables).
3. `docs/roadmap-mcp.md` § M4 T4.6 for the exact decision (tool name, direction semantics, whether it's
   orchestrator-only or worker-along-own-edge).

Likely shape: pkg `feat/agent-to-agent` off `feat/interrupt` (bump **0.8.0** HELD); a tool that takes a
**target board id** but VALIDATES a connector A→B exists (and direction) before dispatching — or a
connector-scoped variant. app sub-branch `feat/mcp-t4-6-agent-to-agent`. smoke `MCP_A2A_OK` + e2e
`dispatch-agent-to-agent` (draw a connector, dispatch along it, assert it lands; assert a non-connected
target and a Browser endpoint are rejected). **This card CLOSES M4** — after it, M4 is done; consider the
M4 gate checklist below.

## Cadence (mandatory)
- TDD every pure/decidable unit FIRST (watch it fail). Gate = `pnpm typecheck && pnpm lint &&
  pnpm format:check && pnpm test && pnpm build`, then BOTH smokes (`CANVAS_SMOKE=mcp`; `CANVAS_SMOKE=e2e`;
  rerun the known browser-trio flake for clean). pkg: `cd Z:\canvas-ade-mcp; pnpm test`.
- One app sub-branch off the umbrella + a stacked pkg `feat/*` (bump 0.8.0 HELD) → squash-merge back when
  green → push the umbrella → write `docs/superpowers/handoffs/2026-06-03-mcp-t4-6-agent-to-agent.md`.
- Update YOUR row on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` BEFORE editing. ⚠️ CROSS-ZONE
  `src/main/index.ts` w/ `feat/context` (additive). T4.6 may also touch the renderer connector store/
  mirror — coordinate with whiteboard/draw.io tracks if they share `canvasStore.ts`/`boardSchema.ts`.
  Do NOT publish the pkg / bump the app floor / merge the umbrella to app `main` without the user's go-ahead.

## 🚦 M4 gate (CLOSES at T4.6)
✅ handoff + assign + interrupt: a confirmed, audited, nonce-protected dispatch executes in the target
terminal. ✅ worker tier denied every dispatch tool but CAN `write_result`. ✅ tainted worker content
triggers nothing without the human gate. **Remaining: T4.6 agent-to-agent over the connector** → then M4
is COMPLETE; both `CANVAS_SMOKE=mcp` and `CANVAS_SMOKE=e2e` green.

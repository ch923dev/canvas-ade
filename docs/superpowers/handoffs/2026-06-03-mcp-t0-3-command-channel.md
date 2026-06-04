# Handoff — MCP roadmap T0.3: MAIN→renderer command channel

- **Date:** 2026-06-03
- **Milestone/Task:** M0 / **T0.3** (`docs/roadmap-mcp.md`)
- **Repo:** `Z:\Canvas ADE` (app) — branch `feat/mcp-integration` (umbrella / PR #32), commit `f5ea4f3`.
- **Status:** ✅ done, gate-green, pushed.

## What landed

The **inverse of the `mcp:boards` mirror**: where the mirror carries board facts renderer→MAIN, this
carries commands **MAIN→renderer**. It is the control plane the MCP layer will use to *drive* the
canvas once it gains write tools (M3 lifecycle). T0.3 ships only a `ping` round-trip; the envelope is
the contract M3 extends.

**Envelope (the M3 contract — single source of truth in `src/main/mcpCommand.ts`):**
```ts
type McpCommand    = { type: 'ping' }   // M3 adds: addBoard / removeBoard / selectBoard / ...
type McpCommandAck = { ok: true; type: string } | { ok: false; error: string }
```

## Files
- `src/main/mcpCommand.ts` — `sendMcpCommand(bus, getWin, command, timeoutMs?)`: unique reply channel
  + one-shot listener, **timeout fallback**, **frame-guarded ack**, never throws (returns `{ok:false}`
  on gone-window / send-fail / timeout). `bus` is injected (no electron *value* import) → unit-testable.
- `src/main/mcpCommand.test.ts` — 4 unit tests (ack resolve · no-window · foreign-frame ignored ·
  malformed-ack).
- `src/preload/index.ts` — `mcp.onCommand(handler)` bridge (handler gets the command + a `reply` fn),
  returns unsubscribe.
- `src/renderer/src/store/useMcpCommands.ts` — applier hook; `ping` → `{ok:true,type:'ping'}`.
- `src/renderer/src/App.tsx` — mounts `useMcpCommands()` (beside `useMcpPublish`).
- `src/main/mcpSmoke.ts` — `MCP_COMMAND_OK` probe (ping round-trips through the real renderer).

## Test evidence
- **Unit:** 513 green (+4 mcpCommand). typecheck · lint · format clean.
- **e2e (the live-against-Canvas-ADE layer):** `CANVAS_SMOKE=mcp` →
  `MCP_LIST_OK · MCP_TIER_OK · MCP_BOARDS_OK · MCP_COMMAND_OK · MCP_DONE`, exit 0, no teardown error.
  Board e2e (`CANVAS_SMOKE=e2e`) clean on rerun — the `preview-edge-stale` / `duplicate-keeps-link`
  probes are the **known RF measurement-race flake** (memory `e2e-rf-measurement-race`; fix lives on
  `feat/e2e-hardening`, not this branch). Verified NOT a T0.3 regression: clean `286820d` flaked the
  same probes; T0.3 passed fully on 2 of 3 runs.
- **Manual:** the MCP smoke IS the live manual proof of the round-trip. A dev-console trigger is
  deferred (no dev button wired yet); the e2e probe covers it.

## Notes / follow-ups
- **PR scope:** `feat/mcp-integration` (PR #32) now carries the re-port + the teardown fix (`286820d`)
  + T0.3 (`f5ea4f3`) — i.e. it has become the **M0 foundation** PR, not just the re-port. Decide
  whether to keep stacking M0 on #32 or split per-task PRs (raised with the user).
- The command channel needs **no `app.whenReady` wiring** — `sendMcpCommand` is called on demand; the
  receiving side is the preload bridge + the App-mounted hook.

## Next task
**M0 is essentially complete** (T0.1 pending only the package read-access grant + #32 merge; T0.2
done as pkg PR #1; T0.3 done). Next milestone: **M1 — Observation** (`docs/roadmap-mcp.md` § M1),
starting **T1.1 — status buckets in the board mirror** (enrich the snapshot with idle/running/
blocked/... derived from `terminalRuntimeStore` + `previewStore`, exposed via `canvas://board/{id}/status`).

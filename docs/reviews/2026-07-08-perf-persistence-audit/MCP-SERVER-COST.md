# Addendum — In-App MCP Server: Cost & Should-It-Be-a-Separate-Process

**Date:** 2026-07-09 · Companion to `AUDIT.md`
**Question:** Is serving the MCP server inside the app a performance/memory cost? Would moving it to a separate server/process free up memory?

**Short answers:**
1. **Yes, it is a cost — but a small, constant, memory-only one.** It is *not* a driver of the reported lag. CPU while idle is ~zero.
2. **No — a separate process does NOT free memory; it increases total RAM.** On an 8 GB (total-RAM-constrained) machine that is a net loss. The correct memory win is **lazy-start**, not process extraction.

---

## 1. What the in-app MCP server actually is

`startMcpServer` (`src/main/mcp.ts:170`) mounts a **loopback HTTP server inside the MAIN process** by dynamic-importing the ESM package `@expanse-ade/mcp` (v0.18.0). That package's runtime dependencies are:

```
@expanse-ade/mcp
├── @modelcontextprotocol/sdk  ^1.29.0
├── express                    ^5.2.1
└── zod                        ^4.4.3   (+ ajv transitively via the MCP SDK)
```

It is started **unconditionally at boot** in `app.whenReady` (`src/main/index.ts:478`), regardless of whether Agent Orchestration is ever enabled for any project. The wiring already tolerates it being absent — `registerOrchestratorIpc(ipcMain, …, () => mcp)` and the note at `index.ts:544-545`: *"`() => mcp` is null until the loopback server is up (or if it failed to bind) → handlers reject cleanly."* A bind/import failure is non-fatal by design (`mcp.ts:246-257`).

Note there is a **second** always-on loopback server too: `localServer.ts` (plain `node:http`, `createServer` at `:91`, `listen(0)` at `:143`) serving a static preview-fallback page. It is much lighter (no Express/zod/SDK) but is the same "always-on server at boot" pattern.

---

## 2. Is it a cost? Measured by category

### CPU (idle): ~zero — **not** a lag contributor
- An Express/`node:http` server sitting idle is fully event-driven — no work until a request arrives.
- The orchestrator has **no idle polling**. The only timers (`mcpOrchestrator.ts:234,774`) are `setInterval(…, 2000)` armed **per active dispatch/handoff** and torn down on settle (`:235` `cleanups.push(() => clearInterval(poll))`).
- The old idle-reap sweep that used to run on an interval here was **removed** (`mcp.ts:222`: *"the T3.4 idle-reap sweep that ran here on an interval was REMOVED"*).
- MCP tool calls are infrequent, human-gated, and only happen when an agent is actively driving the canvas.

**Conclusion:** the MCP server contributes ~nothing to the single-terminal / switch lag reported in the main audit. Those root causes (spinner re-render, background-session retention, sync `.bak` write) are unrelated.

### Memory (heap): modest, constant, and **paid even when unused**
Loading `@expanse-ade/mcp` pulls Express 5 + the MCP SDK + zod (+ ajv) into MAIN's V8 heap: parsed module code plus the live singletons (`TokenStore`, the orchestrator, the Express app + router, the HTTP server object). Order-of-magnitude this is **low-single-digit to low-double-digit MB resident** in MAIN, held for the whole app run.

That cost is **pure waste for any user who never enables Agent Orchestration** — which is the common case, and exactly the low-RAM user we're optimizing for.

> **Measure it precisely before acting:** wrap the dynamic import + `createMcpHttpServer` in `mcp.ts:181-212` with `process.memoryUsage().heapUsed` (and `.rss`) deltas and log them once at boot. That gives the real number on the target hardware instead of an estimate. This is a 5-line temporary instrumentation, worth doing before any refactor.

### Boot time
The dynamic `import()` of the ESM package + `createMcpHttpServer` runs on the startup critical path (inside `whenReady`, before the sequence continues). Deferring it shortens cold start for the majority who don't use orchestration.

### Retained state: bounded (no leak)
- `TokenStore` — bounded: one `connected` token per board, rotate-on-respawn, revoke-on-close (`mcp.ts:49-76`, FIND-015/BUG-019).
- Board registry mirror — hard-capped `MAX_BOARDS=500`, replaced wholesale, `Set`-based listeners with unsubscribe (audited clean in the main `AUDIT.md`).
- Orchestrator per-dispatch listeners/timers — cleaned up on settle.

So the server does **not** grow unbounded; the concern is the fixed baseline, not accretion.

---

## 3. Would a separate process "free up memory"? — No; this is the key correction

Moving the MCP server to a **separate child process** (or a detached daemon) does **not reduce total system RAM**. It:

- **Adds** a second Node/V8 runtime: ~30–50 MB baseline heap + per-process OS overhead, *on top of* the same Express/SDK/zod heap (which just moves, it doesn't shrink).
- Adds an **IPC hop** (main ⇄ child) for every orchestrator call that is currently an in-process function call — more serialization, more latency, more code.
- Adds **lifecycle/crash-handling** complexity (spawn, health-check, restart, port handoff, secure token passing across the boundary).

It only "frees" **MAIN's heap specifically** — which matters if MAIN is the memory-pressured process *and* the OS is paging it. On an 8 GB machine the constraint is **total RAM across all processes**, so pushing ~10 MB out of MAIN by paying a ~30–50 MB new-process tax is a **net loss** for the reported scenario.

**A separate process is the right call only if** one of these is your actual goal (none match the reported symptom):
- **CPU isolation** — keep heavy MCP work off MAIN's event loop. Not needed here: idle-cheap, infrequent, gated.
- **Crash isolation** — a server bug must not take down the window. It's already graceful-degrade + non-fatal (`mcp.ts:246`); a crash today is contained.
- **Independent lifecycle** — the MCP endpoint must outlive the window / serve multiple windows. Not a current requirement (single-window desktop app).

---

## 4. The actual memory win: lazy-start (start on demand, not at boot)

Nothing requires the MCP server before Agent Orchestration is enabled:

- The renderer holds no token and rejects cleanly while `mcp` is null (`index.ts:544-550`).
- Terminals only receive an MCP port/token via the spawn-time provisioner, which **no-ops without consent**: `orchestrationProvision.ts:54` `if (!projectDir || !isOrchestrationEnabled(projectDir)) return null` (same gate at `:81`). Confirmed: **no boot-time port stamping** exists in `index.ts`.
- `planningWriteEnabled` is already per-project/per-session consent-driven (`mcp.ts:25-33`).

**Recommendation — start the server on first need, keep it null until then:**
1. Replace the eager `mcp = await startMcpServer(…)` at boot with a lazy `ensureMcp()` promise-memoized singleton.
2. Trigger `ensureMcp()` at the first orchestration-enable transition (the `onChange` consent hook near `index.ts:908`) and/or at the first `mintTerminalToken`/provisioner call for a consented project. `registerOrchestratorIpc(…, () => mcp)` already handles a null server, so nothing downstream breaks before it's up.
3. Optionally **stop/dispose** the server when orchestration is disabled for the last consented project (`RunningMcp.close()` already exists — `mcp.ts:239`), reclaiming the whole heap when the feature is turned off.

This frees the entire Express/SDK/zod heap **and** the boot-time import for every user who never touches orchestration — the majority, and exactly the low-RAM target — while costing nothing for those who do (a one-time ~tens-of-ms start on first enable).

Consider the same treatment for `localServer` (`index.ts:445`): start it only when the first Browser board needs the fallback preview URL.

---

## 5. Verdict

| Question | Answer |
|---|---|
| Is the in-app MCP server a cost? | Yes — a **constant low-MB heap + boot-import cost**, paid even when unused. CPU idle ≈ 0. **Not** a cause of the reported lag. |
| Move it to a separate process to free memory? | **No.** A second process *raises* total RAM (~30–50 MB new runtime) and adds IPC/lifecycle complexity. It only offloads MAIN's heap, which isn't the 8 GB constraint. |
| Best fix for the memory goal | **Lazy-start** on first orchestration-enable (+ optional stop-on-disable). Frees the full heap for non-orchestration users; nothing needs it at boot. |
| Do first | Add a `process.memoryUsage()` delta around the import/`createMcpHttpServer` to get the real number on target hardware, then do the lazy-start refactor. |

**Priority relative to the main audit:** this is a **Medium** memory win (bounded, constant baseline, common-case waste) — below the Critical/High items (background-session cap C1, spinner re-render C2, sync `.bak` write H1), but a clean, low-risk reclaim that pairs naturally with the "always-on subsystems at boot" architecture note in `AUDIT.md §5`.

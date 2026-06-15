# Bug Hunt Findings — Work Queue

Generated: 2026-06-15 · Scope: all of `src/` on `main` (main + preload + renderer; tests/vendor excluded) · Confirmed in-scope: **16**

Method: 18 file-disjoint discovery slices fanned out in parallel → an **independent adversarial verifier per candidate** (goal: refute) → roadmap reconciliation against `docs/roadmap.md`. 44 agents, 25 candidates → 16 CONFIRMED, 9 unconfirmed (see [`unconfirmed.md`](unconfirmed.md)), 0 skipped to roadmap (see [`skipped-roadmap.md`](skipped-roadmap.md)). Source on the working branch is byte-identical to `main` for all of `src/`.

> No code was changed by this hunt. Fixing is a separate run — use the `parallel-fix-runner` skill against this package.

| ID | Severity | Category | Title | Files | Collides with | Status |
|----|----------|----------|-------|-------|---------------|--------|
| [BUG-001](findings/BUG-001.md) | **High** | correctness | Recap-map watcher dereferences `.webContents` on a destroyed-but-non-null `mainWindow` → uncaughtException → whole-app crash-quit | `src/main/index.ts` | BUG-008 | fixed (6de86eb) |
| [BUG-002](findings/BUG-002.md) | Medium | correctness | `handoff_prompt` / `wait_for_*` barriers can never settle for a live agent — always ride the backstop to `timed_out` | `src/main/mcpOrchestrator.ts`, `mcpRegistry.ts`, `boardStatus.ts`, `terminalRuntimeStore.ts`, `useTerminalSpawn.ts` | BUG-007, BUG-008, BUG-009 | fixed (6de86eb) |
| [BUG-003](findings/BUG-003.md) | Medium | correctness | Recap-consent modal (& ConfirmModal) don't detach live previews → native `WebContentsView` paints over the dialog | `src/renderer/.../Modal.tsx`, `RecapConsentModal.tsx`, `ConfirmModal.tsx` | — | fixed (44bfdb2) |
| [BUG-004](findings/BUG-004.md) | Low | correctness | `did-navigate-in-page` never clears the `failed` latch → SPA stuck on `load-failed` after client-side route | `src/main/preview.ts`, `usePreviewEvents.ts`, `useOffscreenPreview.ts` | BUG-005 (preview area) | fixed (13bba46) |
| [BUG-005](findings/BUG-005.md) | Low | error-handling | OSR blocked-scheme URL silently no-ops → board hangs on "Connecting…" forever + idle renderer | `src/main/previewOsr.ts` | — | fixed (5bbb8a8) |
| [BUG-006](findings/BUG-006.md) | Low | security | Project-dir guard allows ANY absolute path → arbitrary-location dir/file creation by a compromised renderer | `src/main/projectIpc.ts` | — | fixed (4d7c25c) |
| [BUG-007](findings/BUG-007.md) | Low | correctness | Idle-reaper never reaps a quiescent MCP terminal (the `idle` bucket never occurs for a live PTY) | `src/main/mcpLifecycle.ts`, `mcpRegistry.ts`, `mcpOrchestrator.ts`, `pty.ts` | BUG-002, BUG-008, BUG-009 | fixed (6de86eb) |
| [BUG-008](findings/BUG-008.md) | Low | error-handling | Audit-append failure after the PTY write turns a successful dispatch into an error → retry re-runs the command | `src/main/mcpOrchestrator.ts`, `index.ts` | BUG-001, BUG-002, BUG-007, BUG-009 | fixed (6de86eb) |
| [BUG-009](findings/BUG-009.md) | Low | resource-leak | `write_result` stores worker summary/refs verbatim with no length bound (unlike sibling untrusted sinks) | `src/main/mcpOrchestrator.ts`, `@expanse-ade/mcp` pkg | BUG-002, BUG-007, BUG-008 | fixed (6de86eb) |
| [BUG-010](findings/BUG-010.md) | Low | correctness | Title-only rename burns a budgeted LLM summarize with byte-identical input (fingerprint ↔ prompt disagreement) | `src/main/memoryEngine.ts`, `summaryLoop.ts` (+ tests) | BUG-011 | fixed (6506e83) |
| [BUG-011](findings/BUG-011.md) | Low | security | Milestone text truncated **before** `redactSecrets` → a boundary-straddling secret prefix can leak to the LLM | `src/main/agentTranscript.ts`, `summaryLoop.ts` | BUG-010 | fixed (6506e83) |
| [BUG-012](findings/BUG-012.md) | Low | resource-leak | `removeBoard` never reclaims a board's `idleOnMountIds` entry (BUG-033 class, un-fixed delete path) | `src/renderer/.../canvasStore.ts` (+ test) | — | fixed (6d44485) |
| [BUG-013](findings/BUG-013.md) | Low | data-integrity | MAIN `SCHEMA_VERSION` stuck at 9 while renderer `boardSchema` is 10 (lock-step contract violated) | `src/main/projectStore.ts` (+ test) | BUG-014 | fixed (d7c7c8b) |
| [BUG-014](findings/BUG-014.md) | Low | data-integrity | Schema drift-guard test hardcodes literal `9`, so it cannot detect the drift it guards | `src/main/projectStore.ts` (+ test) | BUG-013 | fixed (d7c7c8b) |
| [BUG-015](findings/BUG-015.md) | Low | error-handling | `parkTerminal()` IPC voided without `.catch()` → unhandled promise rejection on park failure | `src/renderer/.../Canvas.tsx`, `useBoardActions.ts` | — | fixed (612b93c) |
| [BUG-016](findings/BUG-016.md) | Low | correctness | Model backdrop scenes never re-check buffer size in the loop → a dpr change reblurs the animation | 8 `backdrop/scenes/*.ts` | — | fixed (7c55cb2) |

**Summary:** 25 candidates -> 16 confirmed -> 0 skipped -> **16 in-scope -> ALL 16 FIXED + verified** on `fix/bug-hunt-2026-06-15` (gate green: typecheck/lint/format + unit 2550/2550). See [FIX-REPORT.md](FIX-REPORT.md).

**Parallelization note:** Cards with no "Collides with" entry can be assigned simultaneously. The major shared-file clusters to **sequence**:
- **MCP cluster** — BUG-002 / BUG-007 / BUG-008 / BUG-009 all touch `mcpOrchestrator.ts` (BUG-002 & BUG-007 also share `mcpRegistry.ts`). BUG-002 + BUG-007 share the same *root cause* (no per-task `running→idle` signal) and are best fixed together.
- **index.ts** — BUG-001 and BUG-008 both edit `src/main/index.ts`.
- **Schema pair** — BUG-013 + BUG-014 touch the same two files (`projectStore.ts` + `projectStore.test.ts`) and are effectively one fix (bump version **and** fix the guard test); do them as one unit.
- **Context pair** — BUG-010 + BUG-011 share `summaryLoop.ts`.

**Theme:** Three of the confirmed bugs (BUG-002, BUG-007, and the root of the MCP barrier failures) stem from one design gap — a live terminal's status is permanently `running`, with no per-task `running→idle` transition. Fixing that one signal collapses two findings and de-risks the swarm/orchestration layer.

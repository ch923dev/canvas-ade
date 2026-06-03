# Handoff prompt — continue the Canvas ADE × MCP integration (next phase: M1)

> Copy everything in the code block into a fresh Claude Code session. It is self-contained — it carries
> the state as of 2026-06-03 so the new session starts cold. **Work in the worktree, never the main dir.**

```
You are continuing the Canvas ADE × MCP integration roadmap. Two repos, one runtime:
  - APP:     Z:\Canvas ADE                (Electron + TS + React desktop app)
  - PACKAGE: Z:\canvas-ade-mcp            (the MCP server LIBRARY, @ch923dev/canvas-ade-mcp, sibling repo)

READ FIRST (in this order):
  1. Z:\Canvas ADE\CLAUDE.md                          (durable contract — stack, security, conventions)
  2. docs/roadmap-mcp.md                              (THE roadmap — M0..M10 task cards; on feat/mcp-integration)
  3. docs/reviews/2026-06-03-mcp-status-audit.md      (where the MCP layer stood + risks)
  4. docs/superpowers/handoffs/2026-06-03-mcp-t0-2-host-header.md  and  -t0-3-command-channel.md
  5. The sibling package roadmap: Z:\canvas-ade-mcp\docs\roadmap.md (the contract phases 0-9)

# WHERE TO WORK — critical
- The MCP umbrella branch is **feat/mcp-integration** (PR #32). A worktree for it already exists at
  **Z:\canvas-ade-mcp-int** (node_modules junctioned in). DO YOUR WORK THERE, or in a fresh sub-branch
  worktree off feat/mcp-integration (`.claude/tools/new-worktree.ps1 -Name mcp-t1-1 -Base feat/mcp-integration`).
- **NEVER work in the Z:\Canvas ADE main dir.** It is integration-only and a parallel session uses it; a
  shared-dir collision hit this project TWICE on 2026-06-03 (another session switched the dir to main
  mid-task). Another session is ALSO running in worktree `canvas-ade-context` on `feat/context-d2-panel`
  building the sibling Brain/Memory subsystem — do not touch their files.
- **DO NOT merge anything to main yet.** Finish the MCP phases on branches first (user's decision —
  main is busy). Keep #32 + pkg PR #1 open. Push branches; never merge to main without the user.
- The package repo (Z:\canvas-ade-mcp) is a SEPARATE git repo — its own branches/PRs.

# STATE OF PLAY (2026-06-03)
M0 (Foundation) is DONE:
  - T0.1 (land #32): #32 is MERGEABLE; CI `check` passes (the GitHub Packages read-access grant works).
    HELD open on purpose (not merging to main yet).
  - T0.2 (Host-header allowlist + ADR): shipped in the PACKAGE as PR #1 (branch feat/host-header-guard,
    commit c6e1b33, version 0.2.0 -> 0.2.1). HELD — not merged/published yet. App-side follow-up
    (a forged-Host probe in mcpSmoke) waits until 0.2.1 is published + consumed.
  - T0.3 (MAIN->renderer command channel): on feat/mcp-integration. `mcp:command` ping round-trip,
    src/main/mcpCommand.ts + preload mcp.onCommand + src/renderer/src/store/useMcpCommands.ts,
    MCP_COMMAND_OK smoke probe.
Branch tips: feat/mcp-integration @ 2651a0d (on main 2d07fbb). Package feat/host-header-guard @ c6e1b33.

# WHAT EXISTS (orient before coding)
- MCP server is a LIBRARY hosted IN Electron MAIN over loopback (127.0.0.1). NO separate backend.
- Orchestrator adapter: src/main/mcpOrchestrator.ts (mirror-backed; spawn/dispatch/gitDiff throw phase-gated).
- Board mirror (renderer -> MAIN, metadata only id/type/title): src/main/boardRegistry.ts +
  src/renderer/src/store/useMcpPublish.ts. `deriveStatus` already maps coarse status from the PTY map.
- Command channel (MAIN -> renderer): src/main/mcpCommand.ts + src/renderer/src/store/useMcpCommands.ts.
- Live smoke: src/main/mcpSmoke.ts (CANVAS_SMOKE=mcp) — extend it with one probe per new capability.

# NEXT: Milestone M1 — Observation (give agents eyes). Start with T1.1.
  T1.1 — status buckets in the board mirror. APP: enrich the renderer->MAIN snapshot so each board
         carries a real status bucket (idle/running/awaiting-review/blocked/failed/static) derived from
         terminalRuntimeStore + previewStore (not just presence). PACKAGE: a canvas://board/{id}/status
         resource that reads it. Then T1.2 board-states roll-up, T1.3 attention, T1.4 output (capped),
         T1.5 result, T1.6 on-canvas status pill, T1.7 expose the sibling Brain/Memory via
         canvas://memory + canvas://board/{id}/summary (graceful-empty if the brain subsystem is absent).
  Full cards (build / e2e / manual / gate / handoff) are in docs/roadmap-mcp.md § M1.

# CADENCE — MANDATORY for EVERY task (the user's standing rule)
  - One sub-branch per task off feat/mcp-integration -> squash-merge back into the umbrella.
  - Each task spans BOTH repos: package tool/resource + contract test (Z:\canvas-ade-mcp), AND the app
    adapter/IPC/UI (Z:\Canvas ADE).
  - e2e: add a probe to src/main/mcpSmoke.ts asserting the canvas/resource ACTUALLY changed (MCP_*_OK).
  - manual: (1) MCP Inspector (`pnpm exec @modelcontextprotocol/inspector` in the package) against the
    live loopback server; (2) a real CLI agent in a Terminal board via a generated .mcp.json.
  - Gate before handoff (BOTH must pass): contract test + live test. App gate:
    pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build ; then
    pnpm build && CANVAS_SMOKE=mcp pnpm start  (expect MCP_LIST_OK/TIER_OK/BOARDS_OK/COMMAND_OK + new probe, exit 0).
  - Write a handoff doc AFTER each task: docs/superpowers/handoffs/<date>-mcp-<task>.md on feat/mcp-integration.

# GOTCHAS / RULES
  - The Bash tool is POSIX bash, NOT PowerShell. Use pwsh for Windows-only ops (junctions). Repo path
    HAS A SPACE ("Z:\Canvas ADE").
  - GitHub Packages: before `pnpm install`, `export NODE_AUTH_TOKEN="$(gh auth token)"` (the @ch923dev
    scope in .npmrc needs it). The token has read:packages.
  - node-pty is pinned winpty-free (1.2.0-beta.13) — do NOT touch / downgrade.
  - Commit with a heredoc (`git commit -F -`), never `-m` with backticks (the Bash tool runs them as
    shell substitution -> mangled message).
  - Board e2e (CANVAS_SMOKE=e2e) is FROZEN in CI (#35, `if: false` on the smoke job) but still RUN IT
    LOCALLY. The preview-edge-stale / duplicate-keeps-link probes are a KNOWN React-Flow measurement-race
    flake (memory e2e-rf-measurement-race) — rerun for a clean pass; not a regression.
  - SECURITY (never weaken): contextIsolation/sandbox/no-nodeIntegration; Browser-board content NEVER
    reaches the PTY; loopback-only; capability tiers enforced SERVER-SIDE by token (never prompt/annotation).
    Frame-guarded IPC must tolerate a destroyed WebContents (see the 286820d teardown fix). The package
    now has a Host-header allowlist (pkg PR #1) — keep it.
  - Sibling Brain/Memory is a SEPARATE track (feat/context-d2-panel). MCP connects ONE-WAY only:
    canvas://memory (T1.7) + optional best-of-N judging via the brain (T9.4). Do NOT build the brain here.

# START BY
  cd into Z:\canvas-ade-mcp-int (the worktree), read docs/roadmap-mcp.md § M1, declare your zones on
  Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md, then implement T1.1 test-first. Do not write code
  until you have re-read the T1.1 card and confirmed the current board-mirror/adapter shape.
```

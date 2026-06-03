# Next-session prompt — finish M1 (T1.4–T1.7), parallelized

Copy everything in the fenced block into the next session.

```
You are continuing the Canvas ADE × MCP integration roadmap (Milestone M1 — Observation).
Goal this session: finish M1 by completing T1.4, T1.5, T1.6, T1.7, parallelized where safe.

# REPOS / RUNTIME
- APP:     Z:\Canvas ADE                (Electron + TS + React desktop app). Integration-only — NEVER work here.
- WORKTREE for the MCP umbrella: Z:\canvas-ade-mcp-int  (branch feat/mcp-integration, PR #32). WORK HERE.
- PACKAGE: Z:\canvas-ade-mcp            (the MCP server LIBRARY @ch923dev/canvas-ade-mcp; its own git repo, branch main = v0.2.4).
- Two repos, ONE runtime: the package is a library hosted IN Electron MAIN over loopback (127.0.0.1). No separate backend.

# READ FIRST (in order)
1. Z:\Canvas ADE\CLAUDE.md                                   (durable contract — stack, security, conventions)
2. docs/roadmap-mcp.md  § M1                                 (the task cards T1.4–T1.7)
3. docs/roadmap-mcp-packaging.md                             (DEV LOOP = pnpm link, NOT publish; release/serving model)
4. docs/superpowers/handoffs/2026-06-03-mcp-t1-4-output-kickoff.md   (T1.4 is pre-scoped — the 256KB pty.ts ring already exists)
5. docs/superpowers/handoffs/2026-06-03-mcp-t1-1-status-buckets.md / -t1-2-board-states.md / -t1-3-attention.md  (the pattern T1.5/T1.7 follow)
6. Memories: mcp-publish-gating, mcp-spec-state-2026-06, parallel-agent-worktrees, e2e-* (recalled automatically).

# STATE OF PLAY (2026-06-03)
- M0 DONE. M1: T1.1 (status buckets), T1.2 (board-states), T1.3 (attention) DONE + squash-merged to feat/mcp-integration.
- PUBLISHED: pkg main = v0.2.4 (the M0/M1 chain in one tag). App consumes ^0.2.4; all M1 probes live-green
  (CANVAS_SMOKE=mcp → MCP_LIST/TIER/BOARDS/STATUS/STATES/ATTENTION/COMMAND_OK, exit 0).
- DEV LOOP IS pnpm link (no publish to iterate): node_modules/@ch923dev/canvas-ade-mcp is a SYMLINK → the sibling.
  Edit pkg → `pnpm mcp:build` → app runs it. After any `pnpm install`, re-run `pnpm mcp:link`. NEVER commit a
  `link:` entry in package.json/pnpm-lock.yaml (CI has no sibling) — `git checkout pnpm-lock.yaml` after linking.
- ⚠️ The worktree's node_modules is its OWN (de-junctioned from main) — normal pnpm works; do NOT re-junction.

# THE 4 TASKS (full cards in docs/roadmap-mcp.md § M1)
- T1.4 🔒 canvas://board/{id}/output — capped/paginated PTY scrollback (25k cap). pty.ts already has a 256KB ring
       (RING_CAP_BYTES/appendRing/buf.data); expose a READ-ONLY paged/capped slice. SEE THE T1.4 KICKOFF BRIEF —
       it has the security checklist + open decisions (recommended: strip ANSI · tail-anchored cursor · 25k pages).
- T1.5 canvas://board/{id}/result — structured last-result (references, not raw logs). v1 returns an empty/structured
       shell until M4 write_result feeds it; app exposes a last-result accessor + Orchestrator.boardResult.
- T1.6 on-canvas status pill — RENDERER ONLY. The board-chrome status indicator must reflect the SAME bucket the MCP
       sees (boardStatus.ts boardStatusBucket — one source of truth). No pkg, no Orchestrator, no adapter, no mcpSmoke.
- T1.7 canvas://memory + canvas://board/{id}/summary — read-only resources exposing the sibling Brain/Memory engine's
       .canvas/memory/ (project index + per-board summary). GRACEFUL-EMPTY if the memory subsystem is absent (it lives
       on the parallel feat/context track — do NOT build the brain here; coordinate the .canvas/memory/ shape with that
       session). 🔒 memory is passive context — exposes no action.

# PARALLELIZATION — IMPORTANT (they are NOT all cleanly parallel)
SHARED FILES that T1.4 + T1.5 + T1.7 all touch (would merge-conflict if done blindly in parallel):
  pkg:  src/orchestrator/Orchestrator.ts (interface), src/orchestrator/mock.ts, src/resources/boards.ts (registration),
        package.json (version bump)
  app:  src/main/mcpOrchestrator.ts (adapter), src/main/index.ts (BoardRegistry seam), src/main/mcpSmoke.ts (probe)
T1.6 shares NONE of these (renderer-only) → it is the only truly independent lane.

RECOMMENDED PLAN (scaffold-first, then fan out):
  PHASE 0 (one short commit on a base sub-branch off feat/mcp-integration, ~30 min): land the SHARED SCAFFOLD so the
    parallel lanes don't collide on the interface/adapter:
      - pkg Orchestrator.ts: add boardOutput / boardResult / projectMemory / boardSummary method signatures.
      - pkg MockOrchestrator: add stub impls (empty/throw 'not impl yet').
      - app mcpOrchestrator.ts adapter + index.ts BoardRegistry: add the read seams (readOutput/readResult/readMemory),
        wired to stubs that each task then fills.
      - bump pkg version ONCE for the scaffold (e.g. 0.2.5). `pnpm mcp:build` so the linked app sees the new interface.
    Squash-merge PHASE 0 to feat/mcp-integration, re-gate.
  PHASE 1 (parallel, use .claude/tools/new-worktree.ps1 -Base feat/mcp-integration, one sub-branch per task):
      - Lane A: T1.6 (renderer pill)  — fully independent, ship anytime.
      - Lane B: T1.4 (output)         — fills src/resources/output.ts + pty.ts accessor + its mcpSmoke probe.
      - Lane C: T1.5 (result)         — fills src/resources/result.ts + result accessor + its probe.
      - Lane D: T1.7 (memory)         — fills src/resources/memory.ts + .canvas/memory reader + its probe.
    After the scaffold, the only still-shared files are boards.ts registration (1 line each), package.json version,
    and mcpSmoke.ts (append-only probe blocks) → SEQUENCE those squash-merges into feat/mcp-integration and re-run the
    full gate + CANVAS_SMOKE=mcp after EACH merge (board components interact even when files look disjoint).
  If you'd rather not do PHASE 0: run T1.6 in parallel and T1.4 → T1.5 → T1.7 SEQUENTIALLY (they share too much for a
    clean blind parallel). Use the brainstorming + dispatching-parallel-agents skills to decide.

# CADENCE — MANDATORY per task (standing rule)
- One sub-branch per task off feat/mcp-integration → squash-merge back into the umbrella when green.
- Each pkg-touching task: pkg resource/tool + Zod/contract test + LIVE test (Z:\canvas-ade-mcp), AND the app
  adapter/accessor/UI. Bump pkg version; `pnpm mcp:build` so the linked app picks it up (no publish needed mid-dev).
- e2e: add ONE probe to src/main/mcpSmoke.ts per new capability, asserting the canvas/resource ACTUALLY changed
  (MCP_*_OK). New resources that aren't built into the linked sibling yet → SELF-ACTIVATING skip pattern (catch
  McpError -32602 / /resource .*not found/i → MCP_*_SKIP, exit 0). T1.6 uses the board-chrome e2e probe, not mcpSmoke.
- manual: (1) MCP Inspector (`cd Z:\canvas-ade-mcp; pnpm exec @modelcontextprotocol/inspector`) against the live
  loopback; (2) a real CLI agent in a Terminal board via a generated .mcp.json.
- Gate before handoff (BOTH must pass):
    app:  pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build ;
          then pnpm build && CANVAS_SMOKE=mcp pnpm start   (expect every MCP_*_OK, exit 0)
    pkg:  pnpm typecheck && pnpm lint && pnpm test && pnpm test:live && pnpm build
    Also run the board e2e LOCALLY: pnpm build; CANVAS_SMOKE=e2e pnpm start  (FROZEN in CI, but run it here; the
    preview-edge-stale / duplicate-keeps-link / whiteboard-fullview-add probes are known RF measurement-race flakes —
    rerun for a clean pass, not a regression).
- Write a handoff doc AFTER each task: docs/superpowers/handoffs/<date>-mcp-<task-id>.md on feat/mcp-integration.
- Declare each sub-branch's zones on Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md BEFORE editing. Another session
  runs on feat/context (Brain/Memory) — disjoint, but T1.7 reads its .canvas/memory/ shape, so coordinate there.

# RELEASE / PUBLISH (only when the user says so — do NOT publish autonomously)
- Publish = release path, not dev. FF-merge the held pkg branch chain into pkg main, then `git tag vX.Y.Z &&
  git push origin vX.Y.Z` → .github/workflows/publish.yml publishes to GitHub Packages (repo's own GITHUB_TOKEN).
- After publish: bump the app's ^0.2.x floor + regen lockfile (the worktree has its own node_modules now).
- The app's RELEASE build bundles the library into MAIN (electron-vite) — end users need no registry.

# SECURITY (never weaken)
- contextIsolation/sandbox/no-nodeIntegration; Browser-board content NEVER reaches the PTY; loopback-only; capability
  tiers enforced SERVER-SIDE by token (never prompt/annotation); the package's Host-header + Origin guards stay.
- T1.4 🔒: never dump the raw unbounded buffer — cap every read; honest truncation (report dropped/nextCursor, never
  blind-truncate); read-only; no new renderer IPC; decide ANSI stripping. T1.7 🔒: memory is passive context only.

# DO NOT
- Do NOT merge anything to APP main (Z:\Canvas ADE main) — finish M1 on feat/mcp-integration first (user's decision).
- Do NOT work in the Z:\Canvas ADE main dir (a parallel session uses it; shared-dir collision hit this project twice).
- Do NOT re-junction the worktree node_modules. Do NOT commit a link: lockfile entry. Do NOT build the Brain (T1.7
  only READS its .canvas/memory/, graceful-empty if absent).

# START BY
cd Z:\canvas-ade-mcp-int ; confirm `pnpm mcp:link` is active (node_modules/@ch923dev/canvas-ade-mcp is a symlink) ;
re-read docs/roadmap-mcp.md § M1 + the T1.4 kickoff brief ; decide PHASE 0 scaffold vs sequential ; declare zones on
ACTIVE-WORK.md ; then implement test-first. M1 is done when an agent can enumerate + read live board state, large
output is capped (not blind), the on-canvas pill agrees with canvas://board-states, and canvas://memory serves (or
gracefully empties).
```

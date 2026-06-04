# Next-session prompt — finish M1 (T1.4 → T1.5 → T1.6 → T1.7, SEQUENTIAL)

Copy everything in the fenced block into the next session. (Decided: do these sequentially, one task fully
done + squash-merged + handed off before the next — T1.4/T1.5/T1.7 share the Orchestrator interface +
adapter + mcpSmoke + pkg version, so blind parallel would merge-conflict.)

```
You are continuing the Canvas ADE × MCP integration roadmap (Milestone M1 — Observation).
Goal this session: finish M1 by completing T1.4, then T1.5, then T1.6, then T1.7 — SEQUENTIALLY (one task
fully green + squash-merged + handed off before starting the next). Do NOT parallelize.

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
  Confirm the link is active first: node_modules/@ch923dev/canvas-ade-mcp should be a symlink → /z/canvas-ade-mcp.
- ⚠️ The worktree's node_modules is its OWN (de-junctioned from main) — normal pnpm works; do NOT re-junction.

# THE 4 TASKS, IN ORDER (full cards in docs/roadmap-mcp.md § M1)
T1.4 🔒 canvas://board/{id}/output — capped/paginated PTY scrollback. pty.ts already has a 256KB ring
     (RING_CAP_BYTES/appendRing/buf.data at src/main/pty.ts); expose a READ-ONLY paged/capped slice — NOT a new buffer.
     READ THE T1.4 KICKOFF BRIEF (file #4) — it has the security checklist + the open decisions. Recommended defaults
     to adopt (note them in the handoff): strip ANSI to plain text · tail-anchored cursor (bytes-from-end) · 25k cap
     per page · exited/parked boards stay readable. Suggested shape:
       - app: pure src/main/ptyOutput.ts (stripAnsi + pageOutput(clean,{cursor,limit,truncatedHead}) → {text,total,
         returned,nextCursor,droppedOlder}) + a readPtyOutput(id,{cursor}) accessor in pty.ts that reads sessions/parked
         buf.data and delegates. Orchestrator.boardOutput(id,cursor?) in the adapter + an index.ts BoardRegistry seam.
       - pkg: src/resources/output.ts — canvas://board/{id}/output (templated; pass the cursor via a URI query var
         {?cursor} if the SDK UriTemplate supports it, else a path segment, else tail-only v1). HARD-cap each page at
         25k; surface nextCursor + droppedOlder (never blind-truncate).
     🔒 never dump the raw unbounded buffer; read-only; no new renderer IPC; ANSI stripped (control-seq injection surface).
T1.5 canvas://board/{id}/result — structured last-result (references, not raw logs). v1 returns an empty/structured
     shell until M4 write_result feeds it; app exposes a last-result accessor + Orchestrator.boardResult.
T1.6 on-canvas status pill — RENDERER ONLY. The board-chrome status indicator must reflect the SAME bucket the MCP
     sees (src/renderer/src/store/boardStatus.ts boardStatusBucket — one source of truth). No pkg, no Orchestrator,
     no adapter, no mcpSmoke probe — use the board-chrome e2e probe in src/main/e2e/probes instead.
T1.7 canvas://memory + canvas://board/{id}/summary — read-only resources exposing the sibling Brain/Memory engine's
     .canvas/memory/ (project index + per-board summary). GRACEFUL-EMPTY if the memory subsystem is absent (it lives
     on the parallel feat/context track — do NOT build the brain here; coordinate the .canvas/memory/ shape with that
     session). 🔒 memory is passive context — exposes no action.

# CADENCE — MANDATORY per task (standing rule)
- One sub-branch per task off feat/mcp-integration → squash-merge back into the umbrella when green → THEN next task.
  pkg sub-branch per pkg-touching task off pkg main, stacked; bump pkg version each.
- Each pkg-touching task: pkg resource + Zod/contract test + LIVE test (Z:\canvas-ade-mcp), AND the app
  adapter/accessor/UI. After editing the pkg: `pnpm mcp:build` so the linked app runs it (no publish needed mid-dev).
- TDD: write the failing test first, watch it fail, then implement (the using-superpowers + TDD skills apply).
- e2e: add ONE probe to src/main/mcpSmoke.ts per new capability (MCP_*_OK), asserting the resource ACTUALLY changed.
  Because the dev link points at the sibling working tree, once you `pnpm mcp:build` the new resource EXISTS — assert
  it directly (no self-activating skip needed mid-dev; the skip pattern was only for the published-but-not-consumed gap).
  T1.6 uses the board-chrome e2e probe, not mcpSmoke. T1.4 reachable signal: run a terminal command emitting > 25k bytes.
- manual: (1) MCP Inspector (`cd Z:\canvas-ade-mcp; pnpm exec @modelcontextprotocol/inspector`) against the live
  loopback; (2) a real CLI agent in a Terminal board via a generated .mcp.json.
- Gate before each handoff (BOTH must pass):
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
  Ask the user before publishing. After publish: bump the app's ^0.2.x floor + regen lockfile.
- The app's RELEASE build bundles the library into MAIN (electron-vite) — end users need no registry.

# SECURITY (never weaken)
- contextIsolation/sandbox/no-nodeIntegration; Browser-board content NEVER reaches the PTY; loopback-only; capability
  tiers enforced SERVER-SIDE by token (never prompt/annotation); the package's Host-header + Origin guards stay.
- T1.4 🔒: never dump the raw unbounded buffer — cap every read; honest truncation (report dropped/nextCursor, never
  blind-truncate); read-only; no new renderer IPC; ANSI stripped. T1.7 🔒: memory is passive context only.

# DO NOT
- Do NOT merge anything to APP main (Z:\Canvas ADE main) — finish M1 on feat/mcp-integration first (user's decision).
- Do NOT work in the Z:\Canvas ADE main dir (a parallel session uses it; shared-dir collision hit this project twice).
- Do NOT re-junction the worktree node_modules. Do NOT commit a link: lockfile entry. Do NOT build the Brain (T1.7
  only READS its .canvas/memory/, graceful-empty if absent). Do NOT parallelize — one task at a time.

# START BY
cd Z:\canvas-ade-mcp-int ; confirm `pnpm mcp:link` is active (node_modules/@ch923dev/canvas-ade-mcp is a symlink) ;
read docs/roadmap-mcp.md § M1 + the T1.4 kickoff brief ; confirm the current pty.ts ring shape ; declare T1.4 zones on
ACTIVE-WORK.md ; then build T1.4 test-first. Finish + squash-merge + handoff T1.4 before starting T1.5. M1 is done when
an agent can enumerate + read live board state, large output is capped (not blind), the on-canvas pill agrees with
canvas://board-states, and canvas://memory serves (or gracefully empties).
```

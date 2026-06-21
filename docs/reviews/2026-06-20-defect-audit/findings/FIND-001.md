# FIND-001 — Bearer token persists on disk after consent revoke for terminal boards whose cwd differs from the project root (project-scoped claude/opencode configs)

| | |
|---|---|
| **Severity** | High |
| **Category** | security · secrets |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/main/index.ts:631` |
| **Discovery slice** | M-MCP-ORCH (run 2) |

## Summary
The spawn-time provisioner writes a CLI's MCP config (with the live connected-tier BEARER TOKEN inline) into the BOARD'S cwd for project-scoped CLIs: makeOrchestrationSyncProvider uses `targetDir = cwd && cwd.trim() !== '' ? cwd : projectDir` (cliProvisioners/index.ts:201-202), so claude's `<cwd>/.mcp.json` and opencode's `<cwd>/opencode.json` land wherever the terminal's cwd points (a subfolder, or any existing dir). But the consent-revoke cleanup only unsyncs the PROJECT ROOT: `unsyncProvisioners({ projectDir: projectPath })` and removeSync joins projectDir, never the per-board cwd. Result: after a user disables orchestration, the plaintext bearer token persists on disk in every divergent-cwd `.mcp.json`/`opencode.json`, defeating the PLAN §6 'unsync on disable' guarantee. The token also remains valid (never revoked in MAIN, see separate finding), so a stale on-disk credential keeps working until app restart.

## Trigger
Enable orchestration; open a terminal board whose cwd is a subdirectory of (or different from) the project root and launch `claude`/an opencode CLI → `<cwd>/.mcp.json` is written with the bearer. Later set orchestration to 'declined' → onChange calls unsyncProvisioners(projectDir) which removes only `<projectRoot>/.mcp.json`; the `<cwd>/.mcp.json` containing the token stays on disk.

## Evidence / concrete faulty path (code-grounded)
Write path: pty.ts:486-490 orchestrationSyncProvider?.({id, launchCommand, cwd: spawnCwd}); pty.ts:402 const spawnCwd = safeCwd(opts.cwd); ptyShells.ts:69-76 safeCwd returns any existing dir else os.homedir(); UI source NewTerminalDialog.tsx:85 const [cwd,setCwd]=useState(board.cwd??'') and useTerminalSpawn.ts:99 cwd: board.cwd ?? projectDir ?? undefined. Divergence: cliProvisioners/index.ts:201 const targetDir = cwd && cwd.trim() !== '' ? cwd : projectDir; index.ts:202 PROVISIONERS[cliId].writeSync(targetDir, deps.mintToken(id)); claude.ts:30-41 writes join(projectDir,'.mcp.json'); opencode.ts:33-52 writes join(projectDir,'opencode.json'); inline token shared.ts:123-129 mcpEntry headers Authorization Bearer, opencode.ts:38-45. Revoke (root-only): orchestrationConsent.ts:138 const dir=getCurrentDir(); :142 onChange(dir, decision==='enabled'); index.ts:631 if(!on) void unsyncProvisioners({projectDir: projectPath}); cliProvisioners/index.ts:167 PROVISIONERS[id].removeSync(opts.projectDir). Only one unsyncProvisioners call site in shipped code (Grep: index.ts:631). Intended divergence test: index.test.ts:144 'writes the matching CLI config to the board cwd'. Repro: enable orchestration; set a terminal board's cwd to a subfolder; launch claude → <cwd>/.mcp.json gets Bearer token; set orchestration to 'declined' → only <projectRoot>/.mcp.json is removed; <cwd>/.mcp.json with the live bearer stays on disk.

## Verifier reasoning (why CONFIRMED; scope & severity)
Verified end-to-end against shipped (non-test) code. WRITE side: pty.ts:486-490 calls the spawn provider on every terminal start with cwd: spawnCwd; spawnCwd = safeCwd(opts.cwd) (pty.ts:402, ptyShells.ts:69-76) accepts ANY existing directory and falls back to os.homedir() (not project root) if invalid. The board cwd is a user-editable text input (NewTerminalDialog.tsx:85,270) resolved as board.cwd ?? projectDir (useTerminalSpawn.ts:99), so it is reachable in the real app — not test-only. In makeOrchestrationSyncProvider (cliProvisioners/index.ts:201-202), targetDir = cwd && cwd.trim() !== '' ? cwd : projectDir, then PROVISIONERS[cliId].writeSync(targetDir, token). For claude (claude.ts:36-41) and opencode (opencode.ts:47-52) the path is join(projectDir, '.mcp.json' / 'opencode.json'), so the token-bearing config lands in <cwd>. The token is inline plaintext: mcpEntry → headers:{Authorization:'Bearer <token>'} (shared.ts:123-129) and the opencode equivalent (opencode.ts:38-45). REVOKE side: orchestration:setConsent('declined') fires onChange(getCurrentDir(), false) (orchestrationConsent.ts:138-142) = project ROOT, which calls the SOLE shipped unsyncProvisioners call (index.ts:631) with projectDir:projectPath; unsyncProvisioners only does removeSync(opts.projectDir) (index.ts:167) = project root. No per-board-cwd set is tracked for cleanup anywhere (the only unsync call site is index.ts:631; no board-delete/project-switch/quit cleanup invokes it with a board cwd). Net: after a user disables orchestration, the plaintext bearer persists on disk in every divergent-cwd .mcp.json/opencode.json, defeating PLAN §6's documented 'unsync on disable' guarantee. Refutation attempts failed: no guard exists, the path is reachable via the editable cwd UI (not just index.test.ts:144 which merely confirms the intended divergence), and codex/gemini being home-scoped (shared.ts) correctly limits the bug to the two project-scoped CLIs exactly as claimed. Rated High not Critical: single-user desktop, data sits in a directory the user already owns, requires a non-default board cwd, and the token rotates each app restart (bounded window) — but it is a clear security weakening that defeats a stated guarantee, leaving a live credential on disk until restart.

## Fix direction (audit only — NOT applied)
On consent revoke, unsync EVERY directory a board was provisioned into — not just the project root. Record each provisioned target dir at writeSync time (or reuse pty.ts boardCwds) and call removeSync for each on revoke; alternatively scope spawn-time project-config writes to one known location. Consider rotating/invalidating the live token on revoke so the on-disk bearer is dead immediately, not only after the next app restart.

## Files this card touches
- `src/main/index.ts (revoke wiring ~631)`
- `src/main/cliProvisioners/index.ts (unsyncProvisioners; targetDir ~201)`
- `src/main/cliProvisioners/claude.ts · opencode.ts (writeSync/removeSync)`
- `src/main/orchestrationConsent.ts`

## Collision flags (sequence with)
- index.ts → FIND-003
- cliProvisioners/ → FIND-008
- token-lifecycle theme → FIND-015 (in-memory token never revoked)
- pty.ts boardCwds (reuse for cleanup) → FIND-009
